// OxiCloud >= 0.9.1 removed the parallel public-share API this proxy was
// built on (/api/s/{token}/download, /contents, /file, /zip). What remains of
// /api/s/{token} is a LOGIN step: it resolves the token, enforces the password
// gate and issues an `oxi_shares` "ring" cookie. Everything after that goes
// through the normal /api/folders/* and /api/files/* routes, authorized by the
// share's own grant. OxiCloud confines a ring-only (anonymous) session to a
// small GET-only allowlist, so the ring can reach nothing beyond the share.
//
// The proxy never hands the ring to the browser. It opens the share itself,
// keeps the ring in a short-lived in-memory cache keyed by (token, unlock
// cookie), and attaches it to the upstream calls. The browser only ever holds
// the per-share unlock cookie, exactly as with the old API.

export interface ShareMetadata {
  id: string;
  item_id: string;
  item_name: string | null;
  item_type: "file" | "folder";
  token: string;
  has_password: boolean;
  // Unix seconds before 0.9, ISO-8601 since. Not rendered anywhere.
  expires_at: number | string | null;
}

export interface FolderEntry {
  id: string;
  name: string;
}

export interface FileEntry {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  modified_at?: number;
}

export interface FolderListing {
  folders: FolderEntry[];
  files: FileEntry[];
}

export type ListingResult =
  | { kind: "ok"; data: FolderListing }
  | { kind: "password-required" }
  | { kind: "expired" }
  | { kind: "not-found" }
  | { kind: "not-folder-share" }
  | { kind: "upstream-error"; status: number; detail?: string };

export type MetadataResult =
  | { kind: "ok"; data: ShareMetadata }
  | { kind: "password-required" }
  | { kind: "expired" }
  | { kind: "not-found" }
  | { kind: "upstream-error"; status: number; detail?: string };

export type VerifyResult =
  | { kind: "ok"; data: ShareMetadata; setCookies: string[] }
  | { kind: "wrong-password" }
  | { kind: "expired" }
  | { kind: "not-found" }
  | { kind: "upstream-error"; status: number; detail?: string };

interface OpenShare {
  meta: ShareMetadata;
  ring: string; // "oxi_shares=<jwt>", ready for a Cookie header
  expires: number; // ms epoch
}

type OpenResult =
  | { kind: "ok"; share: OpenShare }
  | Exclude<MetadataResult, { kind: "ok" }>;

const RING_COOKIE = "oxi_shares";
const UNLOCK_PREFIX = "oxi_share_unlock_";
// Well under OxiCloud's 8 h ring TTL. The share's own expiry and deletion are
// still checked by OxiCloud on every request made with the ring.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
// /resources is cursor-paginated (max 200 per page). Bound the walk so one
// enormous folder cannot pin the proxy.
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;

export class UpstreamClient {
  private readonly cache = new Map<string, OpenShare>();

  constructor(private readonly baseUrl: string) {}

  // ── Share login ──────────────────────────────────────────────────────────

  async getMetadata(token: string, cookieHeader?: string): Promise<MetadataResult> {
    // Always a fresh upstream call: this is the share landing page, and it is
    // what OxiCloud counts as one access.
    const opened = await this.openShare(token, cookieHeader, true);
    return opened.kind === "ok" ? { kind: "ok", data: opened.share.meta } : opened;
  }

