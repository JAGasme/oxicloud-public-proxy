import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { AuthRateLimit } from "../src/config.js";
import { ShareFailureLimiter, SlidingWindowLimiter } from "../src/ratelimit.js";
import { UpstreamClient } from "../src/upstream.js";
import { type FakeOptions, PASSWORD, PW_TOKEN, startFakeOxiCloud } from "./fake-oxicloud.js";

// The per-share password limit must hold however the limiter tables are
// filled: with made-up tokens, with real password-protected shares, or with
// concurrent requests (Aikido PR review, "unknown-token floods evict the
// per-share password limit").

describe("ShareFailureLimiter", () => {
  it("counts only confirmed failures, plus checks in flight", () => {
    let now = 0;
    const l = new ShareFailureLimiter(3, 60_000, () => now);
    for (let i = 0; i < 10; i++) {
      const a = l.begin("t");
      assert.ok(a.ok);
      a.done(false); // unknown token, correct password, upstream error...
    }
    const held = [l.begin("t"), l.begin("t"), l.begin("t")];
    assert.ok(held.every((a) => a.ok));
    const refused = l.begin("t");
    assert.ok(!refused.ok, "in-flight checks count");
    assert.equal(refused.retryAfter, 1);
    for (const a of held) if (a.ok) a.done(true);
    const capped = l.begin("t");
    assert.ok(!capped.ok);
    assert.equal(capped.retryAfter, 60);
    now = 60_001;
    assert.ok(l.begin("t").ok, "failures age out");
  });

  it("done() is idempotent", () => {
    const l = new ShareFailureLimiter(1, 60_000);
    const a = l.begin("t");
    assert.ok(a.ok);
    a.done(false);
    a.done(true);
    assert.ok(l.begin("t").ok);
  });

  it("a flood of unrecorded keys never displaces a live share", () => {
    let now = 0;
    const l = new ShareFailureLimiter(3, 60_000, () => now, 50);
    for (let i = 0; i < 3; i++) {
      const a = l.begin("target");
      if (a.ok) a.done(true);
    }
    for (let i = 0; i < 100_000; i++) {
      now += 0.1;
      const a = l.begin(`bogus-${i}`);
      assert.ok(a.ok, "unknown tokens are never refused for capacity");
      a.done(false);
    }
    assert.ok(!l.begin("target").ok);
  });

  it("past capacity refuses new shares instead of evicting live ones", () => {
    let now = 0;
    const l = new ShareFailureLimiter(3, 60_000, () => now, 50);
    const fail = (key: string) => {
      const a = l.begin(key);
      if (a.ok) a.done(true);
      return a.ok;
    };
    for (let i = 0; i < 3; i++) fail("target");
    for (let i = 0; i < 49; i++) assert.ok(fail(`share-${i}`));
    const refused = l.begin("share-new");
    assert.ok(!refused.ok, "table full of live shares");
    assert.equal(refused.retryAfter, 60);
    assert.ok(!l.begin("target").ok, "the guessed share is still capped");
    assert.ok(l.begin("share-0").ok, "tracked shares keep their own budget");
    now = 60_001;
    assert.ok(fail("share-new"), "room again once entries expire");
  });
});

describe("SlidingWindowLimiter capacity", () => {
  it("keeps a client hammering at its limit; evicts idle ones first", () => {
    let now = 0;
    const l = new SlidingWindowLimiter(2, 60_000, () => now, 10);
    l.acquire("attacker");
    l.acquire("attacker");
    for (let i = 0; i < 9; i++) {
      now += 1;
      l.acquire(`client-${i}`);
      assert.ok(!l.acquire("attacker").ok, "refusals keep the key fresh");
    }
    for (let i = 0; i < 20; i++) {
      now += 1;
      l.acquire(`other-${i}`);
      assert.ok(!l.acquire("attacker").ok);
    }
  });
});

const LIMITS: AuthRateLimit = {
  perIp: 5,
  perToken: 3,
  windowSecs: 60,
  upstreamMax: 0,
  upstreamWindowSecs: 60,
  maxConcurrent: 0,
  maxClientKeys: 20,
  maxShareKeys: 20,
};

