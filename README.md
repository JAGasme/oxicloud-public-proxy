> **Fork note (JAGasme):** this branch ports the proxy to OxiCloud >= 0.9.1,
> which removed the `/api/s/{token}/download|contents|file|zip` endpoints. The
> proxy now opens the share via `/api/s/{token}` (the "share ring" login),
> keeps the ring server-side, and reads through the normal
> `/api/folders/*` and `/api/files/*` routes that OxiCloud allowlists for
> anonymous share sessions. Requires OxiCloud >= 0.9.1; it does not work
> against 0.8.x/0.9.0.

<p align="center">
  <img src="docs/logo.png" alt="OxiCloud" width="120" />
</p>

<h1 align="center">oxicloud-public-proxy</h1>

<p align="center">
  Public reverse proxy for <a href="https://github.com/AtalayaLabs/OxiCloud">OxiCloud</a> share links.
</p>

<p align="center">
  <a href="https://github.com/JAGasme/oxicloud-public-proxy/actions/workflows/ci.yml"><img src="https://github.com/JAGasme/oxicloud-public-proxy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/JAGasme/oxicloud-public-proxy/actions/workflows/codeql.yml"><img src="https://github.com/JAGasme/oxicloud-public-proxy/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <a href="https://github.com/JAGasme/oxicloud-public-proxy/releases"><img src="https://img.shields.io/github/v/release/JAGasme/oxicloud-public-proxy?include_prereleases" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/JAGasme/oxicloud-public-proxy" alt="MIT License" /></a>
</p>

---

## Compatibility

