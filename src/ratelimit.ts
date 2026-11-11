import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

// Rate limiting for POST /share/:token/auth.
//
// OxiCloud guards /api/s/{token}/verify with its own per-IP limiter
// (OXICLOUD_RATE_LIMIT_LOGIN_MAX / _WINDOW_SECS, default 10 per 60 s). It
// counts EVERY request, correct passwords included, and its TTL restarts on
// each request, so the counter only resets after a full quiet window. Unless
// OxiCloud trusts this proxy's X-Forwarded-For (OXICLOUD_TRUST_PROXY_CIDR plus
// UPSTREAM_FORWARD_CLIENT_IP), every visitor shares the proxy's one IP there:
// a few wrong guesses would lock all visitors out of every share for minutes.
//
// So the proxy keeps three limits, all in memory and per instance:
//  - per client (SlidingWindowLimiter): attempts per IP or IPv6 /64;
//  - per share (ShareFailureLimiter): wrong passwords per token, from all
//    clients together. This is the bound on guessing one share's password,
//    so its live state is never evicted (see there);
//  - an UpstreamBudget mirroring OxiCloud's counter for each key OxiCloud will
//    see, so the proxy refuses (429 + Retry-After) before OxiCloud would.

export type Acquire =
  | { ok: true; release: () => void }
  | { ok: false; retryAfter: number };

export const MAX_KEYS = 10_000;
/** Live per-share entries before new shares are refused (see ShareFailureLimiter). */
export const MAX_SHARE_KEYS = 100_000;
// A full sweep of expired keys costs O(keys); run it at most this often.
const SWEEP_INTERVAL_MS = 1000;

/**
 * Sliding-window log: at most `max` held slots per key within `windowMs`.
 * A slot is taken before the upstream call (so concurrent requests cannot all
 * slip through) and can be handed back with release(), e.g. on success.
 *
 * Keys are clients, whose number an attacker with many addresses controls, so
 * memory is capped at `maxKeys` by evicting the least recently used keys,
 * live ones included. That only ever resets some client's own budget, which
 * is no more than holding another address; refusing new clients instead would
 * let a full table lock out everyone. The per-share limit, which does not
 * evict, still bounds the guesses at any one share.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = -Infinity;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  acquire(key: string): Acquire {
    if (this.max <= 0) return { ok: true, release: () => {} };
    const now = this.now();
    const live = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    // Re-insert at the end either way: Map order is the eviction order, and a
    // client hammering at its limit must be the last to be forgotten.
    this.hits.delete(key);
    this.hits.set(key, live);
    if (live.length >= this.max) {
      return { ok: false, retryAfter: secondsUntil(live[0]! + this.windowMs, now) };
    }
    live.push(now);
    this.prune(now);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const list = this.hits.get(key);
        const i = list?.indexOf(now) ?? -1;
        if (list && i >= 0) list.splice(i, 1);
      },
    };
  }

  private prune(now: number): void {
    if (this.hits.size <= this.maxKeys) return;
    if (now - this.lastSweep >= SWEEP_INTERVAL_MS) {
      this.lastSweep = now;
      for (const [k, list] of this.hits) {
        if (!list.some((t) => t > now - this.windowMs)) this.hits.delete(k);
      }
    }
    // Still full: drop the least recently used keys (see the class comment).
    for (const k of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}

export type Attempt =
  | { ok: true; done: (failed: boolean) => void }
  | { ok: false; retryAfter: number };

/**
 * Wrong passwords per share token: at most `max` failures plus in-flight
 * checks per token within `windowMs`.
 *
 * Unlike the per-client limit, this one must not forget a share that is
 * being guessed, or flooding the table with other keys would buy more
 * guesses. So:
 *  - a token is only recorded (`done(true)`) on a 401, which OxiCloud returns
 *    only for an existing, unexpired, password-protected share, or on a check
 *    whose outcome is unknown (timeout, error), since OxiCloud may still have
 *    tested the password. Unknown, expired and password-less tokens that
 *    OxiCloud answers never enter the table, so a flood of made-up tokens
 *    cannot fill it (timeouts are bounded by the in-flight cap);
 *  - checks in flight are counted separately and always removed when they
 *    finish, so concurrent requests cannot overshoot `max` or fill the table;
 *  - live entries are never evicted. Past `maxKeys` live shares, NEW shares
 *    are refused until entries expire; reaching that takes wrong guesses at
 *    more than `maxKeys` distinct real password-protected shares in one
 *    window. Checks in flight do not count towards that capacity (else a
 *    concurrent burst of made-up tokens could fill it), so it can be
 *    overshot by at most the number of checks in flight, which the route
 *    caps (AUTH_MAX_CONCURRENT) and the upstream timeout ends.
 */
