// Measures the latency TokenSip adds on top of a provider. The mock provider,
// the gateway and this load generator run in separate processes, like in production.
//   npm run build && npm run bench
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 3000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 32);
const root = fileURLToPath(new URL("..", import.meta.url));
const body = readFileSync(join(root, "examples/requests/agent-openai.json"), "utf8");

function start(cmd, args, env, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = ready(out);
      if (m) resolve({ child, value: m });
    });
    child.on("exit", (code) => reject(new Error(`${args[0]} exited with ${code}`)));
  });
}

const upstream = await start("node", [join(root, "scripts/bench-upstream.mjs")], {}, (o) => o.match(/^(\d+)\n/)?.[1]);
const upstreamUrl = `http://127.0.0.1:${upstream.value}`;
const dataDir = mkdtempSync(join(tmpdir(), "tokensip-bench-"));
const cli = join(root, "packages/server/dist/cli.js");
const env = { TOKENSIP_DATA_DIR: dataDir, TOKENSIP_LOG_LEVEL: "error" };
const keyOut = await start("node", [cli, "keys", "create", "--name", "bench"], env, (o) => o.match(/tsk_[\w-]+/)?.[0]);
const key = keyOut.value;
const gateway = await start(
  "node",
  [cli, "start", "--port", "0"],
  {
    ...env,
    NO_COLOR: "1",
    TOKENSIP_ADMIN_PASSWORD: "benchmark-password",
    TOKENSIP_CUSTOM_BASE_URL: `${upstreamUrl}/v1`,
    TOKENSIP_CUSTOM_API_KEY: "k",
  },
  (o) => o.match(/Gateway\s+(http:\/\/\S+)/)?.[1],
);
const via = `${gateway.value}/v1/chat/completions`;

async function run(label, url, headers) {
  const latencies = [];
  let next = 0;
  const started = performance.now();
  const worker = async () => {
    while (next < REQUESTS) {
      next++;
      const t = performance.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
      await res.arrayBuffer();
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
      latencies.push(performance.now() - t);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  return { label, rps: REQUESTS / secs, p50: pct(50), p95: pct(95), p99: pct(99) };
}

const auth = { authorization: `Bearer ${key}`, "x-tokensip-cache": "bypass" };
process.on("exit", () => {
  gateway.child.kill();
  upstream.child.kill();
});
await run("warmup", via, auth);
const rows = [await run("direct to provider", `${upstreamUrl}/v1/chat/completions`, {})];
for (const profile of ["off", "safe", "balanced", "aggressive", "extreme"]) {
  rows.push(await run(`via TokenSip (${profile})`, via, { ...auth, "x-tokensip-profile": profile }));
}

const base = rows[0];
console.log(
  `\n${REQUESTS} requests per row · concurrency ${CONCURRENCY} · ${(body.length / 1024).toFixed(0)} KB agent request (~14k tokens) · Node ${process.versions.node}\n`,
);
console.log("| Path | req/s | p50 | p95 | p99 | added p50 |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const r of rows) {
  const added = r === base ? "—" : `+${(r.p50 - base.p50).toFixed(2)} ms`;
  console.log(
    `| ${r.label} | ${r.rps.toFixed(0)} | ${r.p50.toFixed(2)} ms | ${r.p95.toFixed(2)} ms | ${r.p99.toFixed(2)} ms | ${added} |`,
  );
}

for (const c of [gateway.child, upstream.child]) {
  c.removeAllListeners("exit");
  c.kill("SIGTERM");
}
rmSync(dataDir, { recursive: true, force: true });
