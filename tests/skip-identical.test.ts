import { describe, it, expect } from "vitest";
import {
  normalizeEntryValues,
  fingerprintSourceEntry,
} from "../packages/cms-entries/src/clone";
import {
  normalizePageContent,
  fingerprintSourcePage,
} from "../packages/page-builder/src/pages";
import type { FieldDefinition } from "../packages/cms-entries/src/introspect";

const SRC_CDN = "https://cdn.source.example.com";
const TGT_CDN = "https://cdn.target.example.com";

// ─── cms-entries fingerprint ──────────────────────────────────────────────────

describe("normalizeEntryValues (cms-entries content fingerprint)", () => {
  it("is order-independent — same content, different key order → equal", () => {
    const a = normalizeEntryValues({ title: "Hi", slug: "hi", body: "x" });
    const b = normalizeEntryValues({ body: "x", slug: "hi", title: "Hi" });
    expect(a).toBe(b);
  });

  it("ignores system / metadata fields (savedOn, version, meta, wbyAco_location)", () => {
    const base = { title: "Hi", slug: "hi" };
    const withMeta = {
      ...base,
      savedOn: "2024-01-01T00:00:00Z",
      version: 7,
      meta: { status: "published", title: "Hi" },
      wbyAco_location: { folderId: "abc-123" },
      createdBy: { id: "u1" },
    };
    expect(normalizeEntryValues(withMeta)).toBe(normalizeEntryValues(base));
  });

  it("detects a real content change", () => {
    const a = normalizeEntryValues({ title: "Hi", slug: "hi" });
    const b = normalizeEntryValues({ title: "Bye", slug: "hi" });
    expect(a).not.toBe(b);
  });
});

describe("fingerprintSourceEntry (CDN-aware)", () => {
  const fields: FieldDefinition[] = [
    { fieldId: "title", type: "text", multipleValues: false },
    { fieldId: "image", type: "file", multipleValues: false },
  ];

  it("identical-after-normalization → equal (source rewritten, target already target-domain)", () => {
    const source = { title: "Hero", image: `${SRC_CDN}/a.png` };
    const target = { title: "Hero", image: `${TGT_CDN}/a.png` };
    const srcFp = fingerprintSourceEntry(source, fields, SRC_CDN, TGT_CDN);
    const tgtFp = normalizeEntryValues(target);
    expect(srcFp).toBe(tgtFp);
  });

  it("a CDN-only difference does NOT count as changed", () => {
    const source = { title: "Hero", image: `${SRC_CDN}/a.png` };
    const sourceNoRewrite = normalizeEntryValues(source);
    const sourceRewritten = fingerprintSourceEntry(source, fields, SRC_CDN, TGT_CDN);
    // Without rewrite the domain leaks in; with rewrite it matches the target.
    expect(sourceRewritten).not.toBe(sourceNoRewrite);
    expect(sourceRewritten).toBe(normalizeEntryValues({ title: "Hero", image: `${TGT_CDN}/a.png` }));
  });

  it("a real content change still registers as different", () => {
    const a = fingerprintSourceEntry({ title: "Hero", image: `${SRC_CDN}/a.png` }, fields, SRC_CDN, TGT_CDN);
    const b = fingerprintSourceEntry({ title: "Banner", image: `${SRC_CDN}/a.png` }, fields, SRC_CDN, TGT_CDN);
    expect(a).not.toBe(b);
  });

  it("differing system fields on the source side are ignored", () => {
    const lean = { title: "Hero", image: `${SRC_CDN}/a.png` };
    const noisy = { ...lean, savedOn: "2025-01-01", version: 3, entryId: "e#1", id: "e#0003" };
    expect(fingerprintSourceEntry(noisy, fields, SRC_CDN, TGT_CDN)).toBe(
      fingerprintSourceEntry(lean, fields, SRC_CDN, TGT_CDN)
    );
  });
});

// ─── page-builder fingerprint ─────────────────────────────────────────────────

describe("normalizePageContent (page content fingerprint)", () => {
  it("identical content (different key order) → equal", () => {
    const a = normalizePageContent({ title: "Home", path: "/", content: { a: 1, b: 2 } });
    const b = normalizePageContent({ content: { b: 2, a: 1 }, path: "/", title: "Home" });
    expect(a).toBe(b);
  });

  it("ignores system fields (savedOn, version, location, wbyAco_location, status)", () => {
    const base = { title: "Home", path: "/", content: { hero: true } };
    const withSystem = {
      ...base,
      savedOn: "2024-06-01T00:00:00Z",
      modifiedOn: "2024-06-02T00:00:00Z",
      version: 12,
      status: "published",
      locked: true,
      location: { folderId: "f-9" },
      wbyAco_location: { folderId: "f-9" },
      id: "page#0001",
      pid: "page",
    };
    expect(normalizePageContent(withSystem)).toBe(normalizePageContent(base));
  });

  it("detects a real content change", () => {
    const a = normalizePageContent({ title: "Home", content: { hero: "v1" } });
    const b = normalizePageContent({ title: "Home", content: { hero: "v2" } });
    expect(a).not.toBe(b);
  });

  it("detects a title change", () => {
    const a = normalizePageContent({ title: "Home", path: "/" });
    const b = normalizePageContent({ title: "Landing", path: "/" });
    expect(a).not.toBe(b);
  });
});

describe("fingerprintSourcePage (CDN-aware)", () => {
  it("a CDN-only difference in content → equal to the target-domain page", () => {
    const source = { title: "Home", content: { img: `${SRC_CDN}/h.jpg` } };
    const targetPage = { title: "Home", content: { img: `${TGT_CDN}/h.jpg` } };
    const srcFp = fingerprintSourcePage(source, SRC_CDN, TGT_CDN);
    expect(srcFp).toBe(normalizePageContent(targetPage));
  });

  it("a CDN-only difference in settings → equal", () => {
    const source = { title: "Home", settings: { favicon: `${SRC_CDN}/f.ico` } };
    const targetPage = { title: "Home", settings: { favicon: `${TGT_CDN}/f.ico` } };
    expect(fingerprintSourcePage(source, SRC_CDN, TGT_CDN)).toBe(normalizePageContent(targetPage));
  });

  it("differing system fields → equal", () => {
    const lean = { title: "Home", content: { hero: true } };
    const noisy = {
      ...lean,
      savedOn: "2025-02-02",
      version: 4,
      status: "draft",
      location: { folderId: "x" },
    };
    expect(fingerprintSourcePage(noisy, SRC_CDN, TGT_CDN)).toBe(
      fingerprintSourcePage(lean, SRC_CDN, TGT_CDN)
    );
  });

  it("a real content change still registers as different", () => {
    const a = fingerprintSourcePage({ title: "Home", content: { hero: `${SRC_CDN}/a.jpg` } }, SRC_CDN, TGT_CDN);
    const b = fingerprintSourcePage({ title: "Home", content: { hero: `${SRC_CDN}/b.jpg` } }, SRC_CDN, TGT_CDN);
    expect(a).not.toBe(b);
  });
});
