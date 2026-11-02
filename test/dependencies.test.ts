import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import ejs from "ejs";
import { buildApp } from "../src/app.js";
import { UpstreamClient } from "../src/upstream.js";

// Guards for the dependency remediation: ejs >= 5 has no runtime deps (the
// jake > filelist > minimatch@5 chain is gone), and @fastify/static's glob is
// overridden to a release with the AbortSignal fix (GHSA-3g3m-2fjr-6pw4) and
// minimatch >= 11.0.1 (GHSA-g3hv-75wg-m249).

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(rootDir, "package.json"));

function versionOf(pkg: string, from: string): string {
  const req = createRequire(from);
  return (req(`${pkg}/package.json`) as { version: string }).version;
}

function atLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

describe("resolved dependency versions", () => {
  it("ejs ships without runtime dependencies", () => {
    // ejs's "exports" hides package.json, so read it from where npm put it.
    const ejsPkg = path.join(path.dirname(require.resolve("ejs")), "..", "..", "package.json");
    const meta = JSON.parse(readFileSync(ejsPkg, "utf8")) as {
      name: string;
      version: string;
      dependencies?: object;
    };
    assert.equal(meta.name, "ejs");
    assert.ok(atLeast(meta.version, "7.0.2"), meta.version);
    assert.deepEqual(Object.keys(meta.dependencies ?? {}), []);
    assert.throws(() => createRequire(ejsPkg).resolve("jake"), /Cannot find module/);
  });

  it("@fastify/static resolves a patched glob and minimatch", () => {
    const staticPkg = require.resolve("@fastify/static/package.json");
    const glob = versionOf("glob", staticPkg);
    assert.ok(atLeast(glob, "14.0.2"), `glob ${glob}`);
    const globPkg = createRequire(staticPkg).resolve("glob/package.json");
    const minimatch = versionOf("minimatch", globPkg);
    assert.ok(atLeast(minimatch, "11.0.1"), `minimatch ${minimatch}`);
  });
});

describe("ejs 7 rendering", () => {
  it("escapes <%= %> and keeps <%- %> raw", () => {
    const out = ejs.render('<a title="<%= v %>"><%- raw %></a>', { v: `"'<>&`, raw: "<b>" });
    assert.equal(out, '<a title="&#34;&#39;&lt;&gt;&amp;"><b></a>');
  });

  it("no longer reads options out of the data object", () => {
    // ejs 7 dropped Express 2 options-in-data; templates must not rely on it.
    const out = ejs.render("<?= x ?>", { x: 1, delimiter: "?" });
    assert.equal(out, "<?= x ?>");
  });
});

describe("@fastify/static with glob 14", () => {
  it("serves icons in the app's default (wildcard) mode", async () => {
    const app = await buildApp({
      upstream: new UpstreamClient("http://127.0.0.1:9"),
      publicBaseUrl: "https://share.example",
    });
    try {
      const ok = await app.inject({ method: "GET", url: "/public/icons/pdf.png" });
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.headers["content-type"], "image/png");
      const missing = await app.inject({ method: "GET", url: "/public/icons/../../package.json" });
      assert.notEqual(missing.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("enumerates files with glob when wildcard is off", async () => {
    const app = Fastify();
    await app.register(fastifyStatic, {
      root: path.join(rootDir, "public"),
      prefix: "/public/",
      wildcard: false,
    });
    try {
      const routes = app.printRoutes({ commonPrefix: false });
      assert.match(routes, /pdf\.png/);
      assert.match(routes, /oxicloud-logo\.png/);
      const ok = await app.inject({ method: "GET", url: "/public/icons/pdf.png" });
      assert.equal(ok.statusCode, 200);
      const missing = await app.inject({ method: "GET", url: "/public/icons/nope.png" });
      assert.equal(missing.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});
