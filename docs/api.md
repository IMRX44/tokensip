# HTTP API

## Proxy endpoints

| Endpoint | Format | Routing |
| --- | --- | --- |
| `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models` | OpenAI | by model name, `x-tokensip-provider`, or default provider |
| `/v1/messages`, `/v1/messages/count_tokens` | Anthropic | by model name |
| `/v1beta/models/{model}:generateContent` (and `:streamGenerateContent`) | Gemini | Google |
| `/{provider}/v1/...` | OpenAI format | that provider |
| `/anthropic/v1/messages` | Anthropic | Anthropic |
| `/google/v1beta/...` | Gemini | Google |
| `/{provider}/v1/messages` | Anthropic format | providers that offer it (DeepSeek, Kimi, GLM) |
| `/p/{provider-or-record-id}/...` | any | explicit provider record |

Provider ids: `openai`, `anthropic`, `google`, `azure-openai`, `deepseek`,
`mistral`, `xai`, `groq`, `openrouter`, `together`, `fireworks`, `cerebras`,
`perplexity`, `cohere`, `moonshot`, `zai`, `qwen`, `ollama`, `lmstudio`,
`vllm`, `custom`.

Authentication: `Authorization: Bearer <key>`, `x-api-key: <key>`,
`x-goog-api-key: <key>` or `?key=<key>` — whatever your SDK sends. Errors come
back in the error format of the SDK you are using.

## Admin API

Used by the dashboard; requires a session cookie and, for state-changing
calls, the `x-csrf-token` header returned by `GET /api/auth/state`.

| Method & path | Purpose |
| --- | --- |
| `GET /api/auth/state` | Setup / session state and CSRF token |
| `POST /api/auth/setup` · `login` · `logout` · `password` | Authentication |
| `POST /api/auth/totp/begin` · `enable` · `disable` | Two-factor authentication |
| `GET /api/catalog` | Providers, stages, profiles, defaults |
| `GET /api/overview?range=24h\|7d\|30d\|90d` | Savings analytics, cache efficiency and Cache Doctor findings |
| `GET /api/sessions?range=24h\|7d\|30d\|90d` | Agent conversations: turns, cache-read share, outdated output removed, leaks, scheduler decisions |
| `GET /api/sessions/:id` | One conversation turn by turn (cached vs. uncached tokens, leak, `applied`/`deferred`) |
| `GET /api/requests?limit&before&status&provider&keyId` | Request log (metadata only) |
| `GET/POST /api/providers`, `PATCH/DELETE /api/providers/:id`, `POST /api/providers/:id/test` | Provider keys |
| `GET/POST /api/keys`, `PATCH/DELETE /api/keys/:id` | Virtual keys |
| `GET/PUT /api/settings` | Profile, stage overrides, cache, routing |
| `GET /api/pricing`, `PUT/DELETE /api/pricing/:model` | Price overrides (USD per 1M tokens) |
| `POST /api/optimize` | Dry-run the optimizer on a payload |
| `GET/DELETE /api/cache` | Response cache stats / clear |
| `GET /api/audit` | Audit log |
