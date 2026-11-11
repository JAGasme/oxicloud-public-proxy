import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import fastifyFormbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import fastifyView from "@fastify/view";
import ejs from "ejs";
import type { UpstreamClient } from "./upstream.js";
import { shareRoutes } from "./routes/share.js";
import { registerSecurityHeaders } from "./security.js";
import { type AuthRateLimit, DEFAULT_AUTH_RATE_LIMIT, DEFAULT_TRUST_PROXY } from "./config.js";

export interface BuildAppOptions {
  upstream: UpstreamClient;
  publicBaseUrl: string;
  logger?: FastifyServerOptions["logger"];
  /** Strict-Transport-Security max-age in seconds; 0 disables. Default 1 year. */
  hstsMaxAge?: number;
  /** Fastify trustProxy. Default: loopback, link-local and private ranges. */
  trustProxy?: boolean | string[];
  /** Header the front proxy sets to the visitor's IP, e.g. "cf-connecting-ip". */
  clientIpHeader?: string;
  /** Send the visitor's IP to OxiCloud as X-Forwarded-For on password checks. */
  forwardClientIp?: boolean;
  authRateLimit?: Partial<AuthRateLimit>;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Appended to /public asset URLs so a release busts the 1-day static cache.
const assetVersion = (
  JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version: string }
).version;

/** The proxy without listen() or signal handling, so tests can inject(). */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.trustProxy ?? DEFAULT_TRUST_PROXY,
    bodyLimit: 64 * 1024,
  });

  // First, so the headers also cover static files and 404s.
  registerSecurityHeaders(app, { hstsMaxAge: opts.hstsMaxAge ?? 31536000 });

  await app.register(fastifyFormbody);

  await app.register(fastifyView, {
    engine: { ejs },
    root: path.join(rootDir, "views"),
    defaultContext: {
      publicBaseUrl: opts.publicBaseUrl,
      assetVersion: encodeURIComponent(assetVersion),
    },
  });

  await app.register(fastifyStatic, {
    root: path.join(rootDir, "public"),
    prefix: "/public/",
    cacheControl: true,
    maxAge: 86400 * 1000,
  });

  app.get("/", async (_req, reply) => {
    return reply.view("index.ejs");
  });

  // Fastify's defaults answer in JSON that names the route, the framework and
  // the parser error. Keep the status, drop the details.
  app.setNotFoundHandler(async (_req, reply) => {
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  });
  app.setErrorHandler<FastifyError>(async (err, req, reply) => {
    const status =
      typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500
        ? err.statusCode
        : 500;
    if (status === 500) req.log.error({ err }, "unhandled error");
    return reply
      .code(status)
      .type("text/plain; charset=utf-8")
      .send(status === 500 ? "Internal server error" : "Bad request");
  });

  const { upstream } = opts;
  const publicOrigin = new URL(opts.publicBaseUrl).origin;
  await app.register(async (instance) => {
    await shareRoutes(instance, {
      upstream,
      publicOrigin,
      ...(opts.clientIpHeader ? { clientIpHeader: opts.clientIpHeader } : {}),
      forwardClientIp: opts.forwardClientIp ?? false,
      authRateLimit: { ...DEFAULT_AUTH_RATE_LIMIT, ...opts.authRateLimit },
    });
  });

  return app;
}
