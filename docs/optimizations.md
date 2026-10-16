# Optimizations & profiles

Every stage has a **safety class**:

| Class | Meaning |
| --- | --- |
| 🟢 **lossless** | The model receives exactly the same information. |
| 🔵 **equivalent** | Same information, different representation (e.g. a pointer to an identical earlier tool result). |
| 🔴 **lossy** | Information is removed. Expect lower quality. Never enabled unless you opt in. |

Hard rules for all stages: deterministic, prefix-stable, never edit assistant
turns (they may carry signed reasoning), never mutate the caller's object.

## Profiles

| Profile | Stages | Prompt sent | Quality risk | Use it for |
| --- | --- | --- | --- | --- |
| `off` | — | 100% | none | Pure proxy: analytics, budgets, response cache |
| `safe` *(default)* | whitespace · Anthropic cache breakpoints · OpenAI cache key | 95–100% | **none** | Everything. Savings come from provider prompt caching. |
| `balanced` | safe + JSON minify · tool-output dedupe | 70–95% | low | Most agents and RAG apps |
| `aggressive` | balanced + stale-tool truncation · history window · low-detail images | 40–70% | medium | Very long agent sessions |
| `extreme` | aggressive + context budget · reduced reasoning · output cap | **≈10%** (configurable) | **high** | Cheap bulk jobs, classification, drafts |

Choose a profile globally (dashboard → Settings), per virtual key, or per
request with `x-tokensip-profile: balanced`. When a lossy stage changes a
request, TokenSip adds an `x-tokensip-warning` response header, flags the
request as *lossy* in the log, and the dashboard asks for confirmation before
enabling `aggressive` or `extreme`.

## Stages

### 🟢 `normalize-whitespace`
Trims trailing spaces and collapses runs of 3+ newlines in **system and user
prose only**. Fenced code blocks and tool results are never touched — coding
agents edit files with exact string matching, so reformatting what they read
would break their edits.

### 🟢 `anthropic-cache-breakpoints`
If the client hasn't set any `cache_control`, adds `ephemeral` breakpoints on
the last tool, the system prompt and the latest user turn (plus an older one in
long tool loops to stay inside Anthropic's 20-block lookback). Cached reads
cost 10% of the input price. Skipped below the cacheable minimum (≈1,024
tokens) and whenever the client manages caching itself (e.g. Claude Code).

### 🟢 `openai-prompt-cache-key`
On `api.openai.com`, sets a stable `prompt_cache_key` derived from the model,
tools and system prompt (salted per key), so requests sharing a prefix land on
the same cache shard. Never sent to other providers.

### 🔵 `minify-json`
Removes pretty-printing whitespace from tool results that are pure JSON. Uses a
scanner, not `JSON.parse`/`stringify`, so big integers and float formatting are
preserved byte-for-byte.

### 🔵 `dedupe-tool-results`
When a tool result is byte-identical to an earlier one (agents re-reading the
same file), the *later* copy becomes a short pointer. Earlier messages are never
changed, which keeps the prefix cacheable.

### 🔴 `truncate-stale-tool-results`
Tool outputs the agent has moved past (followed by ≥ `keepRecentSteps`
assistant steps) are cut to their head and tail with an explicit
`[TokenSip: ~N tokens … omitted]` marker.

### 🔴 `history-window`
Keeps system messages, the first user turn (the task) and the newest messages.
The cut always lands at the start of an assistant step, so tool calls stay
paired with their results.

### 🔴 `image-detail-low`
Requests `detail: "low"` for OpenAI image inputs (≈85 tokens per image).

### 🔴 `context-budget`
Compresses the prompt toward `targetRatio` × its original size (default 0.1):

1. head/tail-truncate older tool results,
2. compact prose whitespace,
3. truncate every text proportionally (newest message weighted 2×),
4. only if still over budget, drop the middle of the conversation.

### 🔴 `reduce-reasoning`
Lowers `reasoning_effort` / `reasoning.effort` and caps Anthropic and Gemini
thinking budgets. Reasoning tokens are billed as output.

### 🔴 `cap-output`
Caps `max_tokens` / `max_completion_tokens` / `max_output_tokens` (keeps
Anthropic's `max_tokens > budget_tokens` invariant).

## Measured on real agent transcripts

Synthetic but realistic coding-agent requests in
[`examples/requests`](../examples/requests); reproduce with
`npx tokensip optimize <file> --profile <profile>`:

| Request | safe | balanced | extreme |
| --- | --- | --- | --- |
| `agent-openai.json` (14.1k tokens) | −0.1% + cache key | **−48.5%** | **−90.8%** |
| `agent-anthropic.json` (5.3k tokens) | −0.3% + 4 cache breakpoints | **−42.2%** | **−89.1%** |

`safe` barely shrinks the prompt — its job is to make the provider bill the
repeated part at 10–50% of the price.

## Tuning

Dashboard → Settings → *Lossy tuning*, or `PUT /api/settings`:

| Option | Default | Used by |
| --- | --- | --- |
| `targetRatio` | `0.1` | context-budget |
| `minBudgetTokens` | `512` | context-budget |
| `maxOutputTokens` | `1024` | cap-output |
| `reasoningEffort` | `low` | reduce-reasoning |
| `maxThinkingTokens` | `1024` | reduce-reasoning |
| `keepRecentSteps` | `8` | truncate-stale-tool-results |
| `maxStaleToolTokens` | `2000` | truncate-stale-tool-results |
| `maxMessages` | `60` | history-window |
| `dedupeMinTokens` | `200` | dedupe-tool-results |
| `minCacheableTokens` | `1024` | anthropic-cache-breakpoints |
