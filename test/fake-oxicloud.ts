import http from "node:http";
import type { AddressInfo } from "node:net";

// Just enough of OxiCloud >= 0.9.1 for the proxy: /api/s/{token} mints the
// `oxi_shares` ring cookie, and the folder/file routes accept only that ring.

export const TOKEN = "tok-123";
export const ROOT_FOLDER = "root-folder";
export const RING = "oxi_shares=ring-abc";
/** A password-protected folder share; its password is PASSWORD. */
export const PW_TOKEN = "tok-pw";
export const PASSWORD = "correct horse";
export const UNLOCK = `oxi_share_unlock_${PW_TOKEN}=unlock-jwt`;
/** A single-file share, serving FakeOptions.fileShare. */
export const FILE_TOKEN = "tok-file";
/** A share whose /verify always fails with a 500. */
export const BROKEN_TOKEN = "tok-500";

export interface FakeOptions {
  /**
   * Mirror of OxiCloud's share-verify limiter: per key, `max` requests until
   * the key has been idle for the window (moka TTL, reset on every request).
   * Keyed on X-Forwarded-For when `trustXff`, as with OXICLOUD_TRUST_PROXY_CIDR.
   */
  verifyMax?: number;
  trustXff?: boolean;
  fileShare?: FakeResource;
}

export interface VerifyCall {
  token: string;
  xff: string | undefined;
  password: unknown;
}

export interface FakeResource {
  id: string;
  name: string;
  mime_type: string;
  size?: number;
}

export interface FakeOxiCloud {
  url: string;
  files: FakeResource[];
  /** Every request path the fake saw, with whether it carried the ring. */
  log: Array<{ path: string; ring: boolean }>;
  /** Every /verify call that reached the fake, rate-limited ones included. */
  verifies: VerifyCall[];
  close(): Promise<void>;
}

const META = {
  id: "share-1",
  item_id: ROOT_FOLDER,
  item_name: "Holiday",
  item_type: "folder",
  has_password: false,
  expires_at: null,
};

export async function startFakeOxiCloud(
  files: FakeResource[],
  opts: FakeOptions = {},
): Promise<FakeOxiCloud> {
  const log: FakeOxiCloud["log"] = [];
  const verifies: VerifyCall[] = [];
  const counters = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const cookies = (req.headers.cookie ?? "").split("; ");
    const ring = cookies.includes(RING);
    log.push({ path: url.pathname, ring });

    const verify = /^\/api\/s\/([^/]+)\/verify$/.exec(url.pathname);
    if (verify && req.method === "POST") {
      const token = decodeURIComponent(verify[1] ?? "");
      let body = "";
      for await (const chunk of req) body += chunk;
      const xff = req.headers["x-forwarded-for"] as string | undefined;
      const password = (JSON.parse(body) as { password: unknown }).password;
      verifies.push({ token, xff, password });
      if (opts.verifyMax !== undefined) {
        const key = (opts.trustXff && xff) || "peer";
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        if (count > opts.verifyMax) {
          res.setHeader("Retry-After", "60");
          return json(res, 429, { error: "Too many requests", retry_after_secs: 60 });
        }
      }
      if (token === BROKEN_TOKEN) return json(res, 500, { error: "boom" });
      if (token !== PW_TOKEN) return json(res, 404, { error: "not found" });
      if (password !== PASSWORD) return json(res, 401, { error: "wrong password" });
      res.setHeader("Set-Cookie", [
        `${UNLOCK}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
        `${RING}; Path=/; HttpOnly`,
      ]);
      return json(res, 200, { ...META, token, has_password: true });
    }

    if (url.pathname === `/api/s/${PW_TOKEN}`) {
      if (!cookies.includes(UNLOCK)) return json(res, 401, { error: "password required" });
      res.setHeader("Set-Cookie", `${RING}; Path=/; HttpOnly`);
      return json(res, 200, { ...META, token: PW_TOKEN, has_password: true });
    }
    if (url.pathname === `/api/s/${FILE_TOKEN}` && opts.fileShare) {
      res.setHeader("Set-Cookie", `${RING}; Path=/; HttpOnly`);
      return json(res, 200, {
        ...META,
        item_id: opts.fileShare.id,
        item_name: opts.fileShare.name,
        item_type: "file",
        token: FILE_TOKEN,
      });
    }

    if (url.pathname === `/api/s/${TOKEN}`) {
      res.setHeader("Set-Cookie", `${RING}; Path=/; HttpOnly`);
      return json(res, 200, {
        id: "share-1",
        item_id: ROOT_FOLDER,
        item_name: "Holiday",
        item_type: "folder",
        token: TOKEN,
        has_password: false,
        expires_at: null,
      });
    }
    if (url.pathname.startsWith("/api/s/")) {
      return json(res, 404, { error: "not found" });
    }

    if (!ring) return json(res, 401, { error: "no ring" });

    if (url.pathname === `/api/folders/${ROOT_FOLDER}/resources`) {
      return json(res, 200, {
        items: files.map((f) => ({
          resource_type: "file",
          resource: { size: 1234, ...f, modified_at: "2026-10-01T12:00:00Z" },
        })),
      });
    }

    const m = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
    const file = m ? files.find((f) => f.id === decodeURIComponent(m[1] ?? "")) : undefined;
    if (file && url.searchParams.get("inline") === "true") {
      res.writeHead(200, {
        ...(file.mime_type ? { "Content-Type": file.mime_type } : {}),
        "Content-Length": "4",
        "Content-Disposition": `inline; filename="${file.name}"`,
      });
      return res.end("DATA");
    }
    if (m && opts.fileShare && decodeURIComponent(m[1] ?? "") === opts.fileShare.id) {
      res.writeHead(200, {
        "Content-Type": opts.fileShare.mime_type,
        "Content-Length": "4",
        "Content-Disposition": `inline; filename="${opts.fileShare.name}"`,
      });
      return res.end("DATA");
    }
    return json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    files,
    log,
    verifies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
