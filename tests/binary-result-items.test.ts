import { describe, it, expect } from "vitest";
import { binaryResultItems } from "../src/artifacts/file-manager/clone";

const files = [
  { id: "u", key: "u.png", name: "u.png", size: 1, type: "image/png", src: "http://x/u.png", tags: [] },
  { id: "m", key: "m.png", name: "m.png", size: 1, type: "image/png", src: "http://x/m.png", tags: [] },
  { id: "g", key: "g.png", name: "g.png", size: 1, type: "image/png", src: "http://x/g.png", tags: [] },
] as never[];

describe("binaryResultItems classification", () => {
  const items = binaryResultItems(
    files,
    new Map(),            // errorsByKey
    new Set(),            // skippedLargeKeys
    new Set(["u.png"]),   // uploadedKeys
    new Set(),            // skippedKeys
    new Set(),            // folderUpdatedKeys
    new Set(),            // missingSourceKeys
    new Set(["m.png"]),   // manifestedKeys
    new Set(["g.png"])    // skippedGapKeys
  );
  const by = (id: string) => items.find((i) => i.id === "http://x/" + id + ".png")!;
  it("uploaded → done/uploaded", () => { expect(by("u")).toMatchObject({ status: "done", action: "uploaded" }); });
  it("manifested → skipped/manifested", () => { expect(by("m")).toMatchObject({ status: "skipped", action: "manifested" }); });
  it("cache-gap → error (never silently done)", () => { expect(by("g").status).toBe("error"); });
});
