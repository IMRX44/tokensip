import { optimize } from "./pipeline.js";
import { protocolFromPath } from "./protocols/index.js";
import { SessionEngine, type SessionReport } from "./session/engine.js";
import type { OptimizeOptions, OptimizeReport } from "./types.js";

export interface TokenSipFetchOptions extends Omit<OptimizeOptions, "protocol" | "provider" | "model"> {
  /** Underlying fetch implementation. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Called after every optimized request. */
  onReport?: (report: OptimizeReport, info: { url: string; model?: string; session?: SessionReport }) => void;
  /**
   * Track conversations (cache leak detection, cache-economic removal of outdated tool output).
   * Default true. Pass an existing engine to share state between several clients.
   */
  sessions?: boolean | SessionEngine;
}

const HOST_PROVIDERS: [RegExp, string][] = [
  [/(^|\.)api\.openai\.com$/, "openai"],
  [/(^|\.)api\.anthropic\.com$/, "anthropic"],
  [/(^|\.)generativelanguage\.googleapis\.com$/, "google"],
  [/(^|\.)api\.deepseek\.com$/, "deepseek"],
];

function providerFromHost(host: string): string | undefined {
  return HOST_PROVIDERS.find(([re]) => re.test(host))?.[1];
}

/**
 * A drop-in `fetch` that optimizes LLM requests in-process — no proxy needed.
 *
 * ```ts
 * import OpenAI from "openai";
 * import { createTokenSipFetch } from "@tokensip/core";
 * const client = new OpenAI({ fetch: createTokenSipFetch({ profile: "safe" }) });
 * ```
 */
export function createTokenSipFetch(options: TokenSipFetchOptions = {}): typeof fetch {
  const { fetch: baseFetch = globalThis.fetch, onReport, sessions = true, ...optimizeOptions } = options;
  const engine = sessions instanceof SessionEngine ? sessions : sessions ? new SessionEngine() : undefined;

  const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : input instanceof URL ? input.href : String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const protocol = method === "POST" ? protocolFromPath(url.pathname) : undefined;
    if (!protocol) return baseFetch(input, init);

    let bodyText: string | undefined;
    if (typeof init?.body === "string") bodyText = init.body;
    else if (init?.body === undefined && request) bodyText = await request.clone().text();
    if (!bodyText) return baseFetch(input, init);

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return baseFetch(input, init);
    }

    const model =
      parsed && typeof parsed === "object" && typeof (parsed as { model?: unknown }).model === "string"
        ? (parsed as { model: string }).model
        : decodeURIComponent(url.pathname.match(/models\/([^:/]+)/)?.[1] ?? "") || undefined;

    let result: ReturnType<SessionEngine["run"]>;
    try {
      const opts = { ...optimizeOptions, protocol, model, provider: providerFromHost(url.hostname) };
      // Without session tracking, session-aware stages are skipped (never prune blind: it breaks caches).
      result = engine ? engine.run(parsed, opts) : optimize(parsed, opts);
    } catch {
      return baseFetch(input, init); // never let optimization break a request
    }
    onReport?.(result.report, { url: url.href, model, session: result.session });
    if (!result.report.changed) return baseFetch(input, init);

    const body = JSON.stringify(result.payload);
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.delete("content-length");
    if (request && init?.body === undefined) {
      return baseFetch(new Request(request, { body, headers }));
    }
    return baseFetch(input, { ...init, body, headers });
  };
  return wrapped as typeof fetch;
}
