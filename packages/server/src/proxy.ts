import { randomUUID } from "node:crypto";
import {
  countTokens,
  emptyUsage,
  type OptimizeReport,
  optimize,
  PROFILE_INFO,
  type ProfileId,
  type Protocol,
  protocolFromPath,
  requestFingerprint,
  SseParser,
  StreamUsageAccumulator,
  type Surface,
  type Usage,
  usageFromResponse,
} from "@tokensip/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ResolvedProvider, TokenSipApp } from "./app.js";
import { sha256Hex, VIRTUAL_KEY_PREFIX } from "./crypto.js";
import { errorBody, ProxyError } from "./lib/errors.js";
import type { ApiKeyRecord } from "./store.js";

const PROFILES = new Set<ProfileId>(["off", "safe", "balanced", "aggressive", "extreme"]);

/** Request headers forwarded upstream. Everything else (cookies, auth, hop-by-hop) is dropped. */
const FORWARD_HEADERS = [
  "content-type",
  "accept",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "openai-organization",
  "openai-project",
  "openai-beta",
  "idempotency-key",
  "x-goog-api-client",
  "x-goog-user-project",
  "http-referer",
  "x-title",
];

const PASSTHROUGH_AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key"];

/** Response headers never copied back to the client. */
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "alt-svc",
  "server",
  "strict-transport-security",
]);

const MAX_ACCOUNTING_BYTES = 32 * 1024 * 1024;

