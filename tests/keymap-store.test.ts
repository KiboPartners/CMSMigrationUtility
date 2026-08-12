// tests/keymap-store.test.ts
import { describe, it, expect } from "vitest";
import { upsertRecords, selectUrlMap, recordKey, KeyRemapRecord } from "../src/shared/keymap";

const rec = (o: Partial<KeyRemapRecord>): KeyRemapRecord => ({
  sourceTenant: "S", targetTenant: "T", fileId: "f1",
  sourceUrl: "https://s/f1.png", targetUrl: "https://t/new/f1.png", updatedAt: null, ...o,
});

describe("keymap store (pure)", () => {
  it("recordKey composes tenant pair + fileId", () => {
    expect(recordKey({ sourceTenant: "S", targetTenant: "T", fileId: "f1" })).toBe("S::T::f1");
  });

  it("upsert replaces same-key record, appends new", () => {
    const existing = [rec({ fileId: "f1", targetUrl: "https://t/old/f1.png" })];
    const incoming = [
      rec({ fileId: "f1", targetUrl: "https://t/new/f1.png" }), // update
      rec({ fileId: "f2", sourceUrl: "https://s/f2.png", targetUrl: "https://t/x/f2.png" }), // new
    ];
    const out = upsertRecords(existing, incoming);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.fileId === "f1")!.targetUrl).toBe("https://t/new/f1.png");
    expect(out.find((r) => r.fileId === "f2")).toBeTruthy();
  });

  it("selectUrlMap returns only the matching tenant pair", () => {
    const records = [
      rec({ sourceTenant: "S", targetTenant: "T", sourceUrl: "https://s/a.png", targetUrl: "https://t/a.png" }),
      rec({ sourceTenant: "S", targetTenant: "OTHER", sourceUrl: "https://s/b.png", targetUrl: "https://other/b.png" }),
    ];
    expect(selectUrlMap(records, "S", "T")).toEqual({ "https://s/a.png": "https://t/a.png" });
  });
});
