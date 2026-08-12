import { describe, it, expect } from "vitest";
import { decideBinaryAction } from "../src/artifacts/file-manager/clone";
import { parseMaxBytes } from "../src/shared/binary";

const small = { id: "a", key: "a.png", name: "a.png", size: 1000, type: "image/png", src: "http://x/a.png", tags: [] } as never;
const big = { id: "b", key: "b.png", name: "b.png", size: 50_000_000, type: "image/png", src: "http://x/b.png", tags: [] } as never;

describe("decideBinaryAction", () => {
  it("streams by default (no cache)", () => {
    expect(decideBinaryAction(small, "stream", 0, false)).toBe("stream");
  });
  it("manifest mode transfers nothing", () => {
    expect(decideBinaryAction(small, "manifest", 0, true)).toBe("manifest-skip");
  });
  it("local mode uploads when the file is cached", () => {
    expect(decideBinaryAction(small, "local", 0, true)).toBe("upload-local");
  });
  it("local gap streams when fallback is 'stream' (auto-selected cache)", () => {
    expect(decideBinaryAction(small, "local", 0, false, "stream")).toBe("stream");
  });
  it("local gap skips when fallback is 'skip' (explicit --upload-binaries offline)", () => {
    expect(decideBinaryAction(small, "local", 0, false, "skip")).toBe("skip-gap");
  });
  it("size gate wins over every mode", () => {
    expect(decideBinaryAction(big, "stream", parseMaxBytes(10), false)).toBe("skip-large");
    expect(decideBinaryAction(big, "local", parseMaxBytes(10), true)).toBe("skip-large");
    expect(decideBinaryAction(big, "manifest", parseMaxBytes(10), false)).toBe("manifest-skip");
  });
});
