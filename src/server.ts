import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyFormbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import fastifyView from "@fastify/view";
import ejs from "ejs";
import { loadConfig } from "./config.js";
import { UpstreamClient } from "./upstream.js";
import { shareRoutes } from "./routes/share.js";

const config = loadConfig();

const app = Fastify({
  logger: {
    level: config.logLevel,
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } },
  },
  trustProxy: true,
  bodyLimit: 64 * 1024,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await app.register(fastifyFormbody);

await app.register(fastifyView, {
  engine: { ejs },
  root: path.resolve(__dirname, "..", "views"),
  defaultContext: {
    publicBaseUrl: config.publicBaseUrl,
  },
});

await app.register(fastifyStatic, {
  root: path.resolve(__dirname, "..", "public"),
  prefix: "/public/",
  cacheControl: true,
  maxAge: 86400 * 1000,
});

app.get("/", async (_req, reply) => {
  return reply.view("index.ejs");
});

const upstream = new UpstreamClient(config.oxicloudInternalUrl);

await app.register(async (instance) => {
  await shareRoutes(instance, { upstream });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  });
}

const pkgVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      upstream: config.oxicloudInternalUrl,
      publicBaseUrl: config.publicBaseUrl,
      // Logged so a stale build on the edge is visible at a glance.
      version: pkgVersion,
      node: process.version,
    },
    "oxicloud-public-proxy listening",
  );
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
