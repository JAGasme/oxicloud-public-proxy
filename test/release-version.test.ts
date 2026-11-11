import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// The Release workflow refuses a tag that differs from package.json's version,
// and a refused v* tag can't be deleted or moved (protect-release-tags). These
// checks keep the version in one place so the bump PR is complete before the
// tag is pushed.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(rootDir, file), "utf8");

const pkg = JSON.parse(read("package.json")) as { version: string };
const version = pkg.version;

describe("release version", () => {
  it("is vX.Y.Z or vX.Y.Z-prerelease, the shape release.yml accepts", () => {
    assert.match(`v${version}`, /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/);
  });

  it("matches package-lock.json", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    assert.equal(lock.version, version);
    assert.equal(lock.packages[""]?.version, version);
  });

  it("is the image tag in docker-compose.yml and the README", () => {
    const image = /ghcr\.io\/jagasme\/oxicloud-public-proxy:([^\s`]+)/g;
    for (const file of ["docker-compose.yml", "README.md"]) {
      const tags = [...read(file).matchAll(image)].map((m) => m[1]);
      assert.ok(tags.length > 0, `${file} names no image tag`);
      for (const tag of tags) assert.equal(tag, version, file);
    }
  });
});
