import type { FastifyInstance, FastifyReply } from "fastify";

// CSP for the proxy's own pages. All CSS and JS are static files under
// /public, so neither 'unsafe-inline' nor 'unsafe-eval' is needed. The only
// third party is Google Fonts (stylesheet + font files). img-src allows data:
// for the inline SVG play marker in folder.css.
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

// CSP for shared files the browser may render inline (see inlineSafe):
// raster images, audio, video and PDF. None of them can carry markup or script
// into the proxy's origin, so only scripting and framing are locked down: a
// default-src (and with it object-src) or a sandbox would break Chrome's
// built-in PDF viewer.
export const FILE_CSP = [
  "script-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// CSP for every other shared file. These are always sent as attachments, so
// the browser should never render them; if one is rendered anyway it gets an
// opaque origin and may load nothing (no links out, no meta refresh target,
// no CSS or remote images).
export const ATTACHMENT_CSP = [
  "default-src 'none'",
  "sandbox",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Whether an uploaded file of this Content-Type may be shown inline on the
 * proxy's origin. The type is the uploader's, so anything that can carry
 * markup (HTML, SVG, XML, text...) or is unknown is downloaded instead.
 */
export function inlineSafe(contentType: string | null): boolean {
  const essence = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const m = /^(image|video|audio)\/([a-z0-9.+-]+)$/.exec(essence);
  if (m) return !/svg|xml|html/.test(m[2]!);
  return essence === "application/pdf";
}

/** `attachment`, keeping whatever filename parameters OxiCloud sent. */
export function asAttachment(contentDisposition: string | null): string {
  if (!contentDisposition) return "attachment";
  const m = /^\s*(?:inline|attachment)\s*(;.*)?$/is.exec(contentDisposition);
  return m ? `attachment${m[1] ?? ""}` : "attachment";
}

// Referrer policy for pages with the password form. Under `no-referrer` a
// browser sends `Origin: null` on its own same-origin POST (Fetch spec), which
// is indistinguishable from a sandboxed cross-site form. `strict-origin` makes
// it send the real origin, while any Referer, to this site or another, is
// still only the bare origin: the share token in the path never leaves. A
// browser that does not know `strict-origin` uses the last value it does
// know, `no-referrer`, and so never falls back to sending the full URL.
export const FORM_REFERRER_POLICY = "no-referrer, strict-origin";

/** Mark a reply as a page holding the password form (see FORM_REFERRER_POLICY). */
export function markAsPasswordForm(reply: FastifyReply): void {
  reply.header("referrer-policy", FORM_REFERRER_POLICY);
}

export interface SecurityHeaderOptions {
  /** Strict-Transport-Security max-age in seconds; 0 disables the header. */
  hstsMaxAge: number;
}

/**
 * Headers for a pass-through of an uploaded file: its type (octet-stream if
 * OxiCloud sent none), a CSP, and, for anything not inlineSafe, a forced
 * `Content-Disposition: attachment`.
 */
export function markAsSharedFile(
  reply: FastifyReply,
  contentType: string | null,
  contentDisposition: string | null,
): void {
  reply.header("content-type", contentType ?? "application/octet-stream");
  if (inlineSafe(contentType)) {
    reply.header("content-security-policy", FILE_CSP);
    if (contentDisposition !== null) reply.header("content-disposition", contentDisposition);
  } else {
    reply.header("content-security-policy", ATTACHMENT_CSP);
    reply.header("content-disposition", asAttachment(contentDisposition));
  }
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  opts: SecurityHeaderOptions,
): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (!reply.hasHeader("content-security-policy")) {
      reply.header("content-security-policy", PAGE_CSP);
    }
    reply.header("x-content-type-options", "nosniff");
    // Share URLs carry the share token: never leak it to other sites.
    if (!reply.hasHeader("referrer-policy")) reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("cross-origin-opener-policy", "same-origin");
    // HSTS only means something over HTTPS. Behind a TLS-terminating proxy
    // req.protocol comes from X-Forwarded-Proto (trustProxy is on).
    if (opts.hstsMaxAge > 0 && req.protocol === "https") {
      reply.header("strict-transport-security", `max-age=${opts.hstsMaxAge}`);
    }
    return payload;
  });
}
