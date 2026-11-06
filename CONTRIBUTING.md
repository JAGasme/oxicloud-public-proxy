# Contributing

Thanks for helping! Bug reports, fixes and features are all welcome.

## Development

Requires Node 22 or newer.

```bash
npm ci
cp .env.example .env    # set OXICLOUD_INTERNAL_URL and PUBLIC_BASE_URL
npm run dev             # tsx watch, pretty logs
npm run typecheck       # src and tests
npm test                # node:test against a fake OxiCloud (no real instance needed)
```

The tests drive the real app with Fastify's `inject()` against the fake
OxiCloud in `test/fake-oxicloud.ts`. If you rely on a new upstream endpoint
or response field, teach the fake about it and add a test.

## Pull requests

- Keep each PR focused on one change; open an issue first for larger ones.
- CI runs typecheck, tests on Node 22 and 24, a Docker build with a
  health check, CodeQL, and a dependency review. All must pass.
- Never put real share tokens, passwords or private hostnames in code,
  tests, issues or screenshots.

## Versioning

Versions follow `<upstream base>-oxi<OxiCloud line>.<fork patch>`, for example
`1.0.0-oxi091.3`: based on upstream 1.0.0, targeting OxiCloud 0.9.1, third
fork release. Maintainers bump `package.json`, then push a matching `v` tag;
the Release workflow publishes the image and the GitHub Release.

## License

By contributing you agree your contributions are licensed under the
[MIT License](LICENSE).
