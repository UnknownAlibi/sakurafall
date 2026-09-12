# SakuraFall Server Operations

## Production layout

- SSH alias: `sakurafall`
- Application: `/opt/sakurafall/server`
- Immutable releases: `/opt/sakurafall/releases/<timestamp>/server`
- Runtime data and caches: `/var/lib/sakurafall`
- Update artifacts: `/var/lib/sakurafall/releases`
- Environment: `/etc/sakurafall/server.env`
- TLS certificate: `/etc/sakurafall/tls/server.crt`
- TLS private key: `/etc/sakurafall/tls/server.key`
- systemd unit: `sakurafall.service`
- Public service: `https://47.109.87.3:8443`

The service owns port `8443`. Ports `80` and `443` intentionally remain free
for the future static site and shared web gateway.

## Deploy a server update

Run from the repository root on the development PC:

```powershell
powershell -ExecutionPolicy Bypass -File server/deploy/deploy.ps1
```

The script uploads a timestamped release, atomically updates the active
symlink, restarts systemd, and verifies the public health endpoint. It does not
change runtime data, TLS files, or the environment file.

## Client update distribution

Clients check `GET /updates/latest.json` on this server first (GitHub raw is
the fallback). The one-command client release (`npm run release`) therefore
also syncs the installer and a server-local `latest.json` (whose `downloadUrl`
points at `GET /downloads/<installer>` on this server) via SSH alias
`sakurafall` into `/var/lib/sakurafall/releases`, then verifies both over the
public endpoint. A failed sync only warns — GitHub remains a usable source,
and the manual catch-up is:

```powershell
scp dist-app/SakuraFall-Setup-<version>.exe sakurafall:/var/lib/sakurafall/releases/
# plus a latest.json whose downloadUrl is https://47.109.87.3:8443/downloads/SakuraFall-Setup-<version>.exe
```

Old installers in `/var/lib/sakurafall/releases` can be pruned once no
`minRequiredVersion` still needs them.

## Routine checks

```bash
systemctl status sakurafall --no-pager
journalctl -u sakurafall -n 100 --no-pager
curl -fsS https://47.109.87.3:8443/health
ss -lntup
```

## Catalog snapshot seeding

When the ECS cannot reach public Bangumi mirrors, build the snapshot on a development PC
with working metadata access and upload only the generated data file:

```powershell
npm run build:catalog-snapshot
scp artifacts/catalog-snapshot.json sakurafall:/var/lib/sakurafall/catalog-snapshot.json.next
ssh sakurafall "mv /var/lib/sakurafall/catalog-snapshot.json.next /var/lib/sakurafall/catalog-snapshot.json && systemctl restart sakurafall"
```

Page checkpoints are kept in `artifacts/catalog-snapshot.json.pages` for 24 hours,
so rerunning an interrupted build resumes completed requests. A successful build
replaces the snapshot atomically; an incomplete build does not replace it.

The desktop imports the initial snapshot in batches of 200, yielding between batches,
then requests deltas every six hours. Failed imports retain the previous cursor.
After an initial catalog scan is imported, filters and ordering use the same local
index, including empty results. A missing server or snapshot never deletes the
client's existing local index. Remote deletions are not reconciled by this version;
catalog snapshots merge metadata and are not an authoritative deletion feed.

## TLS renewal

The current endpoint uses a trusted short-lived Let's Encrypt IP certificate.
IP certificates intentionally have a short lifetime. Direct ACME traffic from
this ECS host currently stalls at the Let's Encrypt Cloudflare endpoint. The
development PC therefore supplies a temporary reverse SOCKS tunnel only while
the renewal check runs.

Install the local renewal task once:

```powershell
powershell -ExecutionPolicy Bypass -File server/deploy/install-renewal-task.ps1
```

It runs at logon and daily, uses the `sakurafall` SSH alias, renews only when
Let's Encrypt says the certificate is due, restarts the service, verifies the
health endpoint, and then closes the tunnel. The PC must be online at least
once during the certificate renewal window.

The preferred long-term setup, after a production domain is ready, is:

1. Add a DNS `A` record for the API hostname pointing to the service IP.
2. Issue a DNS-validated certificate for that hostname. DNS validation does
   not consume ports `80` or `443`.
3. Put the certificate and unencrypted private key in
   `/etc/sakurafall/tls/server.crt` and `/etc/sakurafall/tls/server.key`.
4. Set `SAKURAFALL_PUBLIC_BASE_URL=https://api.example.com:8443` in
   `/etc/sakurafall/server.env` and restart `sakurafall.service`.
5. Change `DEFAULT_SERVICE_BASE_URL` in the desktop application after the new
   hostname passes a public TLS health check. A valid certificate alone is not
   enough: on this mainland ECS host, an unfiled domain is currently reset
   before the application receives the public TLS connection.

Until that migration is complete, check expiry with:

```bash
openssl x509 -in /etc/sakurafall/tls/server.crt -noout -dates
```
