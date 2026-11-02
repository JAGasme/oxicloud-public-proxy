import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import fastifyFormbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import fastifyView from "@fastify/view";
import ejs from "ejs";
import type { UpstreamClient } from "./upstream.js";
import { shareRoutes } from "./routes/share.js";

export interface BuildAppOptions {
  upstream: UpstreamClient;
  publicBaseUrl: string;
  logger?: FastifyServerOptions["logger"];
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The proxy without listen() or signal handling, so tests can inject(). */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(fastifyFormbody);

  await app.register(fastifyView, {
    engine: { ejs },
    root: path.join(rootDir, "views"),
    defaultContext: {
      publicBaseUrl: opts.publicBaseUrl,
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

  const { upstream } = opts;
  await app.register(async (instance) => {
    await shareRoutes(instance, { upstream });
  });

  return app;
}
