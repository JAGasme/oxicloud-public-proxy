import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { UpstreamClient } from "../src/upstream.js";
import { type FakeOxiCloud, type FakeResource, TOKEN, startFakeOxiCloud } from "./fake-oxicloud.js";

// Regression tests for the gallery card markup in views/folder.ejs: media
// cards carry data-mediakind/data-src for the lightbox, built only through
// escaped EJS output, whatever OxiCloud returns as file id, name or mime type.

const NORMAL: FakeResource[] = [
  { id: "img-1", name: "beach.jpg", mime_type: "image/jpeg" },
  { id: "vid-1", name: "waves.mp4", mime_type: "video/mp4" },
  { id: "doc-1", name: "notes.pdf", mime_type: "application/pdf" },
];

const ADVERSARIAL: FakeResource[] = [
  { id: 'x"><script>alert(1)</script>', name: "quote-id.png", mime_type: "image/png" },
  { id: "y' onerror='alert(2)", name: "apos-id.png", mime_type: "image/png" },
  { id: "z-1", name: '"><img src=x onerror=alert(3)>.jpg', mime_type: "image/jpeg" },
  { id: "z-2", name: "mime.mp4", mime_type: 'video/mp4" autoplay onloadstart="alert(4)' },
  { id: "z-3", name: "kind.bin", mime_type: '" data-mediakind="image' },
];

const CARD_ATTRS = new Set(["class", "href", "data-id", "data-name", "data-mime"]);
const MEDIA_ATTRS = new Set([...CARD_ATTRS, "data-mediakind", "data-src"]);

interface Card {
  attrs: Map<string, string>;
  /** Whatever was left of the opening tag after removing quoted attributes. */
  leftover: string;
}