export class ShareFailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();
  private lastSweep = -Infinity;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = MAX_SHARE_KEYS,
  ) {}

  begin(key: string): Attempt {
    if (this.max <= 0) return { ok: true, done: () => {} };
    const now = this.now();
    const live = this.live(key, now);
    const pending = this.inFlight.get(key) ?? 0;
    if (live.length + pending >= this.max) {
      // All in flight and none recorded yet: they finish in well under 1 s.
      return { ok: false, retryAfter: live.length ? secondsUntil(live[0]! + this.windowMs, now) : 1 };
    }
    if (live.length === 0 && this.full(now)) {
      return { ok: false, retryAfter: secondsUntil(this.oldestExpiry(), now) };
    }
    this.inFlight.set(key, pending + 1);
    let finished = false;
    return {
      ok: true,
      done: (failed: boolean) => {
        if (finished) return;
        finished = true;
        const left = (this.inFlight.get(key) ?? 1) - 1;
        if (left > 0) this.inFlight.set(key, left);
        else this.inFlight.delete(key);
        if (!failed) return;
        const at = this.now();
        const list = this.live(key, at);
        list.push(at);
        this.failures.set(key, list);
      },
    };
  }

  private live(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  private full(now: number): boolean {
    if (this.failures.size < this.maxKeys) return false;
    if (now - this.lastSweep >= SWEEP_INTERVAL_MS) {
      this.lastSweep = now;
      for (const k of [...this.failures.keys()]) this.live(k, now);
    }
    return this.failures.size >= this.maxKeys;
  }

  private oldestExpiry(): number {
    let oldest = Infinity;
    for (const list of this.failures.values()) oldest = Math.min(oldest, list[list.length - 1]!);
    return oldest + this.windowMs;
  }
}

/**
 * Mirror of OxiCloud's limiter for one upstream key: the count restarts only
 * after `windowMs` without any request. Refuses once `max` requests are in
 * the current run, which must stay below OxiCloud's own maximum.
 */
export class UpstreamBudget {
  // Keys are "proxy", or client IPs with UPSTREAM_FORWARD_CLIENT_IP. Evicting
  // a live client key can only let that client's checks reach OxiCloud, whose
  // own limiter then answers 429 and trips this key again; the per-share
  // limit still bounds the guesses.
  private readonly state = new Map<string, { count: number; last: number; blockedUntil: number }>();
  private lastSweep = -Infinity;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  acquire(key: string): Acquire {
    const now = this.now();
    let s = this.state.get(key);
    if (s && now - s.last >= this.windowMs && now >= s.blockedUntil) s = undefined;
    // With the mirror off (max 0) an upstream 429 is still honoured.
    if (this.max <= 0 && !(s && now < s.blockedUntil)) return { ok: true, release: () => {} };
    if (s && ((this.max > 0 && s.count >= this.max) || now < s.blockedUntil)) {
      return {
        ok: false,
        retryAfter: secondsUntil(Math.max(s.last + this.windowMs, s.blockedUntil), now),
      };
    }
    s = { count: (s?.count ?? 0) + 1, last: now, blockedUntil: s?.blockedUntil ?? 0 };
    this.state.delete(key);
    this.state.set(key, s);
    this.prune(now);
    // OxiCloud counted the request whatever its outcome: nothing to release.
    return { ok: true, release: () => {} };
  }

  /** OxiCloud answered 429 anyway (other callers, lower limit): back off. */
  tripped(key: string, retryAfterSecs: number | null): void {
    const now = this.now();
    const wait = Math.max(retryAfterSecs ?? 0, this.windowMs / 1000) * 1000;
    this.state.delete(key);
    this.state.set(key, { count: Math.max(this.max, 1), last: now, blockedUntil: now + wait });
    this.prune(now);
  }

  private prune(now: number): void {
    if (this.state.size <= this.maxKeys) return;
    if (now - this.lastSweep >= SWEEP_INTERVAL_MS) {
      this.lastSweep = now;
      for (const [k, s] of this.state) {
        if (now - s.last >= this.windowMs && now >= s.blockedUntil) this.state.delete(k);
      }
    }
    for (const k of this.state.keys()) {
      if (this.state.size <= this.maxKeys) break;
      this.state.delete(k);
    }
  }
}

function secondsUntil(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 1000));
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date), or null. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * The visitor's address: req.ip, which honours TRUST_PROXY. `clientIpHeader`
 * (e.g. cf-connecting-ip) overrides it only on a request that came through a
 * trusted proxy (req.ips has a forwarded hop) and only with a valid IP: it
 * must be a header the front proxy always overwrites.
 */
export function clientIp(req: FastifyRequest, clientIpHeader?: string): string {
  if (clientIpHeader && (req.ips?.length ?? 0) > 1) {
    const raw = req.headers[clientIpHeader];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value && isIP(value)) return normalizeIp(value);
  }
  return normalizeIp(req.ip);
}

/** IPv4-mapped IPv6 to IPv4; anything else unchanged. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

/**
 * Rate-limit key for an address: IPv4 as is, IPv6 by its /64, since one
 * subscriber usually holds a whole /64 and could rotate through it.
 */
export function limiterKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  return `${expandIpv6(ip).slice(0, 4).join(":")}::/64`;
}

function expandIpv6(ip: string): string[] {
  const [head = "", tail] = ip.split("%")[0]!.split("::") as [string, string?];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  // An embedded IPv4 tail (::1.2.3.4) counts as two groups.
  const last = t.length ? t : h;
  if (last.length && last[last.length - 1]!.includes(".")) last.splice(-1, 1, "0", "0");
  const fill = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((g) => (parseInt(g, 16) || 0).toString(16));
}