interface ClientAuth {
  key?: ApiKeyRecord;
  passthrough: boolean;
  tenant: string;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function detectSurface(path: string, method: string, req: FastifyRequest): Surface {
  if (/^\/v1\/messages(\/|$)/.test(path)) return "anthropic";
  if (path.startsWith("/v1beta") || /\/models\/[^/]+:[a-zA-Z]+$/.test(path)) return "gemini";
  if (method === "GET" && path.startsWith("/v1/models") && header(req, "anthropic-version")) return "anthropic";
  return "openai";
}

function extractCredential(req: FastifyRequest, url: URL): string | undefined {
  const authz = header(req, "authorization");
  if (authz?.toLowerCase().startsWith("bearer ")) return authz.slice(7).trim();
  return (
    header(req, "x-api-key") ??
    header(req, "x-goog-api-key") ??
    header(req, "api-key") ??
    url.searchParams.get("key") ??
    undefined
  );
}

function authenticate(app: TokenSipApp, req: FastifyRequest, url: URL): ClientAuth {
  const credential = extractCredential(req, url);
  if (!credential) {
    throw new ProxyError(
      401,
      "Missing API key. Send a TokenSip key (tsk_…) or, if passthrough is enabled, your provider key.",
      "authentication_error",
    );
  }
  if (credential.startsWith(VIRTUAL_KEY_PREFIX)) {
    const key = app.keys.findByKey(credential);
    if (!key?.enabled) throw new ProxyError(401, "Invalid or disabled TokenSip API key.", "authentication_error");
    if (key.expiresAt && key.expiresAt < Date.now())
      throw new ProxyError(401, "This TokenSip API key has expired.", "authentication_error");
    return { key, passthrough: false, tenant: `key:${key.id}` };
  }
  if (!app.config.allowPassthrough) {
    throw new ProxyError(
      401,
      "Passthrough of provider keys is disabled on this server. Use a TokenSip key (tsk_…).",
      "authentication_error",
    );
  }
  return { passthrough: true, tenant: `pt:${sha256Hex(credential).slice(0, 24)}` };
}

function enforceLimits(app: TokenSipApp, key: ApiKeyRecord | undefined): void {
  if (!key) return;
  if (key.rpm) {
    const r = app.keyLimiter.hit(key.id, key.rpm);
    if (!r.ok) {
      throw new ProxyError(429, `Rate limit of ${key.rpm} requests/minute exceeded for this key.`, "rate_limit_error", {
        "retry-after": String(r.retryAfterSec),
      });
    }
  }
  if (key.monthlyBudgetUsd !== null && key.monthlyBudgetUsd !== undefined) {
    const spent = app.keySpend(key.id);
    if (spent >= key.monthlyBudgetUsd) {
      throw new ProxyError(
        429,
        `Monthly budget of $${key.monthlyBudgetUsd.toFixed(2)} reached for this key ($${spent.toFixed(4)} spent).`,
        "budget_exceeded",
      );
    }
  }
}

function upstreamHeaders(
  req: FastifyRequest,
  provider: ResolvedProvider,
  passthrough: boolean,
  bodyRewritten: boolean,
): Headers {
  const h = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = header(req, name);
    if (v) h.set(name, v);
  }
  // A compressed body is forwarded as-is (TokenSip only rewrites bodies it could parse).
  const encoding = header(req, "content-encoding");
  if (encoding && !bodyRewritten) h.set("content-encoding", encoding);
  if (passthrough) {
    // Forward the client's own credential untouched (API keys and OAuth tokens alike).
    for (const name of PASSTHROUGH_AUTH_HEADERS) {
      const v = header(req, name);
      if (v) h.set(name, v);
    }
  } else if (provider.apiKey) {
    switch (provider.auth) {
      case "bearer":
        h.set("authorization", `Bearer ${provider.apiKey}`);
        break;
      case "x-api-key":
        h.set("x-api-key", provider.apiKey);
        break;
      case "x-goog-api-key":
        h.set("x-goog-api-key", provider.apiKey);
        break;
      case "api-key":
        h.set("api-key", provider.apiKey);
        break;
    }
  }
  if (provider.surface === "anthropic" && !h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01");
  return h;
}

function buildUpstreamUrl(provider: ResolvedProvider, path: string, url: URL, passthrough: boolean): string {
  const rest = provider.surface === "openai" ? path.replace(/^\/v1(?=\/|$)/, "") : path;
  const query = new URLSearchParams(url.search);
  if (!passthrough) query.delete("key");
  const qs = query.toString();
  return `${provider.baseUrl}${rest}${qs ? `?${qs}` : ""}`;
}

function corsHeaders(app: TokenSipApp, req: FastifyRequest): Record<string, string> {
  const origin = header(req, "origin");
  const allowed = app.config.corsOrigins;
  if (!origin || allowed.length === 0) return {};
  if (!allowed.includes("*") && !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": allowed.includes("*") ? "*" : origin,
    "access-control-expose-headers":
      "x-tokensip-request-id, x-tokensip-tokens-saved, x-tokensip-cache, x-tokensip-profile, x-tokensip-warning",
    vary: "Origin",
  };
}

export function handlePreflight(app: TokenSipApp, req: FastifyRequest, reply: FastifyReply): void {
  const cors = corsHeaders(app, req);
  if (!cors["access-control-allow-origin"]) {
    reply.code(204).send();
    return;
  }
  reply
    .headers({
      ...cors,
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": header(req, "access-control-request-headers") ?? "*",
      "access-control-max-age": "600",
    })
    .code(204)
    .send();
}

function cacheEligible(
  app: TokenSipApp,
  req: FastifyRequest,
  protocol: Protocol | undefined,
  path: string,
  body: unknown,
): boolean {
  const mode = header(req, "x-tokensip-cache")?.toLowerCase();
  if (mode === "bypass" || mode === "off") return false;
  const settings = app.settings.responseCache;
  if (!settings.enabled && mode !== "force") return false;
  if (req.method !== "POST" || !body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const isEmbedding = /\/embeddings$|:(batch)?embedContents?$/i.test(path);
  if (!protocol && !isEmbedding) return false;
  // Stateful / async OpenAI Responses requests must always reach the provider.
  if (b.previous_response_id || b.background === true || b.conversation) return false;
  if (mode === "force" || isEmbedding || !settings.onlyDeterministic) return true;
  const gc = (b.generationConfig ?? {}) as Record<string, unknown>;
  return b.temperature === 0 || gc.temperature === 0;
}

function estimateUsage(payload: unknown, generated: string): Usage {
  const promptChars = payload ? JSON.stringify(payload).length : 0;
  return {
    ...emptyUsage(),
    inputTokens: Math.ceil(promptChars / 4),
    outputTokens: countTokens(generated),
    estimated: true,
  };
}

/**
 * Proxy one request. `presetId` comes from provider-scoped routes such as
 * `/openai/v1/...`; `path` is the client path *after* that prefix.
 */
export async function proxyRequest(
  app: TokenSipApp,
  req: FastifyRequest,
  reply: FastifyReply,
  route: { presetId?: string; path: string },
): Promise<void> {
  const started = performance.now();
  const requestId = randomUUID();
  const url = new URL(req.url, "http://tokensip.local");
  const path = route.path.split("?")[0] || "/";
  const method = req.method.toUpperCase();
  const surface = detectSurface(path, method, req);
  const protocol = method === "POST" ? protocolFromPath(path) : undefined;
  const usageProtocol: Protocol =
    protocol ?? (surface === "anthropic" ? "anthropic" : surface === "gemini" ? "gemini" : "openai-chat");
  const cors = corsHeaders(app, req);

  const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
  let parsed: Record<string, unknown> | undefined;
  if (raw?.length && /json/i.test(header(req, "content-type") ?? "application/json")) {
    try {
      const v = JSON.parse(raw.toString("utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      /* not JSON — forwarded untouched */
    }
  }
  const model =
    (typeof parsed?.model === "string" ? parsed.model : undefined) ??
    (decodeURIComponent(path.match(/\/models\/([^/:]+)/)?.[1] ?? "") || undefined);

  let auth: ClientAuth | undefined;
  let provider: ResolvedProvider | undefined;
  let report: OptimizeReport | undefined;
  let profile: ProfileId = app.settings.profile;

  const record = (
    status: number,
    extra: Partial<{
      usage: Usage;
      ttfb: number | null;
      error: string;
      cacheHit: boolean;
      stream: boolean;
      latency: number;
    }>,
  ) => {
    const usage = extra.usage ?? emptyUsage();
    const saved = report?.tokensSaved ?? 0;
    const cost = app.prices.cost(model, usage, saved);
    const actual = extra.cacheHit ? 0 : cost.actual;
    app.requests.insert({
      id: requestId,
      ts: Date.now(),
      keyId: auth?.key?.id ?? null,
      tenant: auth?.tenant ?? null,
      provider: provider?.preset.id ?? route.presetId ?? null,
      model: model ?? null,
      protocol: protocol ?? null,
      path,
      stream: extra.stream ?? false,
      status,
      latencyMs: extra.latency ?? performance.now() - started,
      ttfbMs: extra.ttfb ?? null,
      overheadMs: report?.durationMs ?? 0,
      usage,
      optimizerSaved: saved,
      cost: actual,
      baselineCost: cost.baseline,
      cacheHit: extra.cacheHit ?? false,
      profile,
      lossy: report?.lossy ?? false,
      error: extra.error ?? null,
    });
    if (auth?.key) app.addSpend(auth.key.id, actual);
    const labels = { provider: provider?.preset.id ?? "unknown", status: String(status) };
    const m = app.metrics;
    m.inc("tokensip_requests_total", labels);
    m.inc("tokensip_prompt_tokens_total", labels, usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
    m.inc("tokensip_output_tokens_total", labels, usage.outputTokens);
    m.inc("tokensip_tokens_trimmed_total", labels, saved);
    m.inc("tokensip_cache_read_tokens_total", labels, usage.cacheReadTokens);
    m.inc("tokensip_cost_usd_total", labels, actual);
    m.inc("tokensip_baseline_cost_usd_total", labels, cost.baseline);
    if (extra.cacheHit) m.inc("tokensip_response_cache_hits_total", labels);
  };

  const fail = (err: ProxyError) => {
    record(err.status, { error: err.message });
    reply
      .code(err.status)
      .headers({ ...cors, ...err.headers, "x-tokensip-request-id": requestId })
      .send(errorBody(surface, err.status, err.message, err.type));
  };

  try {
    auth = authenticate(app, req, url);
    enforceLimits(app, auth.key);
    try {
      provider = app.resolve({
        surface,
        presetId: route.presetId ?? header(req, "x-tokensip-provider"),
        model,
        allowed: auth.key?.allowedProviders,
        passthrough: auth.passthrough,
      });
    } catch (err) {
      throw new ProxyError(400, (err as Error).message, "invalid_request_error");
    }
  } catch (err) {
    if (err instanceof ProxyError) return fail(err);
    throw err;
  }

  // ---- optimization
  const headerProfile = header(req, "x-tokensip-profile")?.toLowerCase() as ProfileId | undefined;
  if (headerProfile && app.settings.allowProfileHeader && PROFILES.has(headerProfile)) profile = headerProfile;
  else if (auth.key?.profile) profile = auth.key.profile;

  let payload: Record<string, unknown> | undefined = parsed;
  if (protocol && parsed && profile !== "off") {
    try {
      const res = optimize(parsed, {
        protocol,
        profile,
        overrides: profile === app.settings.profile ? app.settings.overrides : undefined,
        options: app.settings.stageOptions,
        model,
        provider: provider.preset.id,
        cacheKeySalt: auth.tenant,
        tokenCounting: "fast",
      });
      report = res.report;
      payload = res.payload;
    } catch (err) {
      req.log.warn({ err }, "optimizer failed; forwarding the original request");
    }
  }

  // Ask for usage on OpenAI streams; the extra usage-only chunk is filtered out before it reaches the client.
  let stripUsageChunk = false;
  if (
    protocol === "openai-chat" &&
    payload?.stream === true &&
    provider.streamUsage &&
    app.settings.streamUsage &&
    !(payload.stream_options as Record<string, unknown> | undefined)?.include_usage
  ) {
    payload = {
      ...payload,
      stream_options: { ...((payload.stream_options as object) ?? {}), include_usage: true },
    };
    stripUsageChunk = true;
  }

  const bodyChanged = payload !== parsed;
  const upstreamBody: Buffer | undefined =
    method === "GET" || method === "HEAD" ? undefined : bodyChanged ? Buffer.from(JSON.stringify(payload)) : raw;

  const tsHeaders: Record<string, string> = {
    ...cors,
    "x-tokensip-request-id": requestId,
    "x-tokensip-profile": profile,
    "x-tokensip-provider": provider.preset.id,
  };
  if (report) tsHeaders["x-tokensip-tokens-saved"] = String(report.tokensSaved);
  if (report?.lossy) {
    tsHeaders["x-tokensip-warning"] =
      `lossy optimization (${profile}): ${PROFILE_INFO[profile].warning ?? "the model received a reduced prompt"}`;
  }

  // ---- response cache
  const cacheable = cacheEligible(app, req, protocol, path, payload);
  const cacheKey = cacheable
    ? requestFingerprint(payload, { tenant: auth.tenant, provider: provider.preset.id, path, surface, profile })
    : undefined;
  if (cacheKey) {
    const hit = app.cache.get(cacheKey, auth.tenant);
    if (hit) {
      record(200, {
        usage: hit.usage,
        cacheHit: true,
        stream: payload?.stream === true,
        ttfb: performance.now() - started,
      });
      reply
        .code(200)
        .headers({ ...tsHeaders, "content-type": hit.contentType, "x-tokensip-cache": "HIT" })
        .send(hit.body);
      return;
    }
    tsHeaders["x-tokensip-cache"] = "MISS";
  } else {
    tsHeaders["x-tokensip-cache"] = "BYPASS";
  }

  // ---- upstream call
  // `close` on the *response* fires when the client goes away (the request's own
  // `close` fires as soon as its body is consumed, which is not a disconnect).
  const abort = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableFinished) abort.abort(new Error("client disconnected"));
  };
  reply.raw.on("close", onClose);
  const timeout = AbortSignal.timeout(app.config.upstreamTimeoutMs);

  let upstream: Response;
  try {
    upstream = await fetch(buildUpstreamUrl(provider, path, url, auth.passthrough), {
      method,
      headers: upstreamHeaders(req, provider, auth.passthrough, bodyChanged),
      body: upstreamBody,
      signal: AbortSignal.any([abort.signal, timeout]),
      redirect: "manual",
    });
  } catch (err) {
    reply.raw.off("close", onClose);
    const timedOut = timeout.aborted;
    const message = timedOut
      ? `Upstream ${provider.name} timed out after ${app.config.upstreamTimeoutMs} ms.`
      : `Could not reach ${provider.name}: ${(err as Error).message}`;
    if (abort.signal.aborted) {
      record(499, { error: "client disconnected" });
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    return fail(new ProxyError(timedOut ? 504 : 502, message, "upstream_error"));
  }
  const ttfb = performance.now() - started;
  if (provider.source === "db") app.providers.touch(provider.id);
  if (auth.key) app.keys.touch(auth.key.id);

  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name) && !name.startsWith("access-control-")) outHeaders[name] = value;
  });
  Object.assign(outHeaders, tsHeaders);
  const contentType = upstream.headers.get("content-type") ?? "";
  const isSse = contentType.includes("text/event-stream");

