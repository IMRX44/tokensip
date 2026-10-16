# Contributing to TokenSip

Thanks for helping make AI cheaper for everyone! Contributions of all sizes are
welcome — bug reports, provider presets, optimizer ideas, translations and docs.

## Development setup

Requires **Node.js ≥ 22.13** (TokenSip uses the built-in `node:sqlite`).

```bash
git clone https://github.com/IMRX44/tokensip.git
cd tokensip
npm install
npm run build          # core → web dashboard → server
npm test               # unit + end-to-end tests against a mock provider
node packages/server/dist/cli.js demo   # dashboard with synthetic data
```

For dashboard work, run the gateway and Vite side by side:

```bash
npm run dev            # gateway on :8787
npm run dev:web        # dashboard on :5173 with hot reload (proxies /api to :8787)
```

| Command | What it does |
| --- | --- |
| `npm run lint` / `npm run format` | Biome lint / auto-format |
| `npm run typecheck` | TypeScript in all packages |
| `npm test` | Unit, integration and property-based tests |
| `npm run test:e2e` | Dashboard tests in Chromium (`npm run build` and `npx playwright install chromium` first) |
| `npm run test:live` | Official SDKs against a real provider — set `TOKENSIP_LIVE_BASE_URL`, `TOKENSIP_LIVE_API_KEY` (and optionally `TOKENSIP_LIVE_ANTHROPIC_BASE_URL`) |
| `npm run bench` | Added latency and throughput per profile |

## Repository layout

```
packages/
  core/     @tokensip/core — optimizer pipeline, protocol adapters, pricing, usage parsing (no HTTP)
  server/   tokensip — Fastify gateway, vault, admin API, CLI
  web/      dashboard (React + Vite, no UI framework), i18n in src/i18n
docs/       architecture, optimizations, deployment, configuration
examples/   request fixtures, SDK snippets, deployment configs
```

## Writing an optimizer stage

Stages live in `packages/core/src/optimizers`. Every stage **must**:

1. **Declare its safety class** honestly — `lossless`, `equivalent` or `lossy`.
   Only `lossless` stages may join the `safe` profile.
2. **Be deterministic and prefix-stable.** The rewrite of message *i* may only
   depend on messages *0…i*. Otherwise provider prompt caches stop hitting and
   the "optimization" costs money.
3. **Never touch assistant turns.** They can carry signed reasoning blocks.
   Work through `ctx.adapter.slots()`, which only exposes system, user and tool-result text.
4. **Never edit tool results in a lossless stage.** Agents edit files with exact
   string matching; reformatting what they read breaks their edits.
5. Come with tests, including a prefix-stability test.

## Adding a provider

Add a preset to `packages/core/src/providers.ts` (base URLs per wire format,
auth style, model-name patterns) and, if it has a well-known key variable, map
it in `ENV_PROVIDER_KEYS` in `packages/server/src/config.ts`. Prices go in
`packages/core/src/pricing.ts`.

## Translations

UI strings live in `packages/web/src/i18n`. `en.ts` is the source of truth and
every other dictionary is type-checked against it, so a missing key fails the
build. Native-speaker improvements are very welcome.

## Pull requests

- Keep PRs focused; one feature or fix per PR.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).
- Make sure `npm run lint && npm run build && npm run typecheck && npm test` passes.
- Never commit API keys, real prompts or personal data — fixtures should be synthetic.
