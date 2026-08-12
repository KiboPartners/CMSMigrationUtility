import { describe, it, expect } from "vitest";
import { buildKeyMap, remapRecordsFor } from "../src/artifacts/file-manager/clone";
import { selectFileRemaps, KeyRemapRecord } from "../src/shared/keymap";

describe("buildKeyMap", () => {
  it("maps only files whose key changed", () => {
    const map = buildKeyMap([
      { sourceUrl: "https://src.cdn/a/cat.png", sourceKey: "a/cat.png", targetUrl: "https://tgt.cdn/a/cat.png", targetKey: "a/cat.png" }, // unchanged → excluded
      { sourceUrl: "https://src.cdn/b/dog.png", sourceKey: "b/dog.png", targetUrl: "https://tgt.cdn/9f2/dog.png", targetKey: "9f2/dog.png" }, // changed → included
    ]);
    expect(map).toEqual({ "https://src.cdn/b/dog.png": "https://tgt.cdn/9f2/dog.png" });
  });

  it("skips rows with a missing url", () => {
    const map = buildKeyMap([
      { sourceUrl: "", sourceKey: "x", targetUrl: "https://t/y", targetKey: "y" },
      { sourceUrl: "https://s/x", sourceKey: "x", targetUrl: "", targetKey: "y" },
    ]);
    expect(map).toEqual({});
  });
});

describe("remapRecordsFor", () => {
  it("emits tenant-tagged records only for changed keys", () => {
    const recs = remapRecordsFor(
      [
        { fileId: "f1", sourceUrl: "https://s/a.png", sourceKey: "a.png", targetUrl: "https://t/a.png", targetKey: "a.png" }, // unchanged → out
        { fileId: "f2", sourceUrl: "https://s/b.png", sourceKey: "b.png", targetUrl: "https://t/9f2/b.png", targetKey: "9f2/b.png" }, // changed → in
      ],
      "S",
      "T"
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      sourceTenant: "S", targetTenant: "T", fileId: "f2",
      sourceUrl: "https://s/b.png", targetUrl: "https://t/9f2/b.png",
      targetKey: "9f2/b.png", // persisted for the idempotency cache
    });
  });
});

describe("selectFileRemaps — idempotency cache", () => {
  const recs: KeyRemapRecord[] = [
    { sourceTenant: "S", targetTenant: "T", fileId: "f1", sourceUrl: "https://s/1.png", targetUrl: "https://t/m1/1.png", targetKey: "m1/1.png", updatedAt: null },
    { sourceTenant: "S", targetTenant: "OTHER", fileId: "f2", sourceUrl: "https://s/2.png", targetUrl: "https://o/2.png", targetKey: "m2/2.png", updatedAt: null },
    { sourceTenant: "S", targetTenant: "T", fileId: "f3", sourceUrl: "https://s/3.png", targetUrl: "https://t/3.png", updatedAt: null }, // no targetKey (legacy) → excluded
  ];

  it("returns fileId→{targetUrl,targetKey} for the matching tenant pair only", () => {
    const map = selectFileRemaps(recs, "S", "T");
    expect(map.get("f1")).toEqual({ targetUrl: "https://t/m1/1.png", targetKey: "m1/1.png" });
    expect(map.has("f2")).toBe(false); // different targetTenant
    expect(map.has("f3")).toBe(false); // legacy record without targetKey
  });
});
