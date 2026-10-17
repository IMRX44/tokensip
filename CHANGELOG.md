# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-10-17

TokenSip 2 introduces the **cache-economic context engine**: context changes
are scheduled against the provider's prompt-cache prices instead of applied
eagerly, cache leaks are detected and repaired automatically, and only tool
output that a newer observation has made outdated is ever removed.
[Read the design](docs/cache-economics.md).

### Added

- **Session engine.** Links stateless API calls into conversations and keeps a
  shadow of the provider's prompt cache (block hashes, TTL), calibrated by the
  cache reads the provider reports. Bounded LRU, in memory, no prompt text stored.
- **`supersede-observations` stage.** When a file is read again, a command
  re-run or a query repeated, the earlier result becomes a tombstone that
  points at the newer call. The latest observation is always kept verbatim.
- **Economic scheduler.** Pending removals are applied when the cache is cold,
  when the region is re-sent anyway, or when `S·r·H ≥ (C−p)·(w−r)`; otherwise
  they are deferred. Applied removals are sticky for the session.
- **Cache Doctor.** Detects values that break the provider cache between turns
  (clocks, ids and counters in the system prompt; tool lists re-ordered or
  re-serialized) and stores only their masked shape. Two repairs:
  `relocate-volatile` and `stabilize-tools`.
- **Dashboard:** a *Sessions* page with a per-turn timeline of cached vs.
  full-price prompt tokens and every leak and scheduler decision; a *Cache
  efficiency* KPI and a *Cache Doctor* card on the overview.
- **`tokensip simulate`** replays synthetic agent sessions under Anthropic
  cache billing and compares no caching, plain caching, naive pruning and
  TokenSip 2 on the same sessions.
- Response headers `x-tokensip-session` and `x-tokensip-cache-leak`; admin API
  `GET /api/sessions` and `GET /api/sessions/:id`.
- `createTokenSipFetch` tracks sessions too (`sessions: false` to opt out).

### Changed

- **`balanced` is the new default profile.** It now contains the session stages
  and tool-output dedupe; JSON minification moved to `aggressive`.
- Every proxied request goes through the session engine, including `off`
  (for analytics). Session tracking costs about 0.4 ms on a 14k-token agent request.

### Performance

- Token counts for savings reports are memoized across turns, and the session
  engine only canonicalizes message blocks that changed since the previous turn.
  Throughput on the 14k-token benchmark (same machine, v1 → v2): `balanced`
  287 → 398 req/s, `aggressive` 289 → 344, `extreme` 210 → 309; p50 overhead at
  concurrency 1 is 1.9–2.8 ms for every profile.

### Fixed

- `tokensip demo` failed with "cannot start a transaction within a transaction":
  the batched request log now flushes inside a savepoint.
- CORS: `x-tokensip-provider` and the new session headers are exposed to browsers.

### Results

Simulator, 12 sessions × 60 turns, against plain caching: **−30.9%** with
idle breaks, **−85.3%** with a clock in the system prompt, **−9.9%** without
breaks — while naive pruning every turn costs +32.9% / +87.2% in the first and
third scenarios. Live, a system prompt with a clock went from ~4% to ~96% of
prompt tokens read from cache.

## [0.1.0] — 2026-10-16

### Added

- **Gateway** with OpenAI Chat Completions, OpenAI Responses, Anthropic Messages
  and Gemini endpoints, auto-routing by model name and per-provider routes for
  20+ providers (`/openai/v1`, `/anthropic`, `/google`, `/deepseek/v1`, …).
- **Optimizer pipeline** with five profiles — `off`, `safe`, `balanced`,
  `aggressive`, `extreme` — and eleven prefix-stable stages, including
  automatic Anthropic prompt-cache breakpoints, OpenAI `prompt_cache_key`
  routing, JSON minification, tool-output deduplication and a context budget
  that compresses prompts to a target ratio (≈10% by default).
- **Byte-exact passthrough** when no optimization applies, streaming with usage
  accounting, and hidden `stream_options.include_usage` chunks.
- **Encrypted response cache** (AES-256-GCM, partitioned per key).
- **Encrypted key vault**, virtual API keys with budgets, rate limits, expiry
  and provider allow-lists.
- **Dashboard** in English, Persian, Russian, Arabic and Chinese with RTL
  support and light/dark themes: savings analytics, request log, optimizer lab,
  providers, keys, integration guides and settings.
- **Security**: one-time setup token, scrypt passwords, TOTP 2FA, CSRF
  protection, strict CSP, audit log.
- **CLI**: `start`, `demo`, `optimize`, `keys`, `reset-password`, `doctor`.
- `@tokensip/core` with `createTokenSipFetch()` for in-process optimization.
- Docker image (non-root, read-only friendly), Prometheus metrics, CI, CodeQL.
- Any provider can expose an Anthropic-compatible endpoint; `TOKENSIP_CUSTOM_*`
  environment variables for OpenAI-compatible gateways and aggregators.
- Model pricing editor with model-family estimates for new model versions.
- Test suites: property-based fuzzing, browser end-to-end, live SDK tests, benchmark.

### Fixed (found by live and browser testing before release)

- Streams are completed at the provider's end-of-stream event; previously a
  provider that kept the connection open after `[DONE]` caused the response to
  be logged as interrupted and never cached.
- Changing the profile or toggling stages in Settings was rejected by validation.
- `gpt-5` list prices no longer apply to `gpt-5-pro` (and similar tiers).
- Compressed request bodies keep their `Content-Encoding`.

### Performance

- ~2× higher throughput for `balanced`/`extreme`: sampled token counting for
  reports, cached lookups, batched request logging, prepared statements.

[2.0.0]: https://github.com/IMRX44/tokensip/releases/tag/v2.0.0
[0.1.0]: https://github.com/IMRX44/tokensip/releases/tag/v0.1.0
