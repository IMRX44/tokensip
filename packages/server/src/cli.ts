#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { optimize, PROFILE_INFO, type ProfileId, type Protocol, VERSION } from "@tokensip/core";
import type { TokenSipConfig } from "./config.js";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c("1");
const dim = c("2");
const green = c("32");
const cyan = c("36");
const yellow = c("33");
const red = c("31");
const mint = c("38;5;48");

const HELP = `
${bold("tokensip")} ${dim(`v${VERSION}`)} — the token-saving AI gateway

${bold("Usage")}
  tokensip [start] [options]          Start the gateway and dashboard
  tokensip optimize <file.json>       Optimize a request body offline and print the report
  tokensip keys create --name <name>  Create a virtual API key
  tokensip keys list                  List virtual API keys
  tokensip reset-password             Generate a new admin password (and disable 2FA)
  tokensip demo                       Try the dashboard with synthetic traffic (no keys needed)
  tokensip simulate                   Replay synthetic agent sessions against a billed prompt-cache model
  tokensip doctor                     Check your environment
  tokensip version

${bold("Options")}
  -p, --port <port>          Port (default 8787, env TOKENSIP_PORT)
  -H, --host <host>          Bind address (default 127.0.0.1; 0.0.0.0 in server mode)
  -d, --data-dir <dir>       Data directory (default ~/.tokensip, env TOKENSIP_DATA_DIR)
  -m, --mode <local|server>  Server mode hardens defaults (no key passthrough, HSTS)
      --profile <profile>    off | safe | balanced | aggressive | extreme
      --protocol <protocol>  For 'optimize': openai-chat | openai-responses | anthropic | gemini
      --no-dashboard         Disable the web dashboard
      --sessions <n>         For 'simulate': conversations to replay (default 12)
      --turns <n>            For 'simulate': turns per conversation (default 60)
      --clock                For 'simulate': put a clock in the system prompt (a common cache leak)
      --no-breaks            For 'simulate': no coffee breaks longer than the 5-minute cache TTL
  -h, --help

${bold("Docs")} https://github.com/IMRX44/tokensip
`;

const LOGO = `
   ${mint("╭─╮")}  ${bold("TokenSip")}
   ${mint("│◉│")}  ${dim("sip tokens, not budgets")}
   ${mint("╰┬╯")}
`;

function parse() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      "data-dir": { type: "string", short: "d" },
      mode: { type: "string", short: "m" },
      profile: { type: "string" },
      protocol: { type: "string" },
      name: { type: "string" },
      budget: { type: "string" },
      rpm: { type: "string" },
      password: { type: "string" },
      sessions: { type: "string" },
      turns: { type: "string" },
      seed: { type: "string" },
      clock: { type: "boolean" },
      "no-breaks": { type: "boolean" },
      "no-dashboard": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  return { values, positionals };
}

type Values = ReturnType<typeof parse>["values"];

function configFrom(values: Values): Partial<TokenSipConfig> {
  // The CLI prints its own banner; keep server logs to warnings unless asked otherwise.
  const out: Partial<TokenSipConfig> = process.env.TOKENSIP_LOG_LEVEL ? {} : { logLevel: "warn" };
  if (values.port) out.port = Number(values.port);
  if (values.host) out.host = values.host;
  if (values["data-dir"]) out.dataDir = values["data-dir"];
  if (values.mode === "server" || values.mode === "local") out.mode = values.mode;
  if (values.profile) out.defaultProfile = values.profile as ProfileId;
  if (values["no-dashboard"]) out.dashboard = false;
  return out;
}

