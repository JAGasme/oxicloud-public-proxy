import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UpstreamClient } from "../upstream.js";
import { type Lang, type T, makeT, resolveLang } from "../i18n.js";
import { markAsSharedFile } from "../security.js";
import type { AuthRateLimit } from "../config.js";
import {
  SlidingWindowLimiter,
  UpstreamBudget,
  clientIp,
  limiterKey,
} from "../ratelimit.js";

const TOKEN_RE = /^[A-Za-z0-9-]{1,64}$/;

interface ShareParams {
  token: string;
}

// Generous for a share password, and bounded well below the 64 KiB body cap.
const MAX_PASSWORD_LENGTH = 1024;

interface AuthBody {
  password?: unknown;
}

export interface ShareRoutesDeps {
  upstream: UpstreamClient;
  /** Origin of PUBLIC_BASE_URL, accepted on the password form's POST. */
  publicOrigin: string;
  clientIpHeader?: string;
  forwardClientIp: boolean;
  authRateLimit: AuthRateLimit;
}

export async function shareRoutes(
  app: FastifyInstance,
  deps: ShareRoutesDeps,
): Promise<void> {
  const { upstream } = deps;
  const limits = deps.authRateLimit;
  const perIp = new SlidingWindowLimiter(limits.perIp, limits.windowSecs * 1000);
  const perToken = new SlidingWindowLimiter(limits.perToken, limits.windowSecs * 1000);
  const upstreamBudget = new UpstreamBudget(limits.upstreamMax, limits.upstreamWindowSecs * 1000);

  const renderFolderGallery = async (
    reply: FastifyReply,
    token: string,
    folderId: string | null,
    titleHint: string,
    cookieHeader: string | undefined,
    lang: Lang,
    t: T,
  ): Promise<unknown> => {
    const listing = await upstream.listContents(token, folderId, cookieHeader);
    switch (listing.kind) {
      case "ok":
        return reply.view("folder.ejs", {
          token,
          folderId,
          title: titleHint,
          folders: listing.data.folders,
          files: listing.data.files,
          lang,
          t,
        });
      case "password-required":
        return reply.view("share.ejs", {
          state: "password",
          token,
          error: null,
          lang,
          t,
        });
      case "not-folder-share":
        return reply.redirect(`/share/${encodeURIComponent(token)}`, 303);
      case "expired":
      case "not-found":
        return renderExpired(reply, lang, t);
      case "upstream-error":
        return renderError(reply, listing.status, lang, t);
    }
  };

  // ── Liveness ──────────────────────────────────────────────────────────────
  app.get("/healthcheck", async (_req, reply) => {
    return reply.code(200).type("text/plain").send("ok");
  });

  // ── Compatibility redirect for OxiCloud-native share URLs ────────────────
  // OxiCloud generates `/s/<token>` (hardcoded in share_dto.rs). The proxy
  // canonicalises to `/share/<token>`.
  app.get<{ Params: ShareParams }>("/s/:token", async (req, reply) => {
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) {
      return reply.code(404).send();
    }
    return reply.redirect(`/share/${encodeURIComponent(token)}`, 301);
  });

  // ── Share page ────────────────────────────────────────────────────────────
  app.get<{ Params: ShareParams }>("/share/:token", async (req, reply) => {
    const { lang, t } = i18nFor(req);
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) {
      return renderExpired(reply, lang, t);
    }

    const cookieHeader = req.headers.cookie;
    const result = await upstream.getMetadata(token, cookieHeader);

    switch (result.kind) {
      case "ok":
        if (result.data.item_type === "file") {
          return reply.view("share.ejs", {
            state: "file",
            token,
            itemName: result.data.item_name ?? t("file.meta"),
            lang,
            t,
          });
        }
        return await renderFolderGallery(
          reply,
          token,
          null,
          result.data.item_name ?? t("folder.meta"),
          cookieHeader,
          lang,
          t,
        );

      case "password-required":
        return reply.view("share.ejs", {
          state: "password",
          token,
          error: null,
          lang,
          t,
        });

      case "expired":
      case "not-found":
        return renderExpired(reply, lang, t);

      case "upstream-error":
        req.log.warn(
          { status: result.status, detail: result.detail },
          "upstream error on getMetadata",
        );
        return renderError(reply, result.status, lang, t);
    }
  });

  // ── Subfolder gallery ─────────────────────────────────────────────────────
  app.get<{ Params: { token: string; folderId: string } }>(
    "/share/:token/folder/:folderId",
    async (req, reply) => {
      const { lang, t } = i18nFor(req);
      const { token, folderId } = req.params;
      if (!TOKEN_RE.test(token) || !TOKEN_RE.test(folderId)) {
        return renderExpired(reply, lang, t);
      }
      return await renderFolderGallery(
        reply,
        token,
        folderId,
        t("folder.meta"),
        req.headers.cookie,
        lang,
        t,
      );
    },
  );

  // ── File download from folder share (transparent pipe-through) ────────────
  app.get<{ Params: { token: string; fileId: string } }>(
    "/share/:token/file/:fileId",
    async (req, reply) => {
      const { lang, t } = i18nFor(req);
      const { token, fileId } = req.params;
      if (!TOKEN_RE.test(token) || !TOKEN_RE.test(fileId)) {
        return renderExpired(reply, lang, t);
      }

      const upstreamRes = await upstream.downloadFileInFolder(
        token,
        fileId,
        req.headers.cookie,
        req.headers.range,
        req.headers["if-none-match"],
      );

      if (upstreamRes.status === 401) {
        return reply.redirect(`/share/${encodeURIComponent(token)}`, 303);
      }
      if (upstreamRes.status === 410 || upstreamRes.status === 404) {
        return renderExpired(reply, lang, t);
      }

      reply.code(upstreamRes.status);
      sharedFileHeaders(upstreamRes, reply);
      forwardHeader(upstreamRes, reply, "content-length");
      forwardHeader(upstreamRes, reply, "content-range");
      forwardHeader(upstreamRes, reply, "accept-ranges");
      forwardHeader(upstreamRes, reply, "etag");

      if (upstreamRes.status === 304 || !upstreamRes.body) {
        return reply.send();
      }
      return reply.send(Readable.fromWeb(upstreamRes.body as never));
    },
  );

  // ── ZIP download (root or subfolder) ──────────────────────────────────────
  const zipHandler = async (
    req: import("fastify").FastifyRequest<{
      Params: { token: string; folderId?: string };
    }>,
    reply: FastifyReply,
  ): Promise<unknown> => {
    const { lang, t } = i18nFor(req);
    const { token, folderId } = req.params;
    if (!TOKEN_RE.test(token)) {
      return renderExpired(reply, lang, t);
    }
    if (folderId && !TOKEN_RE.test(folderId)) {
      return renderExpired(reply, lang, t);
    }

    const upstreamRes = await upstream.downloadZip(
      token,
      folderId ?? null,
      req.headers.cookie,
    );

    if (upstreamRes.status === 401) {
      return reply.redirect(`/share/${encodeURIComponent(token)}`, 303);
    }
    if (upstreamRes.status === 410 || upstreamRes.status === 404) {
      return renderExpired(reply, lang, t);
    }
    if (!upstreamRes.ok) {
      return renderError(reply, upstreamRes.status, lang, t);
    }

    reply.code(upstreamRes.status);
    sharedFileHeaders(upstreamRes, reply);
    forwardHeader(upstreamRes, reply, "content-length");

    if (!upstreamRes.body) {
      return reply.send();
    }
    return reply.send(Readable.fromWeb(upstreamRes.body as never));
  };

  app.get<{ Params: { token: string } }>("/share/:token/zip", zipHandler);
  app.get<{ Params: { token: string; folderId: string } }>(
    "/share/:token/zip/:folderId",
    zipHandler,
  );

  // ── Password submission ───────────────────────────────────────────────────
  app.post<{ Params: ShareParams; Body: AuthBody }>(
    "/share/:token/auth",
    async (req, reply) => {
      const { lang, t } = i18nFor(req);
      const { token } = req.params;
      if (!TOKEN_RE.test(token)) {
        return renderExpired(reply, lang, t);
      }

      // Fetch Metadata / Origin, before anything reaches OxiCloud: a cross-site
      // form must not be able to spend this share's (or everyone's) attempts.
      if (!isSameOriginPost(req, deps.publicOrigin)) {
        return reply.code(403).view("share.ejs", { state: "error", lang, t });
      }

      const password = req.body?.password ?? "";
      if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
        return reply.code(400).view("share.ejs", {
          state: "password",
          token,
          error: t("password.error.required"),
          lang,
          t,
        });
      }
      if (password === "") {
        return reply.view("share.ejs", {
          state: "password",
          token,
          error: t("password.error.required"),
          lang,
          t,
        });
      }

      const rateLimited = (retryAfter: number) =>
        reply
          .code(429)
          .header("Retry-After", String(retryAfter))
          .view("share.ejs", {
            state: "password",
            token,
            error: t("password.error.rate_limited"),
            lang,
            t,
          });

      const ip = clientIp(req, deps.clientIpHeader);
      const byIp = perIp.acquire(limiterKey(ip));
      if (!byIp.ok) return rateLimited(byIp.retryAfter);
      const byToken = perToken.acquire(token);
      if (!byToken.ok) {
        byIp.release();
        return rateLimited(byToken.retryAfter);
      }
      // The key OxiCloud's own limiter will count this request under.
      const upstreamKey = deps.forwardClientIp ? ip : "proxy";
      const budget = upstreamBudget.acquire(upstreamKey);
      if (!budget.ok) {
        byIp.release();
        byToken.release();
        req.log.warn({ retryAfter: budget.retryAfter }, "password check held back: upstream budget spent");
        return rateLimited(budget.retryAfter);
      }

      const result = await upstream.verifyPassword(
        token,
        password,
        deps.forwardClientIp ? ip : undefined,
      );
      // Only failed guesses count against the visitor and the share.
      if (result.kind === "ok" || result.kind === "rate-limited" || result.kind === "upstream-error") {
        byIp.release();
        byToken.release();
      }

      switch (result.kind) {
        case "ok":
          // An array, not one header: fetch joins multiple Set-Cookie values
          // with ", ", which breaks cookies whose attributes contain commas.
          if (result.setCookies.length > 0) {
            reply.header(
              "Set-Cookie",
              result.setCookies.map((c) => scopeUnlockCookie(c, token, req.protocol === "https")),
            );
          }
          return reply.redirect(`/share/${encodeURIComponent(token)}`, 303);

        case "wrong-password":
          return reply.view("share.ejs", {
            state: "password",
            token,
            error: t("password.error.wrong"),
            lang,
            t,
          });

        case "rate-limited": {
          upstreamBudget.tripped(upstreamKey, result.retryAfter);
          req.log.warn({ retryAfter: result.retryAfter }, "OxiCloud rate-limited verifyPassword");
          return rateLimited(Math.max(result.retryAfter ?? 0, limits.upstreamWindowSecs));
        }

        case "expired":
        case "not-found":
          return renderExpired(reply, lang, t);

        case "upstream-error":
          req.log.warn(
            { status: result.status, detail: result.detail },
            "upstream error on verifyPassword",
          );
          return renderError(reply, result.status, lang, t);
      }
    },
  );

  // ── File download (transparent pipe-through) ──────────────────────────────
  app.get<{ Params: ShareParams }>("/share/:token/download", async (req, reply) => {
    const { lang, t } = i18nFor(req);
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) {
      return renderExpired(reply, lang, t);
    }

    const cookieHeader = req.headers.cookie;
    const rangeHeader = req.headers.range;

    const upstreamRes = await upstream.download(token, cookieHeader, rangeHeader);

    if (upstreamRes.status === 401) {
      return reply.redirect(`/share/${encodeURIComponent(token)}`, 303);
    }
    if (upstreamRes.status === 410 || upstreamRes.status === 404) {
      return renderExpired(reply, lang, t);
    }

    reply.code(upstreamRes.status);
    sharedFileHeaders(upstreamRes, reply);
    forwardHeader(upstreamRes, reply, "content-length");
    forwardHeader(upstreamRes, reply, "content-range");
    forwardHeader(upstreamRes, reply, "accept-ranges");

    if (!upstreamRes.body) {
      return reply.send();
    }
    return reply.send(Readable.fromWeb(upstreamRes.body as never));
  });
}

