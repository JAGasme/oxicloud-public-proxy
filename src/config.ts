export interface Config {
  oxicloudInternalUrl: string;
  publicBaseUrl: string;
  port: number;
  host: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  hstsMaxAge: number;
}

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

  return {
    oxicloudInternalUrl,
    publicBaseUrl,
    port,
    host: process.env.HOST ?? "0.0.0.0",
    logLevel,
    hstsMaxAge,
  };
}
