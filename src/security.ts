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

// CSP for shared files streamed from OxiCloud. Their Content-Type is the
// uploader's, so an HTML or SVG file opened inline would otherwise run its
// scripts on the proxy's origin. Only scripting and framing are locked down:
// a stricter default-src would break the browser's built-in PDF, image and
// video viewers.
export const FILE_CSP = [
  "script-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface SecurityHeaderOptions {
  /** Strict-Transport-Security max-age in seconds; 0 disables the header. */
  hstsMaxAge: number;
}

/** Mark a reply as a pass-through of an uploaded file (see FILE_CSP). */
export function markAsSharedFile(reply: FastifyReply): void {
  reply.header("content-security-policy", FILE_CSP);
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
    reply.header("referrer-policy", "no-referrer");
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
