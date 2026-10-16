# Deployment

## Local (developer machine)

```bash
npx tokensip            # http://localhost:8787
```

Local mode binds to `127.0.0.1`, accepts your own provider keys (passthrough)
and stores data in `~/.tokensip`.

## Docker

```bash
docker run -d --name tokensip -p 127.0.0.1:8787:8787 \
  -e TOKENSIP_SECRET="$(openssl rand -hex 32)" \
  -e TOKENSIP_ADMIN_PASSWORD="choose-a-long-passphrase" \
  -v tokensip-data:/data \
  ghcr.io/imrx44/tokensip:latest
```

The image runs as a non-root user, works with `--read-only --tmpfs /tmp
--cap-drop ALL`, ships a `HEALTHCHECK`, and defaults to **server mode**.

## Docker Compose

```bash
cp .env.example .env      # set TOKENSIP_SECRET and TOKENSIP_ADMIN_PASSWORD
docker compose up -d
```

See [`docker-compose.yml`](../docker-compose.yml) — it is already hardened
(read-only root filesystem, no capabilities, `no-new-privileges`).

## Behind a reverse proxy (TLS)

Set `TOKENSIP_TRUST_PROXY=true` and use one of the ready-made configs:

- [Caddy](../examples/deploy/Caddyfile) — automatic HTTPS
- [nginx](../examples/deploy/nginx.conf) — remember `proxy_buffering off` for streaming

## systemd

[`examples/deploy/tokensip.service`](../examples/deploy/tokensip.service) runs
TokenSip as an unprivileged, sandboxed service.

## Kubernetes

[`examples/deploy/kubernetes.yaml`](../examples/deploy/kubernetes.yaml) — single
replica with a PersistentVolume (SQLite is single-writer; scale vertically).

## Backups

Everything lives in the data directory:

| File | Contents |
| --- | --- |
| `tokensip.db` (+ `-wal`, `-shm`) | Settings, providers (encrypted keys), virtual keys (hashed), request metadata, encrypted cache |
| `master.key` | Only when `TOKENSIP_SECRET` is not set |

Back up the database **and** the master key/secret. Without the key, stored
provider keys and cached responses cannot be decrypted — TokenSip refuses to
start with a mismatched key instead of silently corrupting data.

## Monitoring

- `GET /healthz` — liveness, `GET /readyz` — database check
- `GET /metrics` — Prometheus counters (requests, tokens, trimmed tokens,
  cache reads, cost, baseline cost); set `TOKENSIP_METRICS_TOKEN`.
