import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { type BuildAppOptions, buildApp } from "../src/app.js";
import { type AuthRateLimit, parseTrustProxy } from "../src/config.js";
import {
  SlidingWindowLimiter,
  UpstreamBudget,
  limiterKey,
  parseRetryAfter,
} from "../src/ratelimit.js";
import { isSameOriginPost, scopeUnlockCookie } from "../src/routes/share.js";
import {
  ATTACHMENT_CSP,
  FILE_CSP,
  asAttachment,
  inlineSafe,
} from "../src/security.js";
import { UpstreamClient } from "../src/upstream.js";
import {
  BROKEN_TOKEN,
  FILE_TOKEN,
  type FakeOptions,
  type FakeOxiCloud,
  type FakeResource,
  PASSWORD,
  PW_TOKEN,
  TOKEN,
  UNLOCK,
  startFakeOxiCloud,
} from "./fake-oxicloud.js";

// Fixes for the 2026-11-11 security report: password-check rate limiting and
// upstream 429s, uploaded-file rendering, the unlock cookie, cross-site
// password posts, and generic error responses.

const PUBLIC = "https://share.example";
const NO_LIMITS: AuthRateLimit = {
  perIp: 0,
  perToken: 0,
  windowSecs: 60,
  upstreamMax: 0,
  upstreamWindowSecs: 60,
};

async function setup(
  opts: { limits?: Partial<AuthRateLimit>; fake?: FakeOptions; files?: FakeResource[] } & Partial<
    Omit<BuildAppOptions, "upstream" | "publicBaseUrl" | "authRateLimit">
  > = {},
) {
  const { limits, fake: fakeOpts, files, ...appOpts } = opts;
  const fake = await startFakeOxiCloud(files ?? [], fakeOpts);
  const app = await buildApp({
    upstream: new UpstreamClient(fake.url),
    publicBaseUrl: PUBLIC,
    authRateLimit: { ...NO_LIMITS, ...limits },
    ...appOpts,
  });
  return { fake, app, close: async () => (await app.close(), await fake.close()) };
}

interface PostOpts {
  token?: string;
  password?: string;
  ip?: string;
  headers?: Record<string, string>;
}

function post(app: FastifyInstance, o: PostOpts = {}) {
  return app.inject({
    method: "POST",
    url: `/share/${o.token ?? PW_TOKEN}/auth`,
    remoteAddress: o.ip ?? "203.0.113.10",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      ...o.headers,
    },
    payload: `password=${encodeURIComponent(o.password ?? "wrong")}`,
  });
}

// ── Finding 1: rate limiting ──────────────────────────────────────────────

