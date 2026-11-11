import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { ATTACHMENT_CSP, PAGE_CSP } from "../src/security.js";
import { UpstreamClient } from "../src/upstream.js";
import { type FakeOxiCloud, TOKEN, startFakeOxiCloud } from "./fake-oxicloud.js";

// Security headers on every response, a strict CSP on the proxy's own pages,
// and a script-blocking CSP on uploaded files streamed from OxiCloud.

const HTTPS = { "x-forwarded-proto": "https" };

async function setup(hstsMaxAge?: number) {
  const fake = await startFakeOxiCloud([
    { id: "img-1", name: "beach.jpg", mime_type: "image/jpeg" },
    { id: "evil-1", name: "evil.html", mime_type: "text/html" },
  ]);
  const app = await buildApp({
    upstream: new UpstreamClient(fake.url),
    publicBaseUrl: "https://share.example",
    ...(hstsMaxAge === undefined ? {} : { hstsMaxAge }),
  });
  return { fake, app };
}

describe("security headers", () => {
  let fake: FakeOxiCloud;
  let app: FastifyInstance;

  before(async () => {
    ({ fake, app } = await setup());
  });
  after(async () => {
    await app.close();
    await fake.close();
  });

  it("page CSP has a default-src fallback and no unsafe-* sources", () => {
    assert.match(PAGE_CSP, /(^|; )default-src 'none'(;|$)/);
    assert.ok(!PAGE_CSP.includes("unsafe-"), PAGE_CSP);
  });

  for (const url of ["/", `/share/${TOKEN}`, "/no-such-route"]) {
    it(`sends the page CSP and hardening headers on ${url}`, async () => {
      const res = await app.inject({ method: "GET", url, headers: HTTPS });
      assert.equal(res.headers["content-security-policy"], PAGE_CSP);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.headers["x-frame-options"], "DENY");
      assert.equal(res.headers["strict-transport-security"], "max-age=31536000");
    });
  }

  it("rendered pages contain no inline script or style the CSP would block", async () => {
    for (const url of ["/", `/share/${TOKEN}`, "/share/unknown-token"]) {
      const html = (await app.inject({ method: "GET", url })).body;
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `inline <script> on ${url}`);
      assert.ok(!/<style\b/i.test(html), `<style> on ${url}`);
      assert.ok(!/\sstyle="/i.test(html), `style attribute on ${url}`);
      assert.ok(!/\son[a-z]+="/i.test(html), `inline event handler on ${url}`);
    }
  });

  it("serves the extracted assets, versioned", async () => {
    const html = (await app.inject({ method: "GET", url: `/share/${TOKEN}` })).body;
    const assets = [...html.matchAll(/(?:href|src)="(\/public\/(?:css|js)\/[^"]+)"/g)].map(
      (m) => m[1]!.replace(/&amp;/g, "&"),
    );
    assert.ok(assets.length >= 2, `expected css + js, got ${assets.join(", ")}`);
    for (const url of assets) {
      assert.match(url, /\?v=\d/);
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      assert.match(String(res.headers["content-type"]), /text\/css|javascript/);
    }
  });

  it("never renders an uploaded HTML file inline", async () => {
    const res = await app.inject({ method: "GET", url: `/share/${TOKEN}/file/evil-1` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/html");
    assert.equal(res.headers["content-disposition"], 'attachment; filename="evil.html"');
    assert.equal(res.headers["content-security-policy"], ATTACHMENT_CSP);
    assert.match(ATTACHMENT_CSP, /default-src 'none'/);
    assert.match(ATTACHMENT_CSP, /(^|; )sandbox(;|$)/);
  });

  it("omits HSTS on plain HTTP", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.headers["strict-transport-security"], undefined);
  });
});

describe("HSTS opt-out", () => {
  it("HSTS_MAX_AGE=0 disables the header", async () => {
    const { fake, app } = await setup(0);
    try {
      const res = await app.inject({ method: "GET", url: "/", headers: HTTPS });
      assert.equal(res.headers["strict-transport-security"], undefined);
      assert.equal(res.headers["content-security-policy"], PAGE_CSP);
    } finally {
      await app.close();
      await fake.close();
    }
  });
});
