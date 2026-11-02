import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { UpstreamClient } from "./upstream.js";
import { buildApp } from "./app.js";

const config = loadConfig();

const app = await buildApp({
  upstream: new UpstreamClient(config.oxicloudInternalUrl),
  publicBaseUrl: config.publicBaseUrl,
  logger: {
    level: config.logLevel,
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } },
  },
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
