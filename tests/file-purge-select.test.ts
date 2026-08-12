import { describe, it, expect } from "vitest";
import { selectedFilter } from "../src/artifacts/file-manager/purge";

describe("file purge selectedFilter", () => {
  const src = "https://cdn.example.com/files/hero.png";
  const key = "hero.png";
  const id = "fm-abc123";

  it("matches catalog src URL (primary catalog id)", () => {
    expect(selectedFilter(new Set([src]), src, key, id)).toBe(true);
  });

  it("matches key or GraphQL id", () => {
    expect(selectedFilter(new Set([key]), src, key, id)).toBe(true);
    expect(selectedFilter(new Set([id]), src, key, id)).toBe(true);
  });

  it("rejects unrelated selection", () => {
    expect(selectedFilter(new Set(["https://other/files/x.png"]), src, key, id)).toBe(false);
  });

  it("keeps everything when selection is empty/absent", () => {
    expect(selectedFilter(null, src, key, id)).toBe(true);
    expect(selectedFilter(new Set(), src, key, id)).toBe(true);
  });
});