let n = 0;
const freshIp = () => `198.51.${(n >> 8) & 255}.${n++ & 255}`;

function post(app: FastifyInstance, token: string, password = "wrong", ip = freshIp()) {
  return app.inject({
    method: "POST",
    url: `/share/${token}/auth`,
    remoteAddress: ip,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
    },
    payload: `password=${encodeURIComponent(password)}`,
  });
}

async function setup(
  opts: { limits?: Partial<AuthRateLimit>; fake?: FakeOptions; verifyTimeoutMs?: number } = {},
) {
  const fake = await startFakeOxiCloud([], opts.fake);
  const app = await buildApp({
    upstream: new UpstreamClient(fake.url, opts.verifyTimeoutMs),
    publicBaseUrl: "https://share.example",
    forwardClientIp: true,
    authRateLimit: { ...LIMITS, ...opts.limits },
  });
  const capTarget = async () => {
    for (let i = 0; i < 3; i++) assert.equal((await post(app, PW_TOKEN)).statusCode, 200);
    assert.equal((await post(app, PW_TOKEN)).statusCode, 429);
  };
  return { fake, app, capTarget, close: async () => (await app.close(), await fake.close()) };
}

describe("per-share limit under table saturation (UPSTREAM_FORWARD_CLIENT_IP=true)", () => {
  it("unknown tokens from many clients cannot evict the guessed share", async () => {
    const { fake, app, capTarget, close } = await setup();
    try {
      await capTarget();
      for (let i = 0; i < 100; i++) {
        assert.equal((await post(app, `no-such-${i}`)).statusCode, 410);
      }
      const before = fake.verifies.length;
      assert.equal((await post(app, PW_TOKEN)).statusCode, 429);
      assert.equal((await post(app, PW_TOKEN, PASSWORD)).statusCode, 429);
      assert.equal(fake.verifies.length, before, "no guess reached OxiCloud");
    } finally {
      await close();
    }
  });

  it("wrong guesses at many real shares refuse new shares rather than evict", async () => {
    const { app, capTarget, close } = await setup();
    try {
      await capTarget();
      const codes = [];
      for (let i = 0; i < 30; i++) codes.push((await post(app, `pw-${i}`)).statusCode);
      // 19 more shares fit beside the target; the rest wait for room.
      assert.deepEqual(codes.slice(0, 19), Array(19).fill(200));
      assert.deepEqual(codes.slice(19), Array(11).fill(429));
      assert.equal((await post(app, PW_TOKEN)).statusCode, 429, "target still capped");
      // Shares already tracked keep their own budget. An untracked token is
      // refused too while the table is full: whether it exists is only known
      // after asking OxiCloud, and an unrecorded failure would be a free guess.
      assert.equal((await post(app, "pw-0")).statusCode, 200);
      assert.equal((await post(app, "no-such-share")).statusCode, 429);
    } finally {
      await close();
    }
  });

  it("concurrent guesses cannot overshoot the per-share cap", async () => {
    const { fake, app, close } = await setup();
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => post(app, PW_TOKEN)),
      );
      const codes = results.map((r) => r.statusCode);
      assert.equal(codes.filter((c) => c === 200).length, 3);
      assert.equal(codes.filter((c) => c === 429).length, 17);
      assert.equal(fake.verifies.filter((v) => v.token === PW_TOKEN).length, 3);
    } finally {
      await close();
    }
  });

  it("a concurrent flood of unknown tokens does not free the guessed share", async () => {
    const { app, capTarget, close } = await setup();
    try {
      await capTarget();
      const flood = Array.from({ length: 60 }, (_, i) => post(app, `no-such-${i}`));
      const during = post(app, PW_TOKEN);
      await Promise.all(flood);
      assert.equal((await during).statusCode, 429);
      assert.equal((await post(app, PW_TOKEN)).statusCode, 429);
    } finally {
      await close();
    }
  });

  it("unknown tokens still count against the client", async () => {
    const { app, close } = await setup();
    try {
      const ip = "203.0.113.200";
      for (let i = 0; i < 5; i++) {
        assert.equal((await post(app, `no-such-${i}`, "x", ip)).statusCode, 410);
      }
      assert.equal((await post(app, "no-such-5", "x", ip)).statusCode, 429);
    } finally {
      await close();
    }
  });
});

