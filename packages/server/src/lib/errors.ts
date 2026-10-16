import type { Surface } from "@tokensip/core";

const GEMINI_STATUS: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

/** Build an error body in the same shape the client's SDK expects. */
export function errorBody(surface: Surface, status: number, message: string, type = "tokensip_error"): unknown {
  const text = `[TokenSip] ${message}`;
  if (surface === "anthropic") return { type: "error", error: { type, message: text } };
  if (surface === "gemini")
    return { error: { code: status, message: text, status: GEMINI_STATUS[status] ?? "UNKNOWN" } };
  return { error: { message: text, type, code: type } };
}

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "tokensip_error",
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}
