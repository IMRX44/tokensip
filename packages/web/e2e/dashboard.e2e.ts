/**
 * End-to-end dashboard tests in a real browser, against a real gateway and a
 * mock provider. Run with `npm run build && npm run test:e2e`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "../../server/src/crypto.js";
import { createTokenSipServer, type TokenSipServer } from "../../server/src/index.js";

const PASSWORD = "a very long admin passphrase";
let upstream: Server;
let upstreamUrl: string;
let ts: TokenSipServer;
let base: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const problems: string[] = [];
let vkey = "";

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models"))
        return res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }));
      const json = body ? JSON.parse(body) : {};
      res.end(
        JSON.stringify({
          id: "x",
          model: json.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 } },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  ts = await createTokenSipServer({
    config: { dataDir: ":memory:", port: 0, logLevel: "silent", dashboard: true },
    env: {},
  });
  base = await ts.listen();

  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 40[13]/.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
});

afterAll(async () => {
  await browser?.close();
  await ts?.close();
  upstream?.close();
});

const nav = async (label: string) => {
  await page.locator(".sidebar .nav-link", { hasText: label }).click();
  await page.waitForTimeout(250);
};
const toast = (text: string) => page.locator(".toast", { hasText: text }).first().waitFor();

describe("dashboard", () => {
  it("first run: setup with the one-time token", async () => {
    await page.goto(`${base}/setup?token=wrong-token`);
    await page.getByText("Secure your gateway").waitFor();
    const pw = page.locator('input[type="password"]');
    await pw.nth(0).fill(PASSWORD);
    await pw.nth(1).fill(PASSWORD);
    await page.getByRole("button", { name: /Create admin/ }).click();
    await page.getByText("Invalid setup token").waitFor();

    await page.goto(`${base}/setup?token=${ts.app.setupToken}`);
    await pw.nth(0).fill(PASSWORD);
    await pw.nth(1).fill(PASSWORD);
    await page.getByRole("button", { name: /Create admin/ }).click();
    await page.getByText("No traffic yet").waitFor();
    expect(new URL(page.url()).search).toBe("");
  });

  it("adds, tests and edits a custom provider", async () => {
    await nav("Providers");
    await page.getByRole("button", { name: "Add provider" }).click();
    await page.locator(".preset", { hasText: "Custom (OpenAI-compatible)" }).click();
    const modal = page.locator(".modal");
    await modal.locator('input[type="password"]').fill("sk-mock-provider-key-0001");
    await modal.locator("input.mono").nth(1).fill(`${upstreamUrl}/v1`);
    await modal.getByRole("button", { name: "Save" }).click();
    await page.locator(".list-row", { hasText: "Custom (OpenAI-compatible)" }).waitFor();
    expect(await page.content()).not.toContain("sk-mock-provider-key-0001");

    await page.getByRole("button", { name: "Test" }).click();
    await page.getByText(/Connected · 3 models/).waitFor();

    await page.getByRole("button", { name: "Edit" }).click();
    await page.locator(".modal input").first().fill("My Gateway");
    await page.locator(".modal").getByRole("button", { name: "Save" }).click();
    await page.locator(".list-row", { hasText: "My Gateway" }).waitFor();
  });

  it("creates a virtual key that works against the gateway", async () => {
    await nav("API Keys");
    await page.getByRole("button", { name: "Create key" }).first().click();
    await page.locator(".modal input").first().fill("e2e-app");
    await page.locator(".modal").getByRole("button", { name: "Create" }).click();
    const key = (await page.locator(".modal code").textContent())?.trim() ?? "";
    expect(key).toMatch(/^tsk_/);
    await page.locator(".modal").getByRole("button", { name: "close" }).click();
    await page.locator("td", { hasText: "e2e-app" }).waitFor();
    expect(await page.content()).not.toContain(key);
    vkey = key;

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "brand-new-model", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(res.status).toBe(200);
    await nav("Requests");
    await page.locator("td", { hasText: "brand-new-model" }).waitFor();
  });

  it("overview shows traffic and flags the unpriced model; pricing fixes it", async () => {
    await nav("Overview");
    await page.getByText(/have no price/).waitFor();
    await page.getByRole("button", { name: /Set prices/ }).click();
    const row = page.locator("tr", { hasText: "brand-new-model" });
    await row.getByText("no price").waitFor();
    const inputs = row.locator("input");
    await inputs.nth(0).fill("2");
    await inputs.nth(1).fill("8");
    await row.getByRole("button", { name: "Save" }).click();
    await page.locator("tr", { hasText: "brand-new-model" }).getByText("custom").waitFor();
  });

  it("sessions: an agent conversation shows its timeline and the cache leak", async () => {
    const turn = (n: number, time: string) => ({
      model: "brand-new-model",
      messages: [
        { role: "system", content: `Rules.\n${"Policy text. ".repeat(400)}\nCurrent time: ${time}\nEnd.` },
        { role: "user", content: "e2e session task" },
        ...Array.from({ length: n - 1 }, (_, i) => [
          { role: "assistant", content: `step ${i}` },
          { role: "user", content: `more ${i}` },
        ]).flat(),
      ],
    });
    const times = ["2026-10-16T10:00:00Z", "2026-10-16T10:01:30Z", "2026-10-16T10:02:45Z"];
    for (const [i, time] of times.entries()) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${vkey}`, "content-type": "application/json" },
        body: JSON.stringify(turn(i + 1, time)),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    await nav("Sessions");
    await page.locator("tr", { hasText: "brand-new-model" }).first().click();
    await page.getByText("Conversation timeline").waitFor();
    expect(await page.locator(".tl-col").count()).toBe(3);
    await page
      .getByText(/Cache leak: Clock \/ date at system\[0\]@/)
      .first()
      .waitFor();
    await page.locator(".event-row").getByText("repaired automatically").first().waitFor();
    await page.getByRole("button", { name: "All sessions" }).click();
    await page.getByText("Every agent conversation").waitFor();
  });

  it("optimizer lab: lossy profiles ask for confirmation and warn", async () => {
    await nav("Optimizer Lab");
    await page.locator(".card").getByRole("button", { name: "Optimize" }).first().click();
    await page.getByText("Reduction").waitFor();
    await page.locator(".profile", { hasText: "Extreme" }).click();
    await page.getByText("Output quality will drop").first().waitFor();
    await page.getByRole("button", { name: /I understand/ }).click();
    await page.locator(".callout.bad").waitFor();
  });

  it("settings: changing the profile persists; cancelling a risky one does not", async () => {
    await nav("Settings");
    await page.locator(".profile", { hasText: "Balanced" }).click();
    await toast("Saved");
    await page.locator(".profile", { hasText: "Aggressive" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(ts.app.settings.profile).toBe("balanced");
  });

  it("switches language to Persian with a right-to-left layout", async () => {
    await page.locator(".sidebar select").selectOption("fa");
    await page.locator(".sidebar .nav-link", { hasText: "نمای کلی" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
    await page.locator(".sidebar select").selectOption("en");
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("ltr");
  });

  it("enrolls 2FA and requires it at the next login", async () => {
    await nav("Settings");
    await page.getByRole("button", { name: "Set up 2FA" }).click();
    const secret = (await page.locator(".card code.small").textContent())?.trim() ?? "";
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.locator('input[inputmode="numeric"]').fill(totpCode(secret));
    await page.getByRole("button", { name: "Verify & enable" }).click();
    await page.getByText(/Enabled — an authenticator code/).waitFor();

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByText("Welcome back").waitFor();
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Authenticator code").waitFor();
    await page.locator('input[inputmode="numeric"]').fill("000000");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Incorrect authenticator code").waitFor();
    await page.locator('input[inputmode="numeric"]').fill(totpCode(secret));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.locator(".sidebar").waitFor();
  });

  it("produced no console errors or CSP violations", () => {
    expect(problems).toEqual([]);
  });
});