function i18nFor(req: FastifyRequest): { lang: Lang; t: T } {
  const lang = resolveLang(req);
  return { lang, t: makeT(lang) };
}

function forwardHeader(from: Response, reply: FastifyReply, name: string): void {
  const value = from.headers.get(name);
  if (value !== null) reply.header(name, value);
}

function renderExpired(reply: FastifyReply, lang: Lang, t: T) {
  return reply.code(410).view("share.ejs", { state: "expired", lang, t });
}

/** The upstream status is logged by the caller, never shown to the visitor. */
function renderError(reply: FastifyReply, upstreamStatus: number, lang: Lang, t: T) {
  const code =
    upstreamStatus === 429 ? 503 : upstreamStatus >= 500 && upstreamStatus < 600 ? 502 : 500;
  return reply.code(code).view("share.ejs", { state: "error", lang, t });
}

function sharedFileHeaders(from: Response, reply: FastifyReply): void {
  markAsSharedFile(
    reply,
    from.headers.get("content-type"),
    from.headers.get("content-disposition"),
  );
}

/**
 * Whether a POST comes from the proxy's own pages. Fetch Metadata decides when
 * the browser sends it. Otherwise a cross-origin Origin is refused; `null` is
 * let through only there, because this site's no-referrer policy makes older
 * browsers send `Origin: null` on its own forms. No headers at all means a
 * non-browser client, which no third-party page can drive.
 */
export function isSameOriginPost(req: FastifyRequest, publicOrigin: string): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string") return site === "same-origin" || site === "none";
  const origin = req.headers.origin;
  if (origin === undefined || origin === "null") return true;
  return origin === publicOrigin || origin === `${req.protocol}://${req.host}`;
}

/**
 * The unlock cookie as OxiCloud set it, but scoped to this share's pages,
 * host-only, HttpOnly, and Secure when the visitor is on HTTPS.
 */
export function scopeUnlockCookie(setCookie: string, token: string, secure: boolean): string {
  const [pair = "", ...attrs] = setCookie.split(";").map((a) => a.trim());
  const kept = attrs.filter((a) => a && !/^(path|domain|secure|httponly)\s*(=|$)/i.test(a));
  const sameSite = kept.findIndex((a) => /^samesite\s*=/i.test(a));
  if (sameSite < 0) kept.push("SameSite=Lax");
  else if (/=\s*none$/i.test(kept[sameSite]!)) kept[sameSite] = "SameSite=Lax";
  return [
    pair,
    ...kept,
    `Path=/share/${encodeURIComponent(token)}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
