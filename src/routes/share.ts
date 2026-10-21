import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UpstreamClient } from "../upstream.js";
import { type Lang, type T, makeT, resolveLang } from "../i18n.js";

const TOKEN_RE = /^[A-Za-z0-9-]{1,64}$/;

interface ShareParams {
  token: string;
}

interface AuthBody {
  password?: string;
}

export interface ShareRoutesDeps {
  upstream: UpstreamClient;
}

export async function shareRoutes(
  app: FastifyInstance,
  deps: ShareRoutesDeps,
): Promise<void> {
  const { upstream } = deps;

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
      forwardHeader(upstreamRes, reply, "content-type");
      forwardHeader(upstreamRes, reply, "content-length");
      forwardHeader(upstreamRes, reply, "content-disposition");
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
    forwardHeader(upstreamRes, reply, "content-type");
    forwardHeader(upstreamRes, reply, "content-length");
    forwardHeader(upstreamRes, reply, "content-disposition");

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

      const password = req.body?.password ?? "";
      if (password === "") {
        return reply.view("share.ejs", {
          state: "password",
          token,
          error: t("password.error.required"),
          lang,
          t,
        });
      }

      const result = await upstream.verifyPassword(token, password);

      switch (result.kind) {
        case "ok":
          // An array, not one header: fetch joins multiple Set-Cookie values
          // with ", ", which breaks cookies whose attributes contain commas.
          if (result.setCookies.length > 0) {
            reply.header("Set-Cookie", result.setCookies);
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
    forwardHeader(upstreamRes, reply, "content-type");
    forwardHeader(upstreamRes, reply, "content-length");
    forwardHeader(upstreamRes, reply, "content-disposition");
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

function renderError(reply: FastifyReply, upstreamStatus: number, lang: Lang, t: T) {
  const code = upstreamStatus >= 500 && upstreamStatus < 600 ? 502 : 500;
  return reply
    .code(code)
    .view("share.ejs", { state: "error", upstreamStatus, lang, t });
}
