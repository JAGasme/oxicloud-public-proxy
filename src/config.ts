export interface Config {
  oxicloudInternalUrl: string;
  publicBaseUrl: string;
  port: number;
  host: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  hstsMaxAge: number;
  /** Fastify trustProxy: true, false, or a list of IPs/CIDRs/proxy-addr names. */
  trustProxy: boolean | string[];
  /** Header the front proxy sets to the visitor's IP (e.g. cf-connecting-ip). */
  clientIpHeader?: string;
  /** Send the visitor's IP to OxiCloud as X-Forwarded-For on password checks. */
  forwardClientIp: boolean;
  authRateLimit: AuthRateLimit;
}

export interface AuthRateLimit {
  /** Failed password attempts per client (IPv6: per /64) per window; 0 = off. */
  perIp: number;
  /** Failed password attempts per share token per window; 0 = off. */
  perToken: number;
  windowSecs: number;
  /** Verify calls per OxiCloud rate-limit key before OxiCloud's window resets; 0 = off. */
  upstreamMax: number;
  upstreamWindowSecs: number;
  /** Password checks waiting on OxiCloud at once, across all clients; 0 = off. */
  maxConcurrent: number;
  /** Table sizes (see src/ratelimit.ts); not configurable by env, for tests. */
  maxClientKeys?: number;
  maxShareKeys?: number;
}

export const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimit = {
  perIp: 5,
  perToken: 10,
  windowSecs: 60,
  // OxiCloud's default is 10 per 60 s (OXICLOUD_RATE_LIMIT_LOGIN_MAX/_WINDOW_SECS).
  upstreamMax: 8,
  upstreamWindowSecs: 60,
  maxConcurrent: 16,
};

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(
      `[config] Missing required env var ${name}. Set it and restart.`,
    );
    process.exit(1);
  }
  return value.trim();
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function loadConfig(): Config {
  const oxicloudInternalUrl = stripTrailingSlash(required("OXICLOUD_INTERNAL_URL"));
  const publicBaseUrl = stripTrailingSlash(required("PUBLIC_BASE_URL"));

  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[config] Invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }

  const logLevel = (process.env.LOG_LEVEL ?? "info") as Config["logLevel"];

  const hstsMaxAge = Number(process.env.HSTS_MAX_AGE ?? 31536000);
  if (!Number.isInteger(hstsMaxAge) || hstsMaxAge < 0) {
    console.error(`[config] Invalid HSTS_MAX_AGE: ${process.env.HSTS_MAX_AGE}`);
    process.exit(1);
  }

  const clientIpHeader = process.env.CLIENT_IP_HEADER?.trim().toLowerCase() || undefined;

  const authRateLimit: AuthRateLimit = {
    perIp: intEnv("AUTH_RATE_LIMIT_PER_IP", DEFAULT_AUTH_RATE_LIMIT.perIp, 0),
    perToken: intEnv("AUTH_RATE_LIMIT_PER_TOKEN", DEFAULT_AUTH_RATE_LIMIT.perToken, 0),
    windowSecs: intEnv("AUTH_RATE_LIMIT_WINDOW_SECS", DEFAULT_AUTH_RATE_LIMIT.windowSecs, 1),
    upstreamMax: intEnv("UPSTREAM_VERIFY_MAX", DEFAULT_AUTH_RATE_LIMIT.upstreamMax, 0),
    upstreamWindowSecs: intEnv(
      "UPSTREAM_VERIFY_WINDOW_SECS",
      DEFAULT_AUTH_RATE_LIMIT.upstreamWindowSecs,
      1,
    ),
    maxConcurrent: intEnv("AUTH_MAX_CONCURRENT", DEFAULT_AUTH_RATE_LIMIT.maxConcurrent, 0),
  };

  return {
    oxicloudInternalUrl,
    publicBaseUrl,
    port,
    host: process.env.HOST ?? "0.0.0.0",
    logLevel,
    hstsMaxAge,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    ...(clientIpHeader ? { clientIpHeader } : {}),
    forwardClientIp: boolEnv("UPSTREAM_FORWARD_CLIENT_IP"),
    authRateLimit,
  };
}

// Where a TLS-terminating reverse proxy normally connects from: the same host,
// a Docker network or a LAN/VPN. A visitor connecting from a public address
// cannot have its X-Forwarded-* headers believed.
export const DEFAULT_TRUST_PROXY = ["loopback", "linklocal", "uniquelocal"];

/**
 * TRUST_PROXY: a comma-separated list of the reverse proxy's IPs/CIDRs (or the
 * proxy-addr names loopback, linklocal, uniquelocal); "false" trusts nothing;
 * "true" trusts every hop, which lets any client choose its own address.
 */
export function parseTrustProxy(raw: string | undefined): boolean | string[] {
  const v = (raw ?? "").trim();
  if (v === "") return DEFAULT_TRUST_PROXY;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) {
    // Fastify >= 5.8 trusts nobody for a bare hop count (it cannot validate the peer).
    console.error(`[config] TRUST_PROXY=${v}: hop counts are not supported; list the proxy's IPs/CIDRs`);
    process.exit(1);
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`[config] Invalid ${name}: ${raw}`);
    process.exit(1);
  }
  return n;
}

function boolEnv(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (v === "" || v === "false" || v === "0") return false;
  if (v === "true" || v === "1") return true;
  console.error(`[config] Invalid ${name}: ${process.env[name]}`);
  process.exit(1);
}
