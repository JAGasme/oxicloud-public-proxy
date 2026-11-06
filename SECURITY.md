# Security policy

This proxy is designed to sit on the public internet in front of a private
OxiCloud, so security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub security advisories](https://github.com/JAGasme/oxicloud-public-proxy/security/advisories/new).

Include the proxy version, the OxiCloud version, and steps to reproduce.
You should get a first reply within a week. Once a fix is released, the
advisory is published with credit to you, unless you prefer otherwise.

## In scope

- Anything that lets a visitor reach OxiCloud beyond the shared item
  (other files, folders, the API, the admin UI)
- Bypassing share passwords or expiry
- XSS, header injection or open redirects in the rendered pages
- Leaking upstream internals (internal URLs, cookies, session data)

Vulnerabilities in OxiCloud itself belong to the
[OxiCloud project](https://github.com/AtalayaLabs/OxiCloud/security).

## Supported versions

Only the latest release receives fixes.