describe("limiter primitives", () => {
  it("sliding window: refuses at max, frees slots as they age or are released", () => {
    let now = 0;
    const l = new SlidingWindowLimiter(2, 60_000, () => now);
    const a = l.acquire("k");
    assert.ok(a.ok && l.acquire("k").ok);
    const refused = l.acquire("k");
    assert.ok(!refused.ok);
    assert.equal(refused.retryAfter, 60);
    a.release();
    a.release(); // idempotent
    assert.ok(l.acquire("k").ok);
    assert.ok(!l.acquire("k").ok);
    assert.ok(l.acquire("other").ok, "keys are independent");
    now = 60_001;
    assert.ok(l.acquire("k").ok);
  });

  it("upstream budget mirrors OxiCloud: activity keeps the count alive", () => {
    let now = 0;
    const b = new UpstreamBudget(3, 60_000, () => now);
    // One request every 50 s never leaves a full quiet window, so OxiCloud
    // keeps counting; so must the mirror.
    for (let i = 0; i < 3; i++, now += 50_000) assert.ok(b.acquire("proxy").ok, `call ${i}`);
    const refused = b.acquire("proxy");
    assert.ok(!refused.ok);
    // Refused calls never reach OxiCloud, so they do not extend its window.
    now = 100_000 + 60_000;
    assert.ok(b.acquire("proxy").ok, "count restarts after a quiet window");
  });

  it("upstream budget backs off for Retry-After when OxiCloud says 429", () => {
    let now = 0;
    const b = new UpstreamBudget(5, 60_000, () => now);
    b.tripped("proxy", 180);
    const refused = b.acquire("proxy");
    assert.ok(!refused.ok);
    assert.equal(refused.retryAfter, 180);
    now = 179_000;
    assert.ok(!b.acquire("proxy").ok);
    now = 180_000;
    assert.ok(b.acquire("proxy").ok);
  });

  it("zero disables a limit, but an upstream 429 is still honoured", () => {
    let now = 0;
    const l = new SlidingWindowLimiter(0, 1000);
    const b = new UpstreamBudget(0, 1000, () => now);
    for (let i = 0; i < 100; i++) assert.ok(l.acquire("k").ok && b.acquire("k").ok);
    b.tripped("k", 5);
    assert.ok(!b.acquire("k").ok);
    now = 5000;
    assert.ok(b.acquire("k").ok);
  });

  it("groups IPv6 clients by /64 and normalises v4-mapped addresses", () => {
    assert.equal(limiterKey("203.0.113.9"), "203.0.113.9");
    assert.equal(limiterKey("2001:db8:1:2::1"), limiterKey("2001:db8:1:2:ffff:1:2:3"));
    assert.notEqual(limiterKey("2001:db8:1:2::1"), limiterKey("2001:db8:1:3::1"));
    assert.equal(limiterKey("2001:db8::"), "2001:db8:0:0::/64");
    assert.equal(limiterKey("::ffff:1.2.3.4"), "0:0:0:0::/64");
  });

  it("parses Retry-After seconds and dates", () => {
    assert.equal(parseRetryAfter("120"), 120);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter("soon"), null);
    const inAMinute = new Date(Date.now() + 60_000).toUTCString();
    assert.ok(Math.abs(parseRetryAfter(inAMinute)! - 60) <= 1);
  });

  it("parses TRUST_PROXY", () => {
    assert.deepEqual(parseTrustProxy(undefined), ["loopback", "linklocal", "uniquelocal"]);
    assert.equal(parseTrustProxy("true"), true);
    assert.equal(parseTrustProxy("false"), false);
    assert.deepEqual(parseTrustProxy("10.10.10.0/24, 127.0.0.1"), ["10.10.10.0/24", "127.0.0.1"]);
  });
});