| Proxy | OxiCloud |
|---|---|
| `2.x` (this fork; formerly tagged `1.0.0-oxi091.*`) | **0.9.1** or newer. Does not work against 0.8.x/0.9.0 |
| [upstream](https://github.com/abnvle/oxicloud-public-proxy) `1.0.0` | 0.6.0 "Open Skies" up to 0.9.0 |

All features (file shares, password-protected shares, folder browsing and
ZIP downloads) work on the supported OxiCloud versions.

## Container image

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR on
every release, with an SBOM, build provenance and a cosign signature:

```bash
docker pull ghcr.io/jagasme/oxicloud-public-proxy:2.0.0
```

Tags: the full version (`2.0.0`), plus `2.0` and `2`, which move to the
newest release in that line. There is no `latest` tag.
Pin by digest for reproducible deploys; each
[release](https://github.com/JAGasme/oxicloud-public-proxy/releases) lists the
digest and the `cosign verify` command.

---

## Overview

A small Node.js service that sits between the public internet and a private
OxiCloud instance. The only thing it exposes is the share-link URLs
(`/share/<token>`); your file browser, admin panel, and authentication stay
unreachable from outside.

When someone opens a share link on your public hostname, the proxy:

1. Calls OxiCloud's public share API on the private network.
2. Renders the result with a templated HTML view (file metadata, password
   prompt, folder gallery, expired notice).
3. Streams file downloads through, forwarding `Range`, `ETag` and
   `Set-Cookie` headers so video seek, resumable downloads, and password
   sessions work the same as on the upstream.

The proxy holds no OxiCloud credentials. Authorization is the share token
only, the same as opening a share directly on an exposed OxiCloud.

## Demo

A live instance is running at [oxi-demo.evtlab.pl](https://oxi-demo.evtlab.pl).

- Example share: <https://oxi-demo.evtlab.pl/share/6bb56212-e582-4fa5-989d-742562ad7520>
- Password: `demo123`

> **Note:** The demo runs against OxiCloud 0.6.0, so all features are available.

## Features

- File shares, with or without a password
- Folder shares with full in-browser browsing
  - Grid or list view, persisted per-browser
  - Image thumbnails, lazy-loaded video posters
  - Click-to-open lightbox with keyboard navigation
  - File-type icons (PDF, archive, code, fonts, ...)
  - Subfolder navigation with browser back support
- ZIP download for any folder in the share, root or subfolder
- `Range` / `ETag` passed through, so video seek and resumable downloads work
- English and Polish UI, picked from `Accept-Language`, override with `?lang=`
- A small landing page at `/` if someone hits the root

## Requirements

- Docker (for the recommended deployment)
- A reverse proxy in front for TLS (nginx, Traefik, Nginx Proxy Manager,
  Caddy, ...)
- An OxiCloud instance reachable from the proxy. A Docker service name, a
  LAN address, or a VPN address all work, as long as the proxy can call it

For local development without Docker: Node 22+ and `npm`.

## Quick start

```bash
git clone https://github.com/JAGasme/oxicloud-public-proxy.git
cd oxicloud-public-proxy
cp .env.example .env
# edit .env, set OXICLOUD_INTERNAL_URL and PUBLIC_BASE_URL
docker compose up -d            # pulls the published GHCR image
```

To build from the checkout instead (tagged `oxicloud-public-proxy:local`):

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Point your reverse proxy at `localhost:3000` and route your public hostname
there. The proxy itself does not terminate TLS.

## Configuration

| Variable | Default | Required | Notes |
|---|---|---|---|
| `OXICLOUD_INTERNAL_URL` | | yes | URL of OxiCloud reachable from the proxy. A Docker service name like `http://oxicloud:8086` or a LAN address like `http://192.168.0.205:8086`. |
| `PUBLIC_BASE_URL` | | yes | The public URL the proxy is served from, e.g. `https://files.example.com`. |
| `PORT` | `3000` | no | TCP port. Used for both the host port mapping in `docker-compose.yml` and the in-container listener, so they stay in sync. |
| `HOST` | `0.0.0.0` | no | Bind address. Default is right for containers. |
| `LOG_LEVEL` | `info` | no | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `HSTS_MAX_AGE` | `31536000` | no | `Strict-Transport-Security` max-age in seconds, sent only on HTTPS requests (per `X-Forwarded-Proto`). `0` disables it, e.g. if your reverse proxy already sets HSTS. |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | no | Addresses (IPs, CIDRs, or the names `loopback`, `linklocal`, `uniquelocal`) whose `X-Forwarded-For`/`-Proto`/`-Host` are believed. The default covers a reverse proxy on the same host, a Docker network or a LAN/VPN. `false` trusts none; `true` trusts every hop, which lets any client pick its own IP. See [Client IPs and rate limits](#client-ips-and-rate-limits). |
| `CLIENT_IP_HEADER` | | no | A header your front proxy always sets to the visitor's IP, e.g. `cf-connecting-ip` behind Cloudflare. Only read on requests that came through a `TRUST_PROXY` address. |
| `AUTH_RATE_LIMIT_PER_IP` | `5` | no | Failed password attempts per client (IPv6: per /64) per window. `0` disables. |
| `AUTH_RATE_LIMIT_PER_TOKEN` | `10` | no | Failed password attempts per share, from all clients together, per window. `0` disables. |
| `AUTH_RATE_LIMIT_WINDOW_SECS` | `60` | no | Window for the two limits above. |
| `UPSTREAM_VERIFY_MAX` | `8` | no | Password checks the proxy sends OxiCloud per OxiCloud rate-limit key before OxiCloud's window can reset. Keep it below `OXICLOUD_RATE_LIMIT_LOGIN_MAX` (default 10). `0` disables. |
| `UPSTREAM_VERIFY_WINDOW_SECS` | `60` | no | Set to OxiCloud's `OXICLOUD_RATE_LIMIT_LOGIN_WINDOW_SECS`. |
| `AUTH_MAX_CONCURRENT` | `16` | no | Password checks waiting on OxiCloud at once, from all clients together; more get `429` with `Retry-After: 1`. Each check is also cut off after 10 s. `0` disables the cap. |
| `UPSTREAM_FORWARD_CLIENT_IP` | `false` | no | Send the visitor's IP (as resolved above, never the visitor's own header) to OxiCloud as `X-Forwarded-For` on password checks. Enable only together with `OXICLOUD_TRUST_PROXY_CIDR` on OxiCloud; see below. |

See `.env.example` for a copy-and-edit starting point.

### OxiCloud side

Set `OXICLOUD_BASE_URL` on your OxiCloud instance to the proxy's public URL,
so share links generated in the OxiCloud UI point at the proxy:

```
OXICLOUD_BASE_URL=https://files.example.com
```

OxiCloud generates `/s/<token>` URLs; the proxy serves the canonical
`/share/<token>` path and redirects `/s/<token>` to it, so links copied
from OxiCloud work as-is.

### Client IPs and rate limits

OxiCloud rate-limits `POST /api/s/{token}/verify` per client IP, with its login
budget (`OXICLOUD_RATE_LIMIT_LOGIN_MAX`/`_WINDOW_SECS`, default 10 per 60 s).
It counts every check, correct passwords included, and the window restarts
on each one, so the count clears only after a full quiet window. By default
OxiCloud sees one client, the proxy. A few wrong guesses on any share would
then lock every visitor out of every password-protected share.

The proxy refuses password checks itself, with `429` and `Retry-After`,
before it forwards anything:

- per client (`AUTH_RATE_LIMIT_PER_IP`), counting everything but correct
  passwords and OxiCloud 429s: unknown tokens and failed checks included;
- per share (`AUTH_RATE_LIMIT_PER_TOKEN`), counting wrong passwords, checks
  whose outcome is unknown (timeout, error), and checks in flight. A share
  is only recorded when OxiCloud answers 401, which it does only for a real,
  unexpired, password-protected share, or when it doesn't answer properly. Made-up
  tokens cannot fill this table, and a share under attack is never evicted
  from it;
- per OxiCloud rate-limit key (`UPSTREAM_VERIFY_MAX`), counting every check
  the way OxiCloud does, so OxiCloud's own limit is never reached. If OxiCloud
  answers `429` anyway, the proxy waits out its `Retry-After` and does not
  send more checks that would extend OxiCloud's window.

Without `UPSTREAM_FORWARD_CLIENT_IP` that last budget covers the whole
proxy, so the lockout is shorter and answered properly, but it remains
possible. A handful of clients (two at the defaults) can still keep password
checks unavailable for everyone, at about 8 attempts a minute. Visitors who
already unlocked a share keep access, because their unlock cookie is checked
by a request OxiCloud does not rate-limit. To make the limit per client:

1. Make sure the proxy sees real client IPs: set `TRUST_PROXY` to your
   reverse proxy's address, and behind a CDN set `CLIENT_IP_HEADER` (e.g.
   `cf-connecting-ip`). This only holds if clients cannot reach the reverse
   proxy around the CDN, or if the reverse proxy overwrites that header.
2. On OxiCloud, set `OXICLOUD_TRUST_PROXY_CIDR` to the address the proxy
   connects from (e.g. its WireGuard IP), and nothing broader.
3. Set `UPSTREAM_FORWARD_CLIENT_IP=true`.

Then each visitor has their own budget at OxiCloud and in the proxy. The
per-share limit still lets clients together lock one share's password form
for a window; that is the price of capping guesses per share.

Limits:

- The per-client and upstream tables hold 10,000 keys and then forget the
  least recently used. That can reset a client's own budget, which is no
  more than using another address, while the per-share limit still holds.
  The per-share table holds 100,000 shares with recent wrong guesses. Past
  that, new shares are refused (429) until entries expire, rather than
  forgetting one under attack. Reaching it means wrong guesses at 100,000
  real password-protected shares within one window. If a future OxiCloud
  answered 401 for unknown tokens too, made-up tokens could fill it.
- Checks in flight are capped (`AUTH_MAX_CONCURRENT`) and time out after
  10 s, so a slow or hung OxiCloud cannot pile up requests and limiter
  state. The cap is shared: with forwarding on, clients who keep 16 checks
  in flight against a slow OxiCloud delay everyone else's by about a
  second at a time. Without forwarding, the upstream budget already keeps
  fewer checks in flight.
- All counters are in memory, per proxy instance. Several instances behind
  one egress IP each spend their own budget, so divide
  `UPSTREAM_VERIFY_MAX` among them, or put the limit in the front proxy.
- Anything else that calls OxiCloud's verify endpoint from the same address
  spends the same OxiCloud budget.
- A front-proxy limit (e.g. Traefik `ratelimit` on `/share/*/auth`) is still
  useful, as a first line that never reaches Node. Its responses are not
  covered by this proxy's security headers, so add them there.

## Routes

```
GET  /                              landing page
GET  /healthcheck                   liveness probe (200 / "ok")
GET  /s/:token                      301 → /share/:token (OxiCloud-native URL format)
GET  /share/:token                  share page (file / folder / password / expired)
POST /share/:token/auth             submit password
GET  /share/:token/download         file share download
GET  /share/:token/folder/:id       subfolder gallery
GET  /share/:token/file/:id         file inside folder share
GET  /share/:token/zip              folder share as ZIP
GET  /share/:token/zip/:id          subfolder as ZIP
GET  /public/*                      static assets (logo, file-type icons)
```

## Reverse proxy

Any TLS-terminating reverse proxy works. The proxy is a single HTTP
listener on the configured port, so the upstream config is trivial.

nginx:

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

For Traefik or Nginx Proxy Manager, point the host to the proxy container's
port and let the manager handle the rest. No special config is needed for
streaming or large files; downloads and ZIPs use HTTP/1.1 chunked transfer.

## Development

```bash
npm install
cp .env.example .env
# edit .env
npm run dev
```

`npm run dev` uses `tsx watch` with Node's native `--env-file`, so saving a
file in `src/` reloads the server.

```bash
npm run typecheck   # src, plus the tests
npm test            # node:test via tsx, against a fake OxiCloud >= 0.9.1
```

The tests drive the real app with `inject()` against an in-process fake
OxiCloud that only answers folder/file calls carrying the share ring, and
mimics OxiCloud's share-verify rate limiter. They cover gallery rendering
(normal and adversarial file ids, names and mime types), security headers,
password rate limiting and client-IP trust, uploaded-file rendering, the
unlock cookie, cross-site posts, malformed input, and the dependency
versions the remediation below relies on.

`package.json` overrides `glob` under `@fastify/static` to `^14.0.2`: every
`@fastify/static` 10.x asks for `glob ^13`, and no 13.x carries the fixes for
GHSA-3g3m-2fjr-6pw4 (glob) and GHSA-g3hv-75wg-m249 (minimatch < 11.0.1).
`@fastify/static` only calls `glob()` with `wildcard: false`, which this app
does not use; the call it makes is unchanged in glob 14 and is tested. Drop
the override once `@fastify/static` depends on `glob >= 14.0.2`.

## Security notes

- The proxy holds no OxiCloud admin credentials. Share tokens are the only
  authorization, same as on an exposed OxiCloud.
- Tokens are validated with a strict regex before any upstream call.
- Templates use only escaped EJS output (`<%= %>`); file ids, names and mime
  types from OxiCloud are never written raw.
- POST body size is capped at 64 KiB (the only POST is the password form).
  The password must be a single string of at most 1024 characters; anything
  else gets a `400` without reaching OxiCloud.
- The password form refuses cross-site posts with `403`, before rate limits
  or OxiCloud. It checks `Sec-Fetch-Site`; else `Origin`, where `null` (sent
  by sandboxed and referrer-less cross-site forms) is refused; else a
  foreign `Referer`. Requests with none of these, like non-browser clients,
  are accepted. So are the oldest browsers (Firefox < 70 sends no `Origin`
  on form posts) when an attacker's page also suppresses `Referer`; for
  those, only the rate limits apply.
- Pages with the password form send `Referrer-Policy: no-referrer,
  strict-origin`, so the browser's own POST carries the real `Origin` and
  not `null`. Any `Referer` they cause is the bare origin, to this site or
  the font host, never the path with the share token. Browsers that don't
  know `strict-origin` use `no-referrer`. Every other response stays
  `no-referrer`.
- Password checks are rate-limited before they reach OxiCloud; see
  [Client IPs and rate limits](#client-ips-and-rate-limits).
- The unlock cookie OxiCloud issues after a correct password is relayed
  `HttpOnly`, host-only, with `Path=/share/<token>`, never `SameSite=None`,
  and `Secure` when the visitor is on HTTPS (per a trusted
  `X-Forwarded-Proto`). OxiCloud's ring cookie never reaches the browser.
- Unknown routes and malformed requests get plain `Not found`/`Bad request`
  bodies, and error pages do not show OxiCloud's status code.
- Every response carries hardening headers: a strict `Content-Security-Policy`
  on the proxy's pages (no inline script or style, no `eval`), HSTS on HTTPS,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (share
  URLs contain the token) and `X-Frame-Options: DENY`.
- Uploaded files are shown inline only if they are raster images, audio,
  video or PDF, with a CSP that blocks scripts. Everything else (HTML, SVG,
  XML, text, unknown types) is sent as `Content-Disposition: attachment`,
  with a `default-src 'none'; sandbox` CSP, so it cannot render on the
  proxy's origin. Gallery thumbnails still load, since `<img>` ignores the
  disposition.
- Cloudflare features that inject inline scripts (JS challenge, Bot Fight
  Mode, Email Obfuscation, Rocket Loader...) are blocked by the page CSP, on
  purpose. Turn them off for this hostname rather than loosening the CSP.
- TLS is the responsibility of the reverse proxy in front. The proxy itself
  speaks plain HTTP on a private port.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

This fork tracks [abnvle/oxicloud-public-proxy](https://github.com/abnvle/oxicloud-public-proxy),
the original project by abnvle; thanks to them for it.

## License

[MIT](LICENSE).
