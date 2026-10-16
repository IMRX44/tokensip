## What does this change?

<!-- A short description and the motivation. Link related issues with "Closes #123". -->

## Type

- [ ] Bug fix
- [ ] New optimizer stage (state its safety class: lossless / equivalent / lossy)
- [ ] New provider preset
- [ ] Dashboard / i18n
- [ ] Docs
- [ ] Other

## Checklist

- [ ] `npm run lint`, `npm run build`, `npm run typecheck` and `npm test` pass
- [ ] New optimizer stages are deterministic and prefix-stable, and never edit assistant turns
- [ ] New UI strings are added to **all five** dictionaries (en, fa, ru, ar, zh)
- [ ] No secrets, prompts or personal data in logs, tests or fixtures
