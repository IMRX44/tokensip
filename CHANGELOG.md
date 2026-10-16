# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/IMRX44/tokensip/releases/tag/v0.1.0