describe("password checks in flight (slow or hung OxiCloud)", () => {
  it("caps concurrent checks across all clients and tokens", async () => {
    const { fake, app, close } = await setup({
      limits: { maxConcurrent: 2, perToken: 100 },
      fake: { verifyDelayMs: 200 },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => post(app, i % 2 ? PW_TOKEN : `pw-${i}`)),
      );
      const codes = results.map((r) => r.statusCode);
      assert.equal(codes.filter((c) => c === 200).length, 2);
      const refused = results.filter((r) => r.statusCode === 429);
      assert.equal(refused.length, 6);
      for (const r of refused) assert.equal(r.headers["retry-after"], "1");
      assert.equal(fake.verifies.length, 2, "refused checks never reached OxiCloud");
      // Slots are free again once the checks finish.
      assert.equal((await post(app, PW_TOKEN)).statusCode, 200);
    } finally {
      await close();
    }
  });

  it("the cap reserves nothing for refused checks", async () => {
    const { app, close } = await setup({
      limits: { maxConcurrent: 1, perToken: 2 },
      fake: { verifyDelayMs: 100 },
    });
    try {
      const ip = "203.0.113.77";
      const [first, second] = await Promise.all([
        post(app, PW_TOKEN, "wrong", ip),
        post(app, PW_TOKEN, "wrong", ip),
      ]);
      assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 429]);
      // One failure recorded for the share and the client; one attempt each left.
      assert.equal((await post(app, PW_TOKEN, "wrong", ip)).statusCode, 200);
      assert.equal((await post(app, PW_TOKEN, "wrong", "203.0.113.78")).statusCode, 429);
    } finally {
      await close();
    }
  });

  it("a hung OxiCloud times out; the check counts, the slot is freed", async () => {
    const { fake, app, close } = await setup({
      limits: { maxConcurrent: 1, perToken: 2, perIp: 2 },
      fake: { verifyDelayMs: 5_000 },
      verifyTimeoutMs: 100,
    });
    try {
      const started = Date.now();
      const res = await post(app, PW_TOKEN, "wrong", "203.0.113.90");
      assert.ok(Date.now() - started < 2_000, "did not wait for OxiCloud");
      assert.equal(res.statusCode, 502);
      assert.match(res.body, /Something went wrong/);
      // The concurrency slot is free again at once...
      assert.equal((await post(app, "pw-1", "wrong", "203.0.113.91")).statusCode, 502);
      // ...but OxiCloud may have tested those passwords, so they count: the
      // share has one check left, and so does the first client.
      assert.equal((await post(app, PW_TOKEN, "wrong", "203.0.113.92")).statusCode, 502);
      assert.equal((await post(app, PW_TOKEN, "wrong", "203.0.113.93")).statusCode, 429);
      assert.equal((await post(app, "pw-2", "wrong", "203.0.113.90")).statusCode, 502);
      assert.equal((await post(app, "pw-3", "wrong", "203.0.113.90")).statusCode, 429);
      assert.equal(fake.verifies.length, 4);
    } finally {
      await close();
    }
  });

  it("a 5xx from OxiCloud counts against the share and the client", async () => {
    const { app, close } = await setup({ limits: { perToken: 1, perIp: 1 } });
    try {
      assert.equal((await post(app, "tok-500", "wrong", "203.0.113.95")).statusCode, 502);
      assert.equal((await post(app, "tok-500", "wrong", "203.0.113.96")).statusCode, 429);
      assert.equal((await post(app, "no-such", "wrong", "203.0.113.95")).statusCode, 429);
    } finally {
      await close();
    }
  });
});
