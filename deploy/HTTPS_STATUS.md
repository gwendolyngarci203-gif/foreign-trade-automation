# HTTPS production status

Last verified: 2026-08-20

## Active entry point

- Canonical service URL: `https://ops.dakingscc.cn/`
- DNS: `ops.dakingscc.cn` A record resolves to `39.106.182.40`.
- HTTP: port 80 permanently redirects to HTTPS.
- HTTPS: a trusted Let's Encrypt certificate is deployed through Nginx.
- Certificate validity: through 2026-11-08. Certbot's scheduled renewal task is enabled.
- Access boundary: the application remains protected by Nginx Basic Auth. A `401 Authorization Required` response without the internal operations credentials is expected and healthy.
- Frontend routing: browser assets and API requests use same-origin relative paths, so no frontend URL rewrite is required for the production hostname.

## Verification and maintenance

Run only from the project directory on the shared server:

```bash
cd /opt/dakings-prospect-ops/deploy
./assert-isolation.sh
certbot certificates
certbot renew --dry-run
nginx -t && systemctl reload nginx.service
curl -I https://ops.dakingscc.cn/
```

The final command is expected to return `401` before valid internal Basic Auth credentials are supplied. Do not remove Basic Auth to make the check return `200`.

From the authorized Windows workstation, `deploy/one-click-deploy.ps1` runs the local checks, existing atomic server deployment, server health checks, and this final domain-boundary check in one command.

The server-side health check is the hard deployment gate. The current Windows network path can return HTTP 403 or reset HTTPS before Basic Auth; the one-click script reports that workstation result as a warning because the same deployment has already verified Nginx, loopback-only port 4173, and unauthenticated HTTPS 401 on the server. Use `-RequireWorkstationPublic401` only on a network path known to reach the domain normally.

## Explicit boundaries

- This HTTPS deployment did not change root-domain DNS, MX, SPF, NS, or historical email records.
- Certificate notifications are registered outside the repository; no notification address is recorded here.
- HTTPS readiness is independent of outbound email readiness. `EMAIL_SENDING_ENABLED=false` and `EMAIL_ALLOW_UNVERIFIED=false` remain required until a verified email service and sending-domain workflow are approved.
- The shared server boundary remains `/opt/dakings-prospect-ops` only. Run `./assert-isolation.sh` before every project-side deployment or maintenance action.
