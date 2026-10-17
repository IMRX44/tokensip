# Integrations

TokenSip is a drop-in base URL. Replace `http://localhost:8787` with your own
deployment and use a TokenSip key (`tsk_…`) — or, with passthrough enabled,
your normal provider key.

## Coding agents

**Claude Code**
```bash
export ANTHROPIC_BASE_URL=http://localhost:8787/anthropic
claude          # keeps your existing login or ANTHROPIC_API_KEY (passthrough)
```
Claude Code already manages prompt caching, so `safe` leaves its cache
breakpoints alone; `balanced` (the default) adds Cache Doctor repairs, cache-scheduled
removal of outdated tool output and tool-output dedupe. JSON minification is in `aggressive`.

**OpenAI Codex CLI** — `~/.codex/config.toml`
```toml
model_provider = "tokensip"

[model_providers.tokensip]
name = "TokenSip"
base_url = "http://localhost:8787/openai/v1"
env_key = "TOKENSIP_API_KEY"
wire_api = "responses"
```

**Gemini CLI**
```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:8787/google
```

**Aider**
```bash
aider --openai-api-base http://localhost:8787/v1 --openai-api-key tsk_... --model openai/gpt-4.1
```

**Cline / Roo Code / Kilo Code** — provider *OpenAI Compatible*, base URL
`http://localhost:8787/v1`, any model id (TokenSip routes by name).

**Continue** — `provider: openai`, `apiBase: http://localhost:8787/v1`.

## SDKs

| SDK | Setting |
| --- | --- |
| OpenAI (Python / Node / .NET / Go / Java) | `base_url="http://localhost:8787/v1"` |
| Anthropic (Python / TS) | `base_url="http://localhost:8787/anthropic"` |
| Google GenAI | `http_options={"base_url": "http://localhost:8787/google"}` |
| Vercel AI SDK | `createOpenAI({ baseURL: ".../openai/v1" })`, `createAnthropic({ baseURL: ".../anthropic/v1" })` |
| LangChain / LlamaIndex | `ChatOpenAI(base_url=".../v1")`, `ChatAnthropic(base_url=".../anthropic")` |
| LiteLLM | `api_base=".../v1"` with `openai/<model>` |
| Anything else | env vars `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` |

## In-process (no server)

```ts
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createTokenSipFetch } from "@tokensip/core";

const fetch = createTokenSipFetch({ profile: "balanced" });
const openai = new OpenAI({ fetch });
const anthropic = new Anthropic({ fetch });
```

Or call the optimizer directly:

```ts
import { optimize } from "@tokensip/core";

const { payload, report } = optimize(body, { protocol: "anthropic", profile: "balanced" });
console.log(`${report.tokensBefore} → ${report.tokensAfter} tokens`);
```
