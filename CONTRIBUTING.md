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

Releases follow [Semantic Versioning](https://semver.org/), starting at
`2.0.0` (the fork's first own line; upstream's last release was 1.0.0):

- **patch** (`2.0.1`): fixes and dependency updates, drop-in compatible.
- **minor** (`2.1.0`): new features, still compatible.
- **major** (`3.0.0`): anything that breaks an existing deploy, including
  dropping support for an OxiCloud version.

Supported OxiCloud versions are listed in the README's Compatibility table,
not encoded in the version.

### Cutting a release

1. Open a PR that bumps the version: `npm version X.Y.Z --no-git-tag-version`
   (updates `package.json` and `package-lock.json`), plus the image tag in
   `README.md` and `docker-compose.yml`. `npm test` fails if any of these
   disagree.
2. Merge it to `main`.
3. Tag the merged commit from the command line, not the GitHub "Draft a new
   release" form:
   `git switch main && git pull && git tag vX.Y.Z && git push origin vX.Y.Z`.
   The Release workflow runs only on `v*` tags; it tests, publishes the image
   and creates the GitHub Release itself. A release made in the GUI with a
   tag like `2.1.0` (no `v`) runs nothing and publishes no image.

Pushed `v*` tags can't be deleted or moved (ruleset `protect-release-tags`).
If the Release workflow refuses a tag (say, because the bump hadn't merged),
the tag stays on the unbumped commit and re-running the workflow fails the
same way. Either bump to the next patch and tag that, or have an admin
briefly set the ruleset to *Disabled*, delete the refused tag (it has no
image or release), re-enable the ruleset, and tag the bump commit.

Releases before 2.0.0 were tagged `1.0.0-oxi091.N`. Those images stay
published, but under semver they sort *before* 1.0.0, which is why the
scheme changed.

## License

By contributing you agree your contributions are licensed under the
[MIT License](LICENSE).
