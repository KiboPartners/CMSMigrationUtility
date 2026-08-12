import { describe, it, expect } from "vitest";
import path from "path";
import { safeKeyPath } from "../src/shared/binary";

describe("safeKeyPath", () => {
  it("resolves a normal key under the base dir", () => {
    const p = safeKeyPath("/exp/binaries", "images/cat.png");
    expect(p).toBe(path.resolve("/exp/binaries", "images/cat.png"));
  });
  it("rejects parent-dir traversal", () => {
    expect(safeKeyPath("/exp/binaries", "../../etc/passwd")).toBeNull();
  });
  it("rejects an absolute key that escapes", () => {
    // an absolute key resolves away from base → rejected
    const p = safeKeyPath("/exp/binaries", "/etc/passwd");
    expect(p).toBeNull();
  });
  it("does not escape the base dir when key is empty string", () => {
    // An empty key resolves to the base dir itself (not a child path).
    // The helper returns the base dir path (not null) because dest === root is not an escape.
    // Callers treating this as a file write would write AT the directory itself (not outside it).
    const result = safeKeyPath("/exp/binaries", "");
    // Must not be a path outside the base dir
    const root = path.resolve("/exp/binaries");
    if (result !== null) {
      expect(result === root || result.startsWith(root + path.sep)).toBe(true);
    }
  });
});
