# SakuraFall Service

This directory contains the standalone SakuraFall server. It intentionally does
not include playback providers or user-installed source rules.

## Endpoints

- `GET /health` and `GET /ready`: process and cache health.
- Bangumi-compatible `/calendar`, `/v0/*` and `/subject/:id` routes: shared
  disk cache with stale-while-revalidate fallback.
- `GET /cover?url=...`: allowlisted Bangumi cover cache.
- `GET /updates/latest.json` and `GET /downloads/:file`: release distribution.
- `POST /v1/rooms`, `GET /v1/rooms/:code` and `WSS /ws`: watch-together
  signaling relay. Video bytes never pass through the relay.

The production service listens on `8443`; ports `80` and `443` are reserved for
the future shared web gateway.

Deployment layout, health checks, and TLS maintenance are documented in
[`OPERATIONS.md`](./OPERATIONS.md).

## Local development

```powershell
cd server
$env:SAKURAFALL_DATA_DIR = "$PWD/.data"
npm test
npm start
```
