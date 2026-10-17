# Security Policy

TokenSip sits between your applications and your AI providers, so it handles
API keys and prompts. Security is a core feature, not an afterthought.

## Reporting a vulnerability

**Please do not open a public issue.** Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/IMRX44/tokensip/security/advisories/new).

Include a description, reproduction steps and the affected version. You will get
an acknowledgement within 72 hours and a fix timeline after triage. Credit is
given in the release notes unless you prefer otherwise.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 2.x     | ✅ latest minor |

## Security model

| Area | What TokenSip does |
| --- | --- |
| **Provider keys** | Encrypted at rest with AES-256-GCM. The master key comes from `TOKENSIP_SECRET` or a `master.key` file created with `0600` permissions. Keys are never returned by the API — only a short hint. |
| **Virtual keys** (`tsk_…`) | 192 bits of entropy, stored only as SHA-256 hashes, shown once at creation. Support budgets, rate limits, expiry and provider allow-lists. |
| **Prompts & completions** | Never written to disk or logs. The request log stores metadata only (model, token counts, cost, latency). |
| **Response cache** | On by default for deterministic (`temperature: 0`) requests only. Encrypted at rest with the same AES-256-GCM vault and partitioned per key, so tenants can never read each other's cached answers. |
| **Dashboard auth** | One-time setup token printed to the console (no default password), scrypt password hashing, optional TOTP 2FA, login throttling. |
| **Sessions** | Random 256-bit tokens stored hashed, `HttpOnly` + `SameSite=Strict` cookies (`Secure` over HTTPS), CSRF token + `Origin` check on every state-changing request. |
| **Browser hardening** | Strict CSP (`script-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `nosniff`, `no-referrer`, HSTS in server mode. Fonts are self-hosted — the dashboard makes no third-party requests. |
| **Network** | Binds to `127.0.0.1` by default. Server mode disables provider-key passthrough. Upstream requests use an allow-list of forwarded headers; cookies and client auth headers are never forwarded to providers. Access logs are disabled because URLs may carry Gemini `?key=` credentials. |
| **Containers** | Runs as a non-root user, works with a read-only root filesystem and `cap_drop: ALL`. |
| **Audit** | Logins, key and provider changes and settings updates are recorded in an audit log. |

## Hardening checklist for public deployments

1. Set `TOKENSIP_MODE=server` and a strong `TOKENSIP_SECRET` (`openssl rand -hex 32`). Back the secret up — without it, stored keys cannot be decrypted.
2. Terminate TLS in a reverse proxy (Caddy, nginx, Traefik) and set `TOKENSIP_TRUST_PROXY=true`.
3. Enable 2FA for the dashboard.
4. Give every app its own virtual key with a budget and rate limit.
5. Keep `TOKENSIP_ALLOW_PASSTHROUGH=false` unless every client is trusted.