describe("password rate limiting", () => {
  it("per client: refuses before OxiCloud is called, with Retry-After", async () => {
    const { fake, app, close } = await setup({ limits: { perIp: 3 } });
    try {
      for (let i = 0; i < 3; i++) assert.equal((await post(app)).statusCode, 200);
      const res = await post(app);
      assert.equal(res.statusCode, 429);
      assert.equal(res.headers["retry-after"], "60");
      assert.match(res.body, /Too many password attempts/);
      assert.match(res.body, /<form method="post"/);
      assert.equal(res.headers["content-security-policy"] !== undefined, true);
      assert.equal(fake.verifies.length, 3, "the refused attempt never reached OxiCloud");
      // Another visitor is unaffected.
      assert.equal((await post(app, { ip: "198.51.100.20" })).statusCode, 200);
    } finally {
      await close();
    }
  });

  it("per client: a correct password does not use up the budget", async () => {
    const { app, close } = await setup({ limits: { perIp: 2 } });
    try {
      for (let i = 0; i < 5; i++) {
        assert.equal((await post(app, { password: PASSWORD })).statusCode, 303);
      }
      assert.equal((await post(app)).statusCode, 200);
      assert.equal((await post(app, { password: PASSWORD })).statusCode, 303);
    } finally {
      await close();
    }
  });

  it("per share: distinct clients share one budget per token", async () => {
    const { fake, app, close } = await setup({ limits: { perToken: 3 } });
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await post(app, { ip: `198.51.100.${i + 1}` })).statusCode, 200);
      }
      assert.equal((await post(app, { ip: "198.51.100.99" })).statusCode, 429);
      // Other tokens are counted separately.
      assert.equal((await post(app, { token: "other-token", ip: "198.51.100.99" })).statusCode, 410);
      assert.equal(fake.verifies.length, 4);
    } finally {
      await close();
    }
  });

  it("aggregate: holds the proxy's total below OxiCloud's limit across clients and tokens", async () => {
    // Without UPSTREAM_FORWARD_CLIENT_IP OxiCloud sees one client, the proxy.
    const { fake, app, close } = await setup({
      limits: { upstreamMax: 4 },
      fake: { verifyMax: 5 },
    });
    try {
      const codes = [];
      for (let i = 0; i < 6; i++) {
        const token = i % 2 ? PW_TOKEN : `no-such-${i}`;
        codes.push((await post(app, { token, ip: `198.51.100.${i + 1}` })).statusCode);
      }
      assert.deepEqual(codes, [410, 200, 410, 200, 429, 429]);
      assert.equal(fake.verifies.length, 4, "OxiCloud's limit (5) was never reached");
      // The residual risk, by design: everyone waits until the window passes,
      // the correct password included, rather than OxiCloud locking for longer.
      const res = await post(app, { password: PASSWORD, ip: "192.0.2.1" });
      assert.equal(res.statusCode, 429);
      assert.ok(Number(res.headers["retry-after"]) >= 1);
    } finally {
      await close();
    }
  });

  it("with UPSTREAM_FORWARD_CLIENT_IP the budget and X-Forwarded-For are per client", async () => {
    const { fake, app, close } = await setup({
      forwardClientIp: true,
      limits: { upstreamMax: 2 },
      fake: { verifyMax: 3, trustXff: true },
    });
    try {
      for (const ip of ["198.51.100.1", "198.51.100.2"]) {
        for (let i = 0; i < 2; i++) assert.equal((await post(app, { ip })).statusCode, 200);
        assert.equal((await post(app, { ip })).statusCode, 429);
      }
      assert.deepEqual(
        fake.verifies.map((v) => v.xff),
        ["198.51.100.1", "198.51.100.1", "198.51.100.2", "198.51.100.2"],
      );
    } finally {
      await close();
    }
  });

  it("does not forward the visitor's own X-Forwarded-For upstream", async () => {
    const { fake, app, close } = await setup({ forwardClientIp: true });
    try {
      await post(app, { ip: "203.0.113.7", headers: { "x-forwarded-for": "6.6.6.6" } });
      await post(app, { ip: "10.0.0.2", headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.4" } });
      await post(app);
      assert.deepEqual(
        fake.verifies.map((v) => v.xff),
        ["203.0.113.7", "198.51.100.4", "203.0.113.10"],
      );
    } finally {
      await close();
    }
  });

  it("does not forward any X-Forwarded-For by default", async () => {
    const { fake, app, close } = await setup();
    try {
      await post(app, { headers: { "x-forwarded-for": "6.6.6.6" } });
      assert.equal(fake.verifies[0]!.xff, undefined);
    } finally {
      await close();
    }
  });

  it("a spoofed X-Forwarded-For from an untrusted peer does not change the key", async () => {
    const { app, close } = await setup({ limits: { perIp: 2 } });
    try {
      const codes = [];
      for (let i = 0; i < 3; i++) {
        codes.push(
          (await post(app, { ip: "203.0.113.50", headers: { "x-forwarded-for": `192.0.2.${i}` } }))
            .statusCode,
        );
      }
      assert.deepEqual(codes, [200, 200, 429]);
    } finally {
      await close();
    }
  });

  it("behind a trusted proxy keys on the hop it reports, not the leftmost entry", async () => {
    const { app, close } = await setup({ limits: { perIp: 2 } });
    try {
      const via = (spoof: string) =>
        post(app, { ip: "172.18.0.5", headers: { "x-forwarded-for": `${spoof}, 198.51.100.8` } });
      assert.deepEqual(
        [(await via("1.1.1.1")).statusCode, (await via("2.2.2.2")).statusCode, (await via("3.3.3.3")).statusCode],
        [200, 200, 429],
      );
      // A different real client behind the same proxy has its own budget.
      const other = await post(app, { ip: "172.18.0.5", headers: { "x-forwarded-for": "198.51.100.9" } });
      assert.equal(other.statusCode, 200);
    } finally {
      await close();
    }
  });

  it("CLIENT_IP_HEADER is honoured only on requests from a trusted proxy", async () => {
    const { app, close } = await setup({ limits: { perIp: 1 }, clientIpHeader: "cf-connecting-ip" });
    try {
      const viaProxy = (cf: string) =>
        post(app, {
          ip: "10.10.10.1",
          headers: { "x-forwarded-for": "162.158.0.1", "cf-connecting-ip": cf },
        });
      assert.equal((await viaProxy("198.51.100.1")).statusCode, 200);
      assert.equal((await viaProxy("198.51.100.2")).statusCode, 200, "own key per header value");
      assert.equal((await viaProxy("198.51.100.1")).statusCode, 429);
      // Not a valid IP: falls back to the proxy-reported hop.
      assert.equal((await viaProxy("garbage")).statusCode, 200);
      assert.equal((await viaProxy("garbage, 1.2.3.4")).statusCode, 429);

      const direct = (cf: string) =>
        post(app, { ip: "203.0.113.60", headers: { "cf-connecting-ip": cf } });
      assert.equal((await direct("198.51.100.30")).statusCode, 200);
      assert.equal((await direct("198.51.100.31")).statusCode, 429, "spoofed header ignored");
    } finally {
      await close();
    }
  });

  it("maps an upstream 429 to a 429 with Retry-After, then holds back", async () => {
    const { fake, app, close } = await setup({ fake: { verifyMax: 2 } });
    try {
      assert.equal((await post(app)).statusCode, 200);
      assert.equal((await post(app)).statusCode, 200);
      const res = await post(app, { password: PASSWORD });
      assert.equal(res.statusCode, 429, "was a 500 'Code: 429' page");
      assert.equal(res.headers["retry-after"], "60");
      assert.match(res.body, /Too many password attempts/);
      assert.ok(!/429/.test(res.body.replace(/<script[^>]*><\/script>/g, "")));
      assert.equal(fake.verifies.length, 3);
      // OxiCloud's window restarts on every request; do not feed it.
      assert.equal((await post(app, { password: PASSWORD, ip: "198.51.100.77" })).statusCode, 429);
      assert.equal(fake.verifies.length, 3);
    } finally {
      await close();
    }
  });

  it("concurrent attempts cannot overshoot the budget", async () => {
    const { fake, app, close } = await setup({ limits: { perIp: 3, upstreamMax: 3 } });
    try {
      const codes = (await Promise.all(Array.from({ length: 10 }, () => post(app)))).map(
        (r) => r.statusCode,
      );
      assert.equal(codes.filter((c) => c === 200).length, 3);
      assert.equal(codes.filter((c) => c === 429).length, 7);
      assert.equal(fake.verifies.length, 3);
    } finally {
      await close();
    }
  });

  it("defaults stay below OxiCloud's default 10 per 60 s", async () => {
    const { fake, app, close } = await buildDefault();
    try {
      const codes = [];
      for (let i = 0; i < 12; i++) {
        codes.push((await post(app, { ip: `198.51.100.${i + 1}` })).statusCode);
      }
      assert.equal(codes.filter((c) => c === 200).length, 8);
      assert.ok(!codes.includes(500));
      assert.equal(fake.verifies.length, 8);
    } finally {
      await close();
    }
  });
});

