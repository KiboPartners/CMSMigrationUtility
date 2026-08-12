import { describe, it, expect } from "vitest";
import {
  normalizeFileDepId,
  fileKeyFromDepId,
  fileDepAliases,
} from "../src/shared/file-deps";

describe("normalizeFileDepId", () => {
  it("strips query and hash", () => {
    expect(
      normalizeFileDepId("https://CDN.Example.com/files/abc/x.png?v=1#frag")
    ).toBe("https://cdn.example.com/files/abc/x.png");
  });

  it("case-normalizes host", () => {
    expect(normalizeFileDepId("https://CDN.Example.COM/files/a/b.jpg")).toBe(
      "https://cdn.example.com/files/a/b.jpg"
    );
  });

  it("collapses to /files/… stable path form", () => {
    expect(
      normalizeFileDepId("https://cdn.example.com/tenant/files/id123/original/hero.png")
    ).toBe("https://cdn.example.com/files/id123/original/hero.png");
  });

  it("passes through bare keys unchanged", () => {
    expect(normalizeFileDepId("id123/original/hero.png")).toBe("id123/original/hero.png");
  });

  it("returns empty for blank", () => {
    expect(normalizeFileDepId("")).toBe("");
    expect(normalizeFileDepId("   ")).toBe("");
  });
});

describe("fileKeyFromDepId", () => {
  it("extracts path after /files/", () => {
    expect(fileKeyFromDepId("https://cdn.example.com/files/abc/original/x.png")).toBe(
      "abc/original/x.png"
    );
  });

  it("returns bare key as-is", () => {
    expect(fileKeyFromDepId("abc/original/x.png")).toBe("abc/original/x.png");
  });
});

describe("fileDepAliases", () => {
  it("includes normalized url and key", () => {
    const a = fileDepAliases("https://CDN.ex.com/files/k/f.png?x=1");
    expect(a).toContain("https://cdn.ex.com/files/k/f.png");
    expect(a).toContain("k/f.png");
  });
});
