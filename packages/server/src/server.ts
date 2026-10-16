import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { PROVIDERS, VERSION } from "@tokensip/core";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, LogController } from "fastify";
import { TokenSipApp } from "./app.js";
import { loadConfig, type TokenSipConfig } from "./config.js";
import { randomToken, safeEqual } from "./crypto.js";
import { handlePreflight, proxyRequest } from "./proxy.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes, getAdmin, setAdminPassword } from "./routes/auth.js";

export interface TokenSipServer {
  fastify: FastifyInstance;
  app: TokenSipApp;
  config: TokenSipConfig;
  /** Start listening; resolves to the base URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  config?: Partial<TokenSipConfig>;
  env?: NodeJS.ProcessEnv;
  /** Directory containing the built dashboard. Defaults to the bundled one. */
  webDir?: string;
}

const RESERVED = new Set(["api", "v1", "v1beta", "p", "assets", "healthz", "readyz", "metrics"]);

function defaultWebDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "web"), join(here, "..", "..", "web", "dist")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

/**
 * Create a TokenSip server. Use this to embed TokenSip in your own Node
 * process; the `tokensip` CLI is a thin wrapper around it.
 */
export async function createTokenSipServer(options: CreateServerOptions = {}): Promise<TokenSipServer> {
  const env = options.env ?? process.env;
  const config = loadConfig(options.config, env);
  const app = await TokenSipApp.create(config, env);

  // Admin bootstrap: env password, or a one-time setup token printed on startup.
  if (!getAdmin(app)) {
    if (config.adminPassword) {
      if (config.adminPassword.length < 10) throw new Error("TOKENSIP_ADMIN_PASSWORD must be at least 10 characters.");
      setAdminPassword(app, config.adminPassword);
    } else {
      app.setupToken = randomToken(18);
    }
  }

  const fastify = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    // Per-request access logs are off: URLs can carry Gemini `?key=` credentials.
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    forceCloseConnections: "idle",
  });

  await fastify.register(fastifyCookie);
  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.mode === "server" ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "no-referrer" },
  });

  // ---- health & metrics
  fastify.get("/healthz", async () => ({ status: "ok", version: VERSION }));
  fastify.get("/readyz", async (_req, reply) => {
    try {
      app.db.prepare("SELECT 1").get();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  fastify.get("/metrics", async (req, reply) => {
    const token = config.metricsToken;
    const auth = String(req.headers.authorization ?? "");
    if (!token) return reply.code(404).send({ error: "metrics disabled (set TOKENSIP_METRICS_TOKEN)" });
    if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), token))
      return reply.code(401).send({ error: "unauthorized" });
    return reply.type("text/plain; version=0.0.4").send(app.metrics.render());
  });

  // ---- admin API (JSON bodies)
  await fastify.register(
    async (api) => {
      await api.register(authRoutes, { prefix: "/auth", app });
      await api.register(adminRoutes, { app });
    },
    { prefix: "/api" },
  );

  // ---- proxy (raw bodies so unchanged requests are forwarded byte-for-byte)
  await fastify.register(async (proxy) => {
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    const handler =
      (presetFrom: (req: FastifyRequest) => string | undefined, strip: (req: FastifyRequest) => string) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        if (req.method === "OPTIONS") return handlePreflight(app, req, reply);
        return proxyRequest(app, req, reply, { presetId: presetFrom(req), path: strip(req) });
      };
    const pathOf = (req: FastifyRequest) => req.url.split("?")[0] ?? "/";

    // Auto-routed, provider-agnostic endpoints (OpenAI, Anthropic and Gemini wire formats).
    const auto = handler(() => undefined, pathOf);
    proxy.all("/v1/*", auto);
    proxy.all("/v1beta/*", auto);

    // Explicit provider endpoints: /<provider>/... and /p/<provider-or-record-id>/...
    for (const preset of PROVIDERS) {
      if (RESERVED.has(preset.id)) continue;
      const prefix = `/${preset.id}`;
      proxy.all(
        `${prefix}/*`,
        handler(
          () => preset.id,
          (req) => pathOf(req).slice(prefix.length) || "/",
        ),
      );
    }
    proxy.all(
      "/p/:provider/*",
      handler(
        (req) => (req.params as { provider: string }).provider,
        (req) => pathOf(req).replace(/^\/p\/[^/]+/, "") || "/",
      ),
    );
  });

  // ---- dashboard
  const webDir = options.webDir ?? defaultWebDir();
  if (config.dashboard && webDir) {
    await fastify.register(fastifyStatic, { root: webDir, wildcard: false, index: ["index.html"], maxAge: "1h" });
    fastify.get("/assets/*", (req, reply) => {
      const file = (req.params as { "*": string })["*"];
      return reply.header("cache-control", "public, max-age=31536000, immutable").sendFile(`assets/${file}`);
    });
  }
  fastify.setNotFoundHandler((req, reply) => {
    const accept = String(req.headers.accept ?? "");
    if (
      config.dashboard &&
      webDir &&
      req.method === "GET" &&
      accept.includes("text/html") &&
      !req.url.startsWith("/api")
    ) {
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found", message: `No route for ${req.method} ${req.url.split("?")[0]}` });
  });

  const maintenance = setInterval(() => {
    try {
      app.maintain();
    } catch (err) {
      fastify.log.warn({ err }, "maintenance failed");
    }
  }, 10 * 60_000);
  maintenance.unref();

  return {
    fastify,
    app,
    config,
    async listen() {
      await fastify.listen({ host: config.host, port: config.port });
      const addr = fastify.server.address();
      const port = typeof addr === "object" && addr ? addr.port : config.port;
      const host = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
      return `http://${host}:${port}`;
    },
    async close() {
      clearInterval(maintenance);
      await fastify.close();
      app.close();
    },
  };
}