  async verifyPassword(token: string, password: string): Promise<VerifyResult> {
    const url = `${this.baseUrl}/api/s/${encodeURIComponent(token)}/verify`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ password }),
      });
    } catch (err) {
      return upstreamError(err);
    }

    if (res.ok) {
      const data = await readJson<ShareMetadata>(res);
      if (data === null) return { kind: "upstream-error", status: 502, detail: "Malformed JSON" };
      // Relay only the unlock cookie. The ring stays server-side (see top).
      const setCookies = res.headers
        .getSetCookie()
        .filter((c) => c.startsWith(UNLOCK_PREFIX));
      return { kind: "ok", data, setCookies };
    }
    if (res.status === 401) return { kind: "wrong-password" };
    if (res.status === 410) return { kind: "expired" };
    if (res.status === 404) return { kind: "not-found" };
    return { kind: "upstream-error", status: res.status, detail: await readDetail(res) };
  }

  // ── Content ──────────────────────────────────────────────────────────────

  async download(
    token: string,
    cookieHeader?: string,
    rangeHeader?: string,
    ifNoneMatchHeader?: string,
  ): Promise<Response> {
    return this.withShare(token, cookieHeader, async (share) => {
      if (share.meta.item_type !== "file") return syntheticResponse(404);
      return this.get(
        `/api/files/${encodeURIComponent(share.meta.item_id)}?original=true`,
        share.ring,
        rangeHeader,
        ifNoneMatchHeader,
      );
    });
  }

  async downloadFileInFolder(
    token: string,
    fileId: string,
    cookieHeader?: string,
    rangeHeader?: string,
    ifNoneMatchHeader?: string,
  ): Promise<Response> {
    return this.withShare(token, cookieHeader, async (share) => {
      if (share.meta.item_type !== "folder") return syntheticResponse(404);
      // inline: the gallery renders these in <img>/<video>; the lightbox's
      // download link uses the `download` attribute to save instead.
      return this.get(
        `/api/files/${encodeURIComponent(fileId)}?original=true&inline=true`,
        share.ring,
        rangeHeader,
        ifNoneMatchHeader,
      );
    });
  }

  async downloadZip(
    token: string,
    folderId: string | null,
    cookieHeader?: string,
  ): Promise<Response> {
    return this.withShare(token, cookieHeader, async (share) => {
      if (share.meta.item_type !== "folder") return syntheticResponse(404);
      const id = folderId ?? share.meta.item_id;
      return this.get(`/api/folders/${encodeURIComponent(id)}/download`, share.ring);
    });
  }

  async listContents(
    token: string,
    folderId: string | null,
    cookieHeader?: string,
  ): Promise<ListingResult> {
    const opened = await this.openShare(token, cookieHeader, false);
    if (opened.kind !== "ok") return opened;
    if (opened.share.meta.item_type !== "folder") return { kind: "not-folder-share" };

    const id = folderId ?? opened.share.meta.item_id;
    let listing = await this.walkFolder(id, opened.share.ring);
    if (listing.kind === "stale") {
      // Ring rejected (share re-created, secret rotated...). Re-open once.
      this.cache.delete(cacheKey(token, cookieHeader));
      const again = await this.openShare(token, cookieHeader, false);
      if (again.kind !== "ok") return again;
      listing = await this.walkFolder(id, again.share.ring);
    }
    if (listing.kind === "stale") return { kind: "not-found" };
    return listing;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async walkFolder(
    folderId: string,
    ring: string,
  ): Promise<ListingResult | { kind: "stale" }> {
    const folders: FolderEntry[] = [];
    const files: FileEntry[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ limit: String(PAGE_LIMIT), order_by: "name" });
      if (cursor) qs.set("cursor", cursor);

      let res: Response;
      try {
        res = await this.get(
          `/api/folders/${encodeURIComponent(folderId)}/resources?${qs}`,
          ring,
        );
      } catch (err) {
        return upstreamError(err);
      }
      // 401/403: the ring itself was refused. 404: folder missing or outside
      // the share, which OxiCloud deliberately does not distinguish.
      if (res.status === 401 || res.status === 403) return { kind: "stale" };
      if (res.status === 404) return { kind: "not-found" };
      if (res.status === 410) return { kind: "expired" };
      if (!res.ok) return { kind: "upstream-error", status: res.status, detail: await readDetail(res) };

      const body = await readJson<ResourcePage>(res);
      if (body === null) return { kind: "upstream-error", status: 502, detail: "Malformed JSON" };

      for (const item of body.items ?? []) {
        const r = item.resource;
        if (item.resource_type === "folder") {
          folders.push({ id: r.id, name: r.name });
        } else if (item.resource_type === "file") {
          const modified = r.modified_at ? Date.parse(r.modified_at) : NaN;
          files.push({
            id: r.id,
            name: r.name,
            size: r.size ?? 0,
            mime_type: r.mime_type ?? "application/octet-stream",
            ...(Number.isNaN(modified) ? {} : { modified_at: Math.floor(modified / 1000) }),
          });
        }
      }
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
    }
    return { kind: "ok", data: { folders, files } };
  }

  /** Run `fn` with an open share, re-opening once if the cached ring is refused. */
  private async withShare(
    token: string,
    cookieHeader: string | undefined,
    fn: (share: OpenShare) => Promise<Response>,
  ): Promise<Response> {
    let opened = await this.openShare(token, cookieHeader, false);
    if (opened.kind !== "ok") return syntheticResponse(statusFor(opened));

    let res = await fn(opened.share);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      this.cache.delete(cacheKey(token, cookieHeader));
      opened = await this.openShare(token, cookieHeader, false);
      if (opened.kind !== "ok") return syntheticResponse(statusFor(opened));
      res = await fn(opened.share);
    }
    // A ring that still fails means the share no longer covers this item.
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      return syntheticResponse(404);
    }
    return res;
  }

  private async openShare(
    token: string,
    cookieHeader: string | undefined,
    fresh: boolean,
  ): Promise<OpenResult> {
    const key = cacheKey(token, cookieHeader);
    const now = Date.now();
    if (!fresh) {
      const hit = this.cache.get(key);
      if (hit && hit.expires > now) return { kind: "ok", share: hit };
    }

    const unlock = unlockCookies(cookieHeader);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (unlock) headers.Cookie = unlock;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/s/${encodeURIComponent(token)}`, { headers });
    } catch (err) {
      return upstreamError(err);
    }

    if (res.status === 401) return { kind: "password-required" };
    if (res.status === 410) return { kind: "expired" };
    if (res.status === 404) return { kind: "not-found" };
    if (!res.ok) return { kind: "upstream-error", status: res.status, detail: await readDetail(res) };

    const meta = await readJson<ShareMetadata>(res);
    if (meta === null) return { kind: "upstream-error", status: 502, detail: "Malformed JSON" };

    const ring = res.headers
      .getSetCookie()
      .map((c) => c.split(";", 1)[0] ?? "")
      .find((c) => c.startsWith(`${RING_COOKIE}=`));
    if (!ring) {
      // OxiCloud < 0.9.1, or it failed to mint one (it logs why).
      return {
        kind: "upstream-error",
        status: 502,
        detail: "OxiCloud issued no share ring; it must be >= 0.9.1",
      };
    }

    const share: OpenShare = { meta, ring, expires: now + CACHE_TTL_MS };
    this.cache.delete(key); // re-insert at the end: Map order is the LRU order
    this.cache.set(key, share);
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return { kind: "ok", share };
  }

  private get(
    path: string,
    cookie: string,
    rangeHeader?: string,
    ifNoneMatchHeader?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { Cookie: cookie };
    if (rangeHeader) headers.Range = rangeHeader;
    if (ifNoneMatchHeader) headers["If-None-Match"] = ifNoneMatchHeader;
    return fetch(`${this.baseUrl}${path}`, { headers });
  }
}

interface ResourcePage {
  items?: Array<{
    resource_type: string;
    resource: {
      id: string;
      name: string;
      size?: number;
      mime_type?: string;
      modified_at?: string;
    };
  }>;
  next_cursor?: string;
}

/** Only the share-unlock cookies are ever forwarded upstream. */
function unlockCookies(cookieHeader: string | undefined): string {
  if (!cookieHeader) return "";
  return cookieHeader
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.startsWith(UNLOCK_PREFIX))
    .join("; ");
}

function cacheKey(token: string, cookieHeader: string | undefined): string {
  return `${token}\n${unlockCookies(cookieHeader)}`;
}

function statusFor(r: Exclude<MetadataResult, { kind: "ok" }>): number {
  switch (r.kind) {
    case "password-required":
      return 401;
    case "expired":
      return 410;
    case "not-found":
      return 404;
    case "upstream-error":
      return r.status >= 400 ? r.status : 502;
  }
}

function syntheticResponse(status: number): Response {
  return new Response(null, { status });
}

function upstreamError(err: unknown): { kind: "upstream-error"; status: number; detail: string } {
  return {
    kind: "upstream-error",
    status: 502,
    detail: err instanceof Error ? err.message : String(err),
  };
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function readDetail(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return undefined;
  }
}
