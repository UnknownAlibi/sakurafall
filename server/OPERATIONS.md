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

## Routine checks

```bash
systemctl status sakurafall --no-pager
journalctl -u sakurafall -n 100 --no-pager
curl -fsS https://47.109.87.3:8443/health
ss -lntup
```

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