async function buildDefault() {
  const fake = await startFakeOxiCloud([], { verifyMax: 10 });
  const app = await buildApp({ upstream: new UpstreamClient(fake.url), publicBaseUrl: PUBLIC });
  return { fake, app, close: async () => (await app.close(), await fake.close()) };
}

// ── Finding 2: uploaded files ─────────────────────────────────────────────

describe("uploaded file rendering", () => {
  const CASES: Array<[string, string, boolean]> = [
    ["jpg-1", "image/jpeg", true],
    ["png-1", "image/png", true],
    ["webp-1", "image/webp", true],
    ["mp4-1", "video/mp4", true],
    ["mp3-1", "audio/mpeg", true],
    ["pdf-1", "application/pdf", true],
    ["html-1", "text/html", false],
    ["html-2", "text/html; charset=utf-8", false],
    ["xhtml-1", "application/xhtml+xml", false],
    ["svg-1", "image/svg+xml", false],
    ["svg-2", "IMAGE/SVG+XML; charset=utf-8", false],
    ["xml-1", "text/xml", false],
    ["txt-1", "text/plain", false],
    ["css-1", "text/css", false],
    ["js-1", "application/javascript", false],
    ["bin-1", "application/octet-stream", false],
    ["none-1", "", false],
  ];
  let fake: FakeOxiCloud;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  before(async () => {
    ({ fake, app, close } = await setup({
      files: CASES.map(([id, mime]) => ({ id, name: `${id}.dat`, mime_type: mime })),
      fake: { fileShare: { id: "single-1", name: "page.html", mime_type: "text/html" } },
    }));
  });
  after(async () => close());

  for (const [id, mime, inline] of CASES) {
    it(`${mime || "(no type)"} is served ${inline ? "inline" : "as an attachment"}`, async () => {
      const res = await app.inject({ method: "GET", url: `/share/${TOKEN}/file/${id}` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], mime || "application/octet-stream");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      if (inline) {
        assert.equal(res.headers["content-security-policy"], FILE_CSP);
        assert.equal(res.headers["content-disposition"], `inline; filename="${id}.dat"`);
      } else {
        assert.equal(res.headers["content-security-policy"], ATTACHMENT_CSP);
        assert.equal(res.headers["content-disposition"], `attachment; filename="${id}.dat"`);
      }
    });
  }

  it("applies the same rule to single-file shares", async () => {
    const res = await app.inject({ method: "GET", url: `/share/${FILE_TOKEN}/download` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-disposition"], 'attachment; filename="page.html"');
    assert.equal(res.headers["content-security-policy"], ATTACHMENT_CSP);
  });

  it("the gallery still shows images and video inline", async () => {
    const html = (await app.inject({ method: "GET", url: `/share/${TOKEN}` })).body;
    assert.match(html, /data-mediakind="image"/);
    assert.match(html, /data-mediakind="video"/);
    assert.ok(fake.log.length > 0);
  });

  it("inlineSafe / asAttachment edge cases", () => {
    assert.equal(inlineSafe(null), false);
    assert.equal(inlineSafe("image/svg"), false);
    assert.equal(inlineSafe("image/jpeg, text/html"), false);
    assert.equal(inlineSafe("video/mp4;codecs=avc1"), true);
    assert.equal(asAttachment(null), "attachment");
    assert.equal(asAttachment("INLINE"), "attachment");
    assert.equal(asAttachment('inline; filename="a;b.html"'), 'attachment; filename="a;b.html"');
    assert.equal(asAttachment("attachment; filename*=UTF-8''x.svg"), "attachment; filename*=UTF-8''x.svg");
    assert.equal(asAttachment("bogus"), "attachment");
  });
});

// ── Finding 3: unlock cookie ──────────────────────────────────────────────

describe("unlock cookie", () => {
  it("is Secure on HTTPS, scoped to the share, and the ring stays hidden", async () => {
    const { app, close } = await setup();
    try {
      const res = await post(app, {
        password: PASSWORD,
        ip: "127.0.0.1",
        headers: { "x-forwarded-proto": "https" },
      });
      assert.equal(res.statusCode, 303);
      assert.equal(res.headers.location, `/share/${PW_TOKEN}`);
      const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
      assert.deepEqual(cookies, [
        `${UNLOCK}; SameSite=Lax; Max-Age=3600; Path=/share/${PW_TOKEN}; HttpOnly; Secure`,
      ]);
    } finally {
      await close();
    }
  });

  it("is not Secure on plain HTTP or with an untrusted X-Forwarded-Proto", async () => {
    const { app, close } = await setup();
    try {
      for (const r of [
        await post(app, { password: PASSWORD, ip: "127.0.0.1" }),
        await post(app, { password: PASSWORD, headers: { "x-forwarded-proto": "https" } }),
      ]) {
        const cookie = String(r.headers["set-cookie"]);
        assert.ok(!/;\s*Secure/i.test(cookie), cookie);
        assert.match(cookie, /Path=\/share\/tok-pw;/);
      }
    } finally {
      await close();
    }
  });

  it("unlocks the share pages it is scoped to", async () => {
    const { app, close } = await setup();
    try {
      const locked = await app.inject({ method: "GET", url: `/share/${PW_TOKEN}` });
      assert.match(locked.body, /<form method="post"/);
      const open = await app.inject({
        method: "GET",
        url: `/share/${PW_TOKEN}`,
        headers: { cookie: UNLOCK },
      });
      assert.equal(open.statusCode, 200);
      assert.ok(!/<form method="post"/.test(open.body));
    } finally {
      await close();
    }
  });

  it("scopeUnlockCookie drops Domain/Path/Secure from upstream and never allows SameSite=None", () => {
    assert.equal(
      scopeUnlockCookie("a=b; Domain=oxicloud.internal; Path=/; Secure; SameSite=None", "t-1", false),
      "a=b; SameSite=Lax; Path=/share/t-1; HttpOnly",
    );
    assert.equal(
      scopeUnlockCookie("a=b; SameSite=Strict; Expires=Wed, 11 Nov 2026 10:00:00 GMT", "t", true),
      "a=b; SameSite=Strict; Expires=Wed, 11 Nov 2026 10:00:00 GMT; Path=/share/t; HttpOnly; Secure",
    );
  });
});

// ── Finding 4: cross-site password posts ──────────────────────────────────

describe("cross-site password posts", () => {
  const CASES: Array<[string, Record<string, string>, boolean]> = [
    ["Sec-Fetch-Site: same-origin", { "sec-fetch-site": "same-origin" }, true],
    ["Sec-Fetch-Site: none", { "sec-fetch-site": "none" }, true],
    ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site", origin: PUBLIC }, false],
    ["Sec-Fetch-Site: same-site", { "sec-fetch-site": "same-site" }, false],
    ["no fetch metadata, Origin = PUBLIC_BASE_URL", { origin: PUBLIC }, true],
    ["no fetch metadata, Origin = request origin", { origin: "http://localhost:80" }, true],
    ["no fetch metadata, foreign Origin", { origin: "https://evil.example" }, false],
    ["no fetch metadata, look-alike Origin", { origin: "https://share.example.evil.example" }, false],
    ["no fetch metadata, Origin: null", { origin: "null" }, true],
    ["no headers (non-browser client)", {}, true],
  ];
  let fake: FakeOxiCloud;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  before(async () => {
    ({ fake, app, close } = await setup());
  });
  after(async () => close());

  for (const [name, headers, allowed] of CASES) {
    it(`${allowed ? "accepts" : "refuses"} ${name}`, async () => {
      const before = fake.verifies.length;
      const res = await app.inject({
        method: "POST",
        url: `/share/${PW_TOKEN}/auth`,
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        payload: "password=wrong",
      });
      if (allowed) {
        assert.equal(res.statusCode, 200);
        assert.equal(fake.verifies.length, before + 1);
      } else {
        assert.equal(res.statusCode, 403);
        assert.equal(fake.verifies.length, before, "nothing reached OxiCloud");
        assert.equal(res.headers["set-cookie"], undefined);
      }
    });
  }

  it("isSameOriginPost uses the trusted forwarded proto and host", async () => {
    const req = {
      headers: { origin: "https://files.example" },
      protocol: "https",
      host: "files.example",
    } as unknown as Parameters<typeof isSameOriginPost>[0];
    assert.equal(isSameOriginPost(req, PUBLIC), true);
  });
});

// ── Finding 5: malformed input and error hygiene ──────────────────────────

describe("malformed input and errors", () => {
  let fake: FakeOxiCloud;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  before(async () => {
    ({ fake, app, close } = await setup());
  });
  after(async () => close());

  const BAD_BODIES: Array<[string, string, string]> = [
    ["repeated form field", "application/x-www-form-urlencoded", "password=a&password=b"],
    ["JSON array", "application/json", '{"password":["a","b"]}'],
    ["JSON object", "application/json", '{"password":{"$ne":""}}'],
    ["JSON number", "application/json", '{"password":12345}'],
    ["JSON boolean", "application/json", '{"password":true}'],
    ["overlong password", "application/x-www-form-urlencoded", `password=${"a".repeat(1025)}`],
  ];
  for (const [name, type, payload] of BAD_BODIES) {
    it(`a ${name} gets a 400 without calling OxiCloud`, async () => {
      const before = fake.verifies.length;
      const res = await app.inject({
        method: "POST",
        url: `/share/${PW_TOKEN}/auth`,
        headers: { "content-type": type, "sec-fetch-site": "same-origin" },
        payload,
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /<form method="post"/);
      assert.equal(fake.verifies.length, before);
    });
  }

  it("a JSON string password still works", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/share/${PW_TOKEN}/auth`,
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      payload: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(res.statusCode, 303);
  });

  for (const [name, type, payload, status] of [
    ["malformed JSON", "application/json", '{"password":', 400],
    ["unsupported type", "application/xml", "<password/>", 415],
    ["oversized body", "application/x-www-form-urlencoded", `password=${"a".repeat(70_000)}`, 413],
  ] as const) {
    it(`${name}: generic ${status}, no framework details`, async () => {
      const res = await app.inject({
        method: "POST",
        url: `/share/${PW_TOKEN}/auth`,
        headers: { "content-type": type, "sec-fetch-site": "same-origin" },
        payload,
      });
      assert.equal(res.statusCode, status);
      assert.equal(res.body, "Bad request");
      assert.match(String(res.headers["content-type"]), /^text\/plain/);
      assert.ok(res.headers["content-security-policy"]);
    });
  }

  it("unknown routes get a plain 404 that does not echo the path", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-route/%3Cb%3E" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body, "Not found");
    assert.ok(!/fastify|route|GET/i.test(res.body));
  });

  it("the error page does not show the upstream status", async () => {
    const res = await post(app, { token: BROKEN_TOKEN });
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /Something went wrong/);
    assert.ok(!/Code:|>\s*500\s*</.test(res.body));
  });
});
