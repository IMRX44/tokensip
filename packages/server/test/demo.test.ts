import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../src/demo.js";
import { createTokenSipServer, type TokenSipServer } from "../src/index.js";

const PASSWORD = "correct horse battery staple";
let ts: TokenSipServer;
let base: string;
let cookie = "";
let rows = 0;

async function get(path: string) {
  const res = await fetch(`${base}/api${path}`, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

beforeAll(async () => {
  ts = await createTokenSipServer({
    config: { dataDir: ":memory:", port: 0, logLevel: "silent", dashboard: false, adminPassword: PASSWORD },
    env: {},
  });
  // Seeding runs inside one transaction while the request log flushes every 200 rows.
  rows = seedDemo(ts.app, 3);
  base = await ts.listen();
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
});

afterAll(async () => {
  await ts?.close();
});

describe("demo data", () => {
  it("seeds requests and agent sessions", async () => {
    expect(rows).toBeGreaterThan(200);
    const o = await get("/overview?range=7d");
    expect(o.json.totals.requests).toBe(rows);
    expect(o.json.totals.sessions).toBeGreaterThan(10);
    expect(o.json.totals.cacheReadShare).toBeGreaterThan(0.3);
    expect(o.json.cacheDoctor.length).toBeGreaterThan(0);
  });

  it("lists sessions and returns each turn in order", async () => {
    const list = await get("/sessions?range=7d");
    expect(list.json.length).toBeGreaterThan(10);
    const first = list.json[0];
    expect(first.turns).toBeGreaterThan(1);
    const detail = await get(`/sessions/${encodeURIComponent(first.id)}`);
    expect(detail.status).toBe(200);
    const turns = detail.json.turns.map((x: { turn: number }) => x.turn);
    expect(turns).toEqual([...turns].sort((a: number, b: number) => a - b));
    expect(turns.length).toBe(first.turns);
    expect((await get("/sessions/does-not-exist")).status).toBe(404);
  });

  it("every seeded turn sends new tokens past the cached prefix", () => {
    const rows = ts.app.db
      .prepare("SELECT input_tokens + cache_write_tokens AS fresh FROM requests WHERE session_id IS NOT NULL")
      .all() as { fresh: number }[];
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.every((r) => r.fresh > 0)).toBe(true);
  });
});