async function start(values: Values) {
  const { createTokenSipServer } = await import("./server.js");
  const overrides = configFrom(values);
  if (values.mode === "server" && !values.host && !process.env.TOKENSIP_HOST) overrides.host = "0.0.0.0";
  const server = await createTokenSipServer({ config: overrides });
  const { app, config } = server;
  if (values.profile && values.profile !== app.settings.profile)
    app.updateSettings({ profile: values.profile as ProfileId });

  let base: string;
  try {
    base = await server.listen();
  } catch (err) {
    console.error(red(`\n✖ Could not start: ${(err as Error).message}\n`));
    process.exit(1);
  }

  const profile = app.settings.profile;
  const info = PROFILE_INFO[profile];
  const lines = [
    LOGO,
    `  ${green("●")} Gateway     ${bold(base)}   ${dim(`(${config.mode} mode)`)}`,
    config.dashboard ? `  ${green("●")} Dashboard   ${bold(`${base}/`)}` : "",
    `  ${green("●")} Profile     ${bold(profile)} ${dim(`— prompt sent ≈ ${info.typicalPromptRatio}`)}`,
    `  ${green("●")} Passthrough ${config.allowPassthrough ? "on  (clients may use their own provider keys)" : "off (TokenSip keys required)"}`,
    "",
    `  ${bold("Point your SDK at:")}`,
    `    OpenAI-compatible   ${cyan(`${base}/v1`)}            ${dim("auto-routes by model name")}`,
    `    OpenAI              ${cyan(`${base}/openai/v1`)}`,
    `    Anthropic           ${cyan(`${base}/anthropic`)}`,
    `    Google Gemini       ${cyan(`${base}/google`)}          ${dim(`(OpenAI format: ${base}/google/v1)`)}`,
    `    DeepSeek · Groq · Mistral · xAI · OpenRouter …   ${cyan(`${base}/<provider>/v1`)}`,
    "",
  ];
  if (app.setupToken) {
    lines.push(
      `  ${yellow("▲ First run:")} open ${bold(`${base}/setup?token=${app.setupToken}`)}`,
      `    ${dim("to create the admin password. The token is valid until setup completes.")}`,
      "",
    );
  }
  if (info.warning) lines.push(`  ${red(`▲ ${profile.toUpperCase()} PROFILE:`)} ${info.warning}`, "");
  if (app.vaultSource === "generated") {
    lines.push(
      `  ${dim(`Generated a new master key in ${config.dataDir}/master.key — back it up, or set TOKENSIP_SECRET.`)}`,
      "",
    );
  }
  if (config.mode === "local" && config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    lines.push(
      `  ${yellow("▲")} Local mode is listening on ${config.host}. Use --mode server when exposing TokenSip to a network.`,
      "",
    );
  }
  console.log(lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n"));

  const shutdown = async (signal: string) => {
    console.log(dim(`\n${signal} received — shutting down…`));
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function withApp<T>(values: Values, fn: (app: import("./app.js").TokenSipApp) => T | Promise<T>): Promise<T> {
  const { loadConfig } = await import("./config.js");
  const { TokenSipApp } = await import("./app.js");
  const app = await TokenSipApp.create(loadConfig(configFrom(values)));
  try {
    return await fn(app);
  } finally {
    app.close();
  }
}

async function keys(values: Values, sub: string | undefined) {
  if (sub === "create") {
    if (!values.name) throw new Error("--name is required");
    await withApp(values, (app) => {
      const { record, key } = app.keys.create({
        name: values.name as string,
        profile: (values.profile as ProfileId) ?? null,
        monthlyBudgetUsd: values.budget ? Number(values.budget) : null,
        rpm: values.rpm ? Number(values.rpm) : null,
      });
      app.audit.add("key.created", { id: record.id, name: record.name, via: "cli" });
      console.log(
        `\n${green("✔")} Created key ${bold(record.name)}\n\n  ${bold(key)}\n\n${dim("  Store it now — it cannot be shown again.")}\n`,
      );
    });
    return;
  }
  await withApp(values, (app) => {
    const list = app.keys.list();
    if (!list.length) return console.log(dim("No keys yet. Create one with: tokensip keys create --name my-app"));
    for (const k of list) {
      const spend = app.keys.monthSpend(k.id);
      console.log(
        `${k.enabled ? green("●") : red("●")} ${bold(k.name.padEnd(24))} ${k.hint}  ${dim(`profile=${k.profile ?? "default"}  month=$${spend.toFixed(4)}${k.monthlyBudgetUsd !== null ? ` / $${k.monthlyBudgetUsd}` : ""}`)}`,
      );
    }
  });
}

async function resetPassword(values: Values) {
  const { randomToken } = await import("./crypto.js");
  const { setAdminPassword } = await import("./routes/auth.js");
  const password = values.password ?? randomToken(15);
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");
  await withApp(values, (app) => {
    setAdminPassword(app, password);
    const admin = app.kv.get<{ passwordHash: string }>("admin");
    if (admin) app.kv.set("admin", { passwordHash: admin.passwordHash });
    app.sessions.deleteAll();
    app.audit.add("password.reset", { via: "cli" });
  });
  console.log(`\n${green("✔")} Admin password reset. 2FA disabled, all sessions signed out.\n\n  ${bold(password)}\n`);
}

function optimizeFile(values: Values, file: string | undefined) {
  if (!file) throw new Error("Usage: tokensip optimize <request.json> [--protocol anthropic] [--profile balanced]");
  const payload = JSON.parse(readFileSync(file, "utf8"));
  const protocol = (values.protocol ??
    (payload.contents
      ? "gemini"
      : payload.input !== undefined
        ? "openai-responses"
        : payload.system !== undefined || payload.max_tokens
          ? "anthropic"
          : "openai-chat")) as Protocol;
  const profile = (values.profile ?? "balanced") as ProfileId;
  const { report } = optimize(payload, { protocol, profile });
  const pct = report.tokensBefore ? ((report.tokensSaved / report.tokensBefore) * 100).toFixed(1) : "0";
  console.log(`\n${bold("TokenSip optimize")} ${dim(`${file} · ${protocol} · profile=${profile}`)}\n`);
  for (const s of report.stages) {
    const mark = s.applied ? green("✔") : dim("·");
    const safety =
      s.safety === "lossy" ? red(s.safety) : s.safety === "equivalent" ? yellow(s.safety) : green(s.safety);
    console.log(
      `  ${mark} ${s.id.padEnd(30)} ${safety.padEnd(tty ? 19 : 10)} ${s.tokensSaved ? bold(`-${s.tokensSaved}`) : dim("0")} ${dim(s.note ?? "")}`,
    );
  }
  console.log(
    `\n  ${bold(String(report.tokensBefore))} → ${bold(String(report.tokensAfter))} tokens  ${green(`(-${pct}%)`)}  ${dim(`${report.durationMs} ms`)}`,
  );
  if (report.lossy) console.log(`\n  ${red("▲")} ${PROFILE_INFO[profile].warning ?? "Lossy optimization applied."}`);
  console.log();
}

async function doctor(values: Values) {
  const { loadConfig } = await import("./config.js");
  const config = loadConfig(configFrom(values));
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  console.log(`\n${bold("TokenSip doctor")}\n`);
  console.log(`  ${nodeOk ? green("✔") : red("✖")} Node.js ${process.versions.node} ${nodeOk ? "" : "(need ≥ 22.13)"}`);
  try {
    await import("node:sqlite");
    console.log(`  ${green("✔")} node:sqlite available`);
  } catch {
    console.log(`  ${red("✖")} node:sqlite unavailable — upgrade Node.js`);
  }
  console.log(`  ${green("●")} data dir ${config.dataDir}`);
  console.log(
    `  ${green("●")} mode ${config.mode}, bind ${config.host}:${config.port}, passthrough ${config.allowPassthrough ? "on" : "off"}`,
  );
  console.log(
    `  ${config.secret ? green("✔") : yellow("●")} master key from ${config.secret ? "TOKENSIP_SECRET" : "data dir (master.key)"}`,
  );
  const { ENV_PROVIDER_KEYS } = await import("./config.js");
  const found = Object.entries(ENV_PROVIDER_KEYS).filter(([, vars]) => vars.some((v) => process.env[v]));
  console.log(
    `  ${green("●")} provider keys in environment: ${found.length ? found.map(([id]) => id).join(", ") : dim("none")}`,
  );
  console.log();
}

async function demo(values: Values) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createTokenSipServer } = await import("./server.js");
  const { seedDemo } = await import("./demo.js");
  const password = values.password ?? "tokensip-demo";
  const dataDir = mkdtempSync(join(tmpdir(), "tokensip-demo-"));
  const server = await createTokenSipServer({
    config: { ...configFrom(values), dataDir, adminPassword: password, allowPassthrough: true },
  });
  const rows = seedDemo(server.app);
  const base = await server.listen();
  console.log(
    [
      LOGO,
      `  ${green("●")} Demo dashboard  ${bold(base)}`,
      `  ${green("●")} Password        ${bold(password)}`,
      `  ${dim(`Seeded ${rows.toLocaleString()} synthetic requests into ${dataDir}`)}`,
      `  ${dim("Provider keys in demo mode are fake — use `tokensip start` for real traffic.")}`,
      "",
    ].join("\n"),
  );
  process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
}

async function simulateCmd(values: Values) {
  const { simulate } = await import("@tokensip/core");
  const int = (v: string | undefined, def: number, max: number) => {
    const n = v === undefined ? def : Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`expected a whole number between 1 and ${max}`);
    return n;
  };
  const opts = {
    sessions: int(values.sessions, 12, 500),
    turns: int(values.turns, 60, 400),
    seed: int(values.seed, 7, 1e9),
    leakyClock: Boolean(values.clock),
    breaks: !values["no-breaks"],
  };
  console.log(
    `\n  ${bold("Simulating")} ${opts.sessions} agent sessions × ${opts.turns} turns ${dim(
      `(Anthropic cache billing · ${opts.breaks ? "with" : "no"} breaks > 5 min · ${opts.leakyClock ? "clock in system prompt" : "stable system prompt"})`,
    )}\n`,
  );
  const started = performance.now();
  const results = simulate(opts);
  const ref = results[1]?.dollars ?? 0;
  const width = Math.max(...results.map((r) => r.strategy.length));
  for (const r of results) {
    const delta = ref > 0 ? (r.dollars - ref) / ref : 0;
    const deltaText = r === results[1] ? dim("baseline") : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`;
    const isV2 = r === results[results.length - 1];
    const line = `  ${r.strategy.padEnd(width)}  ${`$${r.dollars.toFixed(2)}`.padStart(9)}  ${deltaText.padStart(9)}  ${dim(
      `${(r.cacheReadShare * 100).toFixed(1)}% from cache`,
    )}`;
    console.log(isV2 ? bold(green(line)) : delta > 0 ? yellow(line) : line);
  }
  console.log(
    dim(`\n  ${((performance.now() - started) / 1000).toFixed(1)}s · same seed, same sessions for every strategy\n`),
  );
}

async function main() {
  const { values, positionals } = parse();
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(VERSION);
  const [cmd, sub] = positionals;
  switch (cmd ?? "start") {
    case "start":
      return start(values);
    case "optimize":
      return optimizeFile(values, sub);
    case "keys":
      return keys(values, sub);
    case "reset-password":
      return resetPassword(values);
    case "doctor":
      return doctor(values);
    case "demo":
      return demo(values);
    case "simulate":
      return simulateCmd(values);
    case "version":
      return console.log(VERSION);
    case "help":
      return console.log(HELP);
    default:
      console.error(`Unknown command: ${cmd}\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(red(`✖ ${(err as Error).message}`));
  process.exit(1);
});
