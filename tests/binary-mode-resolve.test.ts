import { describe, it, expect } from "vitest";
import { resolveImportBinaryMode } from "../src/artifacts/file-manager/clone";

describe("resolveImportBinaryMode", () => {
  it("defaults to stream when no flags and no cache", () => {
    expect(resolveImportBinaryMode({}, false)).toEqual({ binaryMode: "stream", gapFallback: "skip" });
  });
  it("auto-prefers local cache when present, streaming the gaps", () => {
    expect(resolveImportBinaryMode({}, true)).toEqual({ binaryMode: "local", gapFallback: "stream" });
  });
  it("--stream-binaries forces stream even when a cache is present", () => {
    expect(resolveImportBinaryMode({ streamBinaries: true }, true)).toEqual({ binaryMode: "stream", gapFallback: "skip" });
  });
  it("--upload-binaries forces local with skip-on-gap (offline intent)", () => {
    expect(resolveImportBinaryMode({ uploadBinaries: true }, false)).toEqual({ binaryMode: "local", gapFallback: "skip" });
  });
  it("--manifest-only selects manifest mode", () => {
    expect(resolveImportBinaryMode({ manifestOnly: true }, true)).toEqual({ binaryMode: "manifest", gapFallback: "skip" });
  });
  it("throws when manifest-only is combined with a transfer flag", () => {
    expect(() => resolveImportBinaryMode({ manifestOnly: true, uploadBinaries: true }, false)).toThrow(/manifest-only/);
    expect(() => resolveImportBinaryMode({ manifestOnly: true, streamBinaries: true }, false)).toThrow(/manifest-only/);
  });
});
