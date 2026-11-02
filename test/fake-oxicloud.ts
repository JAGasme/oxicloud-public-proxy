import http from "node:http";
import type { AddressInfo } from "node:net";

// Just enough of OxiCloud >= 0.9.1 for the proxy: /api/s/{token} mints the
// `oxi_shares` ring cookie, and the folder/file routes accept only that ring.

export const TOKEN = "tok-123";
export const ROOT_FOLDER = "root-folder";
export const RING = "oxi_shares=ring-abc";

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
  close(): Promise<void>;
}

export async function startFakeOxiCloud(files: FakeResource[]): Promise<FakeOxiCloud> {
  const log: FakeOxiCloud["log"] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const ring = (req.headers.cookie ?? "").split("; ").includes(RING);
    log.push({ path: url.pathname, ring });

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
      res.writeHead(200, { "Content-Type": file.mime_type, "Content-Length": "4" });
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
