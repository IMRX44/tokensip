# @tokensip/core

The optimization engine behind [TokenSip](https://github.com/IMRX44/tokensip) —
prefix-stable, lossless-first prompt optimizers for **OpenAI Chat**, **OpenAI
Responses**, **Anthropic Messages** and **Gemini** payloads, plus usage parsing,
pricing and a provider catalog. No HTTP server, no native dependencies.

```bash
npm install @tokensip/core
```

## Optimize in-process (drop-in `fetch`)

```ts
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createTokenSipFetch } from "@tokensip/core";

const fetch = createTokenSipFetch({
  profile: "balanced", // off | safe | balanced | aggressive | extreme
  onReport: (r) => console.log(`${r.tokensBefore} → ${r.tokensAfter} tokens`),
});

const openai = new OpenAI({ fetch });
const anthropic = new Anthropic({ fetch });
```

## Optimize a payload directly

```ts
import { optimize } from "@tokensip/core";

const { payload, report } = optimize(requestBody, {
  protocol: "anthropic", // "openai-chat" | "openai-responses" | "anthropic" | "gemini"
  profile: "safe",
});

report.tokensSaved; // estimated prompt tokens removed
report.lossy;       // true if a lossy stage changed the request
report.stages;      // per-stage breakdown
```

The input is never mutated, assistant turns are never edited, and every stage
is deterministic and prefix-stable so provider prompt caches keep hitting.

## Usage & cost accounting

```ts
import { PriceBook, usageFromResponse, StreamUsageAccumulator } from "@tokensip/core";

const usage = usageFromResponse("openai-chat", responseJson);
const cost = new PriceBook().cost("gpt-4.1", usage);
// { actual, baseline, saved, priced }
```

See the [optimization guide](https://github.com/IMRX44/tokensip/blob/main/docs/optimizations.md)
for every stage and profile. MIT licensed.