  reply.hijack();
  const res = reply.raw;
  res.writeHead(upstream.status, outHeaders);

  const accumulator = new StreamUsageAccumulator(usageProtocol);
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const chunks: Buffer[] = [];
  let captured = 0;
  // SSE usage is parsed incrementally, so a stream is only buffered when it may be cached
  // (or when it's an error whose message we log). Non-SSE bodies are kept for usage parsing.
  let overflow = isSse && !cacheKey && upstream.status < 400;
  let aborted = false;

  // Set once the format's end-of-stream event has been forwarded. Some providers keep the
  // connection open after it and SDKs hang up as soon as they see it — that's a completed
  // response, not an interrupted one.
  let complete = false;

  const handleEvent = (data: string): boolean => {
    if (!data) return true;
    if (data === "[DONE]") {
      complete = true;
      return true;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return true;
    }
    const type = (json as { type?: unknown }).type;
    if (
      type === "message_stop" ||
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      complete = true;
    }
    accumulator.push(json);
    if (stripUsageChunk) {
      const j = json as Record<string, unknown>;
      if (Array.isArray(j.choices) && j.choices.length === 0 && j.usage) return false;
    }
    return true;
  };

  const write = (buf: Buffer | string): Promise<void> =>
    new Promise((resolve) => {
      if (res.destroyed) return resolve();
      if (res.write(buf)) resolve();
      else res.once("drain", resolve);
    });

