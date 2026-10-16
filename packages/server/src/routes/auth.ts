import type {} from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TokenSipApp } from "../app.js";
import { hashPassword, newTotpSecret, randomToken, safeEqual, verifyPassword, verifyTotp } from "../crypto.js";

export const SESSION_COOKIE = "tokensip_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;

interface AdminRecord {
  passwordHash: string;
  totpSecretEnc?: string;
  totpEnabled?: boolean;
  totpPendingEnc?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    sessionToken?: string;
  }
}

export function getAdmin(app: TokenSipApp): AdminRecord | undefined {
  return app.kv.get<AdminRecord>("admin");
}

export function setAdminPassword(app: TokenSipApp, password: string): void {
  const cur = getAdmin(app);
  app.kv.set("admin", { ...cur, passwordHash: hashPassword(password) });
  app.setupToken = null;
}

function clientIp(req: FastifyRequest): string {
  return req.ip ?? "unknown";
}

function startSession(app: TokenSipApp, req: FastifyRequest, reply: FastifyReply): string {
  const token = randomToken(32);
  const csrf = randomToken(24);
  app.sessions.create(token, csrf, SESSION_TTL_MS, clientIp(req), String(req.headers["user-agent"] ?? ""));
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: "auto",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return csrf;
}

/** Same-origin check for state-changing requests (defense in depth on top of SameSite + CSRF token). */
function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** preHandler for every authenticated admin route. */
export function requireSession(app: TokenSipApp) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    const session = token ? app.sessions.get(token) : undefined;
    if (!token || !session) return reply.code(401).send({ error: "unauthorized" });
    if (req.method !== "GET" && req.method !== "HEAD") {
      const csrf = String(req.headers["x-csrf-token"] ?? "");
      if (!sameOrigin(req) || !csrf || !safeEqual(csrf, session.csrf)) {
        return reply.code(403).send({ error: "csrf_failed" });
      }
    }
    if (session.expiresAt - Date.now() < SESSION_TTL_MS / 2) app.sessions.extend(token, SESSION_TTL_MS);
    req.sessionToken = token;
  };
}

function loginThrottle(app: TokenSipApp, req: FastifyRequest, reply: FastifyReply): boolean {
  const r = app.loginLimiter.hit(`login:${clientIp(req)}`, 10);
  if (!r.ok) {
    reply
      .code(429)
      .header("retry-after", String(r.retryAfterSec))
      .send({ error: "too_many_attempts", retryAfter: r.retryAfterSec });
    return false;
  }
  return true;
}

export async function authRoutes(fastify: FastifyInstance, { app }: { app: TokenSipApp }) {
  fastify.get("/state", async (req) => {
    const admin = getAdmin(app);
    const token = req.cookies[SESSION_COOKIE];
    const session = token ? app.sessions.get(token) : undefined;
    return {
      setupRequired: !admin,
      authenticated: Boolean(session),
      csrfToken: session?.csrf ?? null,
      totpEnabled: Boolean(admin?.totpEnabled),
      mode: app.config.mode,
    };
  });

  fastify.post("/setup", async (req, reply) => {
    if (!loginThrottle(app, req, reply)) return;
    const body = z.object({ token: z.string(), password: z.string().min(MIN_PASSWORD).max(256) }).safeParse(req.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ error: "invalid_input", detail: `Password must be at least ${MIN_PASSWORD} characters.` });
    if (getAdmin(app)) return reply.code(409).send({ error: "already_configured" });
    if (!app.setupToken || !safeEqual(body.data.token.trim(), app.setupToken)) {
      app.audit.add("setup.failed", {}, clientIp(req));
      return reply.code(403).send({ error: "invalid_setup_token" });
    }
    setAdminPassword(app, body.data.password);
    app.audit.add("setup.completed", {}, clientIp(req));
    const csrfToken = startSession(app, req, reply);
    return { ok: true, csrfToken };
  });

  fastify.post("/login", async (req, reply) => {
    if (!loginThrottle(app, req, reply)) return;
    const body = z.object({ password: z.string().max(256), totp: z.string().max(10).optional() }).safeParse(req.body);
    const admin = getAdmin(app);
    if (!body.success || !admin) return reply.code(400).send({ error: "invalid_input" });
    const ok = verifyPassword(body.data.password, admin.passwordHash);
    if (!ok) {
      app.audit.add("login.failed", { reason: "password" }, clientIp(req));
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (admin.totpEnabled && admin.totpSecretEnc) {
      if (!body.data.totp) return reply.code(401).send({ error: "totp_required" });
      if (!verifyTotp(app.vault.decryptString(admin.totpSecretEnc), body.data.totp)) {
        app.audit.add("login.failed", { reason: "totp" }, clientIp(req));
        return reply.code(401).send({ error: "invalid_totp" });
      }
    }
    app.loginLimiter.reset(`login:${clientIp(req)}`);
    app.audit.add("login.success", {}, clientIp(req));
    return { ok: true, csrfToken: startSession(app, req, reply) };
  });

  fastify.post("/logout", { preHandler: requireSession(app) }, async (req, reply) => {
    if (req.sessionToken) app.sessions.delete(req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  fastify.post("/password", { preHandler: requireSession(app) }, async (req, reply) => {
    const body = z
      .object({ current: z.string().max(256), next: z.string().min(MIN_PASSWORD).max(256) })
      .safeParse(req.body);
    const admin = getAdmin(app);
    if (!body.success || !admin) return reply.code(400).send({ error: "invalid_input" });
    if (!verifyPassword(body.data.current, admin.passwordHash))
      return reply.code(401).send({ error: "invalid_credentials" });
    setAdminPassword(app, body.data.next);
    app.sessions.deleteAll();
    app.audit.add("password.changed", {}, clientIp(req));
    return { ok: true, csrfToken: startSession(app, req, reply) };
  });

  fastify.post("/totp/begin", { preHandler: requireSession(app) }, async () => {
    const admin = getAdmin(app) as AdminRecord;
    const secret = newTotpSecret();
    app.kv.set("admin", { ...admin, totpPendingEnc: app.vault.encryptString(secret) });
    const uri = `otpauth://totp/TokenSip:admin?secret=${secret}&issuer=TokenSip&algorithm=SHA1&digits=6&period=30`;
    return { secret, uri };
  });

  fastify.post("/totp/enable", { preHandler: requireSession(app) }, async (req, reply) => {
    const body = z.object({ code: z.string() }).safeParse(req.body);
    const admin = getAdmin(app) as AdminRecord;
    if (!body.success || !admin.totpPendingEnc) return reply.code(400).send({ error: "invalid_input" });
    const secret = app.vault.decryptString(admin.totpPendingEnc);
    if (!verifyTotp(secret, body.data.code)) return reply.code(400).send({ error: "invalid_totp" });
    app.kv.set("admin", { passwordHash: admin.passwordHash, totpSecretEnc: admin.totpPendingEnc, totpEnabled: true });
    app.audit.add("totp.enabled", {}, clientIp(req));
    return { ok: true };
  });

  fastify.post("/totp/disable", { preHandler: requireSession(app) }, async (req, reply) => {
    const body = z.object({ password: z.string().max(256) }).safeParse(req.body);
    const admin = getAdmin(app) as AdminRecord;
    if (!body.success || !verifyPassword(body.data.password, admin.passwordHash)) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    app.kv.set("admin", { passwordHash: admin.passwordHash });
    app.audit.add("totp.disabled", {}, clientIp(req));
    return { ok: true };
  });
}