function decode(s: string): string {
  return s
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseCards(html: string): Card[] {
  return [...html.matchAll(/<a class="card-link"([^>]*)>/g)].map((m) => {
    const raw = ` class="card-link"${m[1] ?? ""}`;
    const attrs = new Map<string, string>();
    const leftover = raw.replace(/\s+([^\s="]+)="([^"]*)"/g, (_all, name: string, value: string) => {
      assert.ok(!attrs.has(name), `duplicate attribute ${name}`);
      attrs.set(name, decode(value));
      return "";
    });
    return { attrs, leftover };
  });
}

function fileUrl(id: string): string {
  return `/share/${TOKEN}/file/${encodeURIComponent(id)}`;
}

async function setup(files: FakeResource[]) {
  const fake = await startFakeOxiCloud(files);
  const app = await buildApp({
    upstream: new UpstreamClient(fake.url),
    publicBaseUrl: "https://share.example",
  });
  return { fake, app };
}

describe("folder gallery, normal media", () => {
  let fake: FakeOxiCloud;
  let app: FastifyInstance;
  let html: string;
  let cards: Card[];

  before(async () => {
    ({ fake, app } = await setup(NORMAL));
    const res = await app.inject({ method: "GET", url: `/share/${TOKEN}` });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/html/);
    html = res.body;
    cards = parseCards(html);
  });
  after(async () => {
    await app.close();
    await fake.close();
  });

  it("lists the folder through the share ring", () => {
    assert.ok(fake.log.some((r) => r.path === `/api/s/${TOKEN}`));
    const listing = fake.log.filter((r) => r.path.endsWith("/resources"));
    assert.ok(listing.length > 0);
    assert.ok(listing.every((r) => r.ring), "resources call must carry the ring");
    assert.equal(cards.length, 3);
  });

  it("marks an image card for the lightbox", () => {
    const card = cards[0]!;
    assert.equal(card.leftover.trim(), "");
    assert.deepEqual(new Set(card.attrs.keys()), MEDIA_ATTRS);
    assert.equal(card.attrs.get("data-mediakind"), "image");
    assert.equal(card.attrs.get("data-src"), "/share/tok-123/file/img-1");
    assert.equal(card.attrs.get("href"), "/share/tok-123/file/img-1");
    assert.equal(card.attrs.get("data-name"), "beach.jpg");
    assert.ok(html.includes('<img src="/share/tok-123/file/img-1" alt="" decoding="async" />'));
  });

  it("marks a video card for the lightbox", () => {
    const card = cards[1]!;
    assert.equal(card.leftover.trim(), "");
    assert.equal(card.attrs.get("data-mediakind"), "video");
    assert.equal(card.attrs.get("data-src"), "/share/tok-123/file/vid-1");
    assert.ok(html.includes('<video data-lazy-src="/share/tok-123/file/vid-1"'));
  });

  it("leaves non-media cards out of the lightbox", () => {
    const card = cards[2]!;
    assert.equal(card.leftover.trim(), "");
    assert.deepEqual(new Set(card.attrs.keys()), CARD_ATTRS);
    assert.ok(html.includes('src="/public/icons/pdf.png"'));
  });

  it("serves gallery files through the ring, inline", async () => {
    const res = await app.inject({ method: "GET", url: cards[0]!.attrs.get("data-src")! });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/jpeg");
    assert.equal(res.body, "DATA");
    const fileCalls = fake.log.filter((r) => r.path.startsWith("/api/files/"));
    assert.ok(fileCalls.length > 0 && fileCalls.every((r) => r.ring));
  });
});

describe("folder gallery, adversarial upstream values", () => {
  let fake: FakeOxiCloud;
  let app: FastifyInstance;
  let html: string;
  let cards: Card[];

  before(async () => {
    ({ fake, app } = await setup(ADVERSARIAL));
    const res = await app.inject({ method: "GET", url: `/share/${TOKEN}` });
    assert.equal(res.statusCode, 200);
    html = res.body;
    cards = parseCards(html);
  });
  after(async () => {
    await app.close();
    await fake.close();
  });

  it("renders one well-formed card per file", () => {
    assert.equal(cards.length, ADVERSARIAL.length);
    for (const card of cards) {
      assert.equal(card.leftover.trim(), "", `stray markup in card tag: ${card.leftover}`);
      for (const name of card.attrs.keys()) {
        assert.ok(MEDIA_ATTRS.has(name), `unexpected attribute ${name}`);
      }
    }
  });

  it("round-trips every value through escaped attributes", () => {
    ADVERSARIAL.forEach((f, i) => {
      const card = cards[i]!;
      assert.equal(card.attrs.get("data-id"), f.id);
      assert.equal(card.attrs.get("data-name"), f.name);
      assert.equal(card.attrs.get("data-mime"), f.mime_type);
      assert.equal(card.attrs.get("href"), fileUrl(f.id));
      if (card.attrs.has("data-src")) {
        assert.equal(card.attrs.get("data-src"), fileUrl(f.id));
      }
    });
  });

  it("only ever emits a known media kind", () => {
    const kinds = cards.map((c) => c.attrs.get("data-mediakind"));
    assert.deepEqual(kinds, ["image", "image", "image", "video", undefined]);
  });

  it("injects no elements or handlers", () => {
    assert.ok(!html.includes("<script>alert"));
    // Every thumbnail tag keeps exactly its template attributes: the payloads
    // above only ever appear inside quoted, escaped attribute values.
    const thumbs = [...html.matchAll(/<(img|video)\b([^>]*)>/g)];
    assert.equal(thumbs.length, ADVERSARIAL.length);
    for (const [tag, , rest] of thumbs) {
      const leftover = (rest ?? "").replace(/\s+[^\s="]+="[^"]*"/g, "");
      const flags = leftover.replace(/\/$/, "").trim().split(/\s+/).filter(Boolean);
      for (const flag of flags) {
        assert.ok(
          ["preload", "muted", "playsinline", "disablepictureinpicture"].includes(flag),
          `unexpected bare attribute ${flag} in ${tag}`,
        );
      }
      const names = [...(rest ?? "").matchAll(/\s+([^\s="]+)="/g)].map((m) => m[1]);
      for (const name of names) {
        assert.ok(!/^on/i.test(name ?? ""), `event handler ${name} in ${tag}`);
      }
    }
  });
});

describe("share landing", () => {
  it("renders the expired page for an unknown share", async () => {
    const { fake, app } = await setup(NORMAL);
    try {
      const res = await app.inject({ method: "GET", url: "/share/unknown" });
      assert.equal(res.statusCode, 410);
      assert.match(res.body, /<html/);
    } finally {
      await app.close();
      await fake.close();
    }
  });
});