  try {
    if (upstream.body) {
      for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        if (isSse) {
          const events = parser.push(decoder.decode(buf, { stream: true }));
          if (stripUsageChunk) {
            let out = "";
            for (const ev of events) if (handleEvent(ev.data)) out += ev.raw;
            if (out) {
              await write(out);
              captured += out.length;
              if (captured > MAX_ACCOUNTING_BYTES) {
                overflow = true;
                chunks.length = 0;
              } else if (!overflow) chunks.push(Buffer.from(out));
            }
            if (complete) break;
            continue;
          }
          for (const ev of events) handleEvent(ev.data);
        }
        await write(buf);
        if (!overflow) {
          captured += buf.length;
          if (captured > MAX_ACCOUNTING_BYTES) {
            overflow = true;
            chunks.length = 0;
          } else chunks.push(buf);
        }
        // Finish as soon as the stream is semantically done; breaking out also releases the upstream socket.
        if (complete) break;
      }
      if (isSse) {
        const rest = parser.flush();
        let out = "";
        for (const ev of rest) if (handleEvent(ev.data)) out += ev.raw;
        if (stripUsageChunk && out) {
          await write(out);
          if (!overflow) chunks.push(Buffer.from(out));
        }
      }
    }
  } catch (err) {
    aborted = !complete;
    req.log.debug({ err }, "stream interrupted");
  } finally {
    res.off("close", onClose);
    res.end();
  }

  // ---- accounting
  const body = overflow ? undefined : Buffer.concat(chunks);
  let usage: Usage | null = accumulator.result();
  if (!usage && body && !isSse) {
    try {
      const json = JSON.parse(body.toString("utf8"));
      if (Array.isArray(json)) {
        for (const item of json) accumulator.push(item);
        usage = accumulator.result();
      } else {
        usage = usageFromResponse(usageProtocol, json);
      }
    } catch {
      /* non-JSON body */
    }
  }
  if (!usage && upstream.status < 400 && protocol) usage = estimateUsage(payload, accumulator.generatedText());
  const isStream = isSse || payload?.stream === true;
  record(aborted && !res.writableFinished ? 499 : upstream.status, {
    usage: usage ?? undefined,
    ttfb,
    stream: isStream,
    error: upstream.status >= 400 ? body?.toString("utf8").slice(0, 300) : aborted ? "stream interrupted" : undefined,
  });

  if (cacheKey && body && !aborted && upstream.status === 200 && usage && !usage.estimated) {
    if (body.length <= app.settings.responseCache.maxEntryKb * 1024) {
      app.cache.set(cacheKey, auth.tenant, app.settings.responseCache.ttlSeconds, {
        contentType,
        body,
        usage,
        model: model ?? null,
        provider: provider.preset.id,
      });
    }
  }
}
