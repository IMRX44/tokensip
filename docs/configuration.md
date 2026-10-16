# Configuration

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `TOKENSIP_MODE` | `local` | `server` hardens defaults: binds `0.0.0.0`, disables key passthrough, enables HSTS |
| `TOKENSIP_HOST` | `127.0.0.1` (`0.0.0.0` in server mode) | Bind address |
| `TOKENSIP_PORT` / `PORT` | `8787` | Port |
| `TOKENSIP_DATA_DIR` | `~/.tokensip` (`/data` in Docker) | SQLite database and generated master key |
| `TOKENSIP_SECRET` | generated `master.key` | Master key: 64 hex chars, or any passphrase (stretched with scrypt) |
| `TOKENSIP_ADMIN_PASSWORD` | — | Bootstrap admin password; otherwise a one-time setup token is printed |
| `TOKENSIP_PROFILE` | `safe` | Initial optimization profile |
| `TOKENSIP_ALLOW_PASSTHROUGH` | `true` local / `false` server | Accept provider keys from clients |
| `TOKENSIP_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` (behind a reverse proxy) |
| `TOKENSIP_CORS_ORIGINS` | — | Comma-separated origins allowed to call the proxy from browsers (`*` for any) |
| `TOKENSIP_METRICS_TOKEN` | — | Enables `GET /metrics` (Prometheus) with this bearer token |
| `TOKENSIP_BODY_LIMIT_MB` | `50` | Max request body |
| `TOKENSIP_UPSTREAM_TIMEOUT_MS` | `600000` | Upstream timeout (long agent turns) |
| `TOKENSIP_DASHBOARD` | `true` | Serve the dashboard |
| `TOKENSIP_LOG_LEVEL` | `info` (`warn` for the CLI) | `fatal` … `trace`, `silent` |

**Provider keys from the environment** are picked up automatically as
read-only providers: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` /
`GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`,
`GROQ_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`,
`CEREBRAS_API_KEY`, `PERPLEXITY_API_KEY`, `COHERE_API_KEY`, `MOONSHOT_API_KEY`,
`ZAI_API_KEY`, `DASHSCOPE_API_KEY`.

## CLI

```text
tokensip [start] [options]          Start the gateway and dashboard
tokensip demo                       Dashboard with synthetic traffic (no keys needed)
tokensip optimize <file.json>       Optimize a request body offline and print the report
tokensip keys create --name <name>  Create a virtual API key  [--profile] [--budget] [--rpm]
tokensip keys list                  List virtual API keys
tokensip reset-password             New admin password (disables 2FA, signs out sessions)
tokensip doctor                     Check your environment
tokensip version

  -p, --port <port>   -H, --host <host>   -d, --data-dir <dir>
  -m, --mode <local|server>   --profile <profile>   --no-dashboard
```

## Per-request headers

| Header | Values | Effect |
| --- | --- | --- |
| `x-tokensip-profile` | `off` `safe` `balanced` `aggressive` `extreme` | Override the profile for one request (can be disabled in settings) |
| `x-tokensip-cache` | `bypass` · `force` | Skip the response cache, or cache even non-deterministic requests |
| `x-tokensip-provider` | provider id | Force a provider on the auto-routed `/v1` endpoints |

## Response headers

| Header | Meaning |
| --- | --- |
| `x-tokensip-request-id` | ID of the request in the dashboard log |
| `x-tokensip-provider` | Provider the request was routed to |
| `x-tokensip-profile` | Profile that was applied |
| `x-tokensip-tokens-saved` | Prompt tokens removed by optimizers |
| `x-tokensip-cache` | `HIT`, `MISS` or `BYPASS` |
| `x-tokensip-warning` | Present when a lossy stage changed the request |
