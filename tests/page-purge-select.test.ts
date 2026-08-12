import { describe, it, expect } from "vitest";
import { selectedFilter, pageKeys, barePageId } from "../src/artifacts/page-builder/purge";

describe("page purge selectedFilter / pageKeys", () => {
  const page = {
    id: "wb-page-rev#0001",
    entryId: "wb-page-entry",
    path: "/about",
    slug: "about",
    properties: { path: "/about-props" },
  };

  it("matches catalog entryId (primary catalog id)", () => {
    expect(selectedFilter(new Set(["wb-page-entry"]), ...pageKeys(page))).toBe(true);
  });

  it("matches bare id when catalog strips #revision", () => {
    expect(barePageId(page.id)).toBe("wb-page-rev");
    expect(selectedFilter(new Set(["wb-page-rev"]), ...pageKeys(page))).toBe(true);
  });

  it("matches path / slug / properties.path", () => {
    expect(selectedFilter(new Set(["/about"]), ...pageKeys(page))).toBe(true);
    expect(selectedFilter(new Set(["about"]), ...pageKeys(page))).toBe(true);
    expect(selectedFilter(new Set(["/about-props"]), ...pageKeys(page))).toBe(true);
  });

  it("rejects unrelated selection", () => {
    expect(selectedFilter(new Set(["other-entry"]), ...pageKeys(page))).toBe(false);
  });

  it("keeps everything when selection is empty/absent", () => {
    expect(selectedFilter(null, ...pageKeys(page))).toBe(true);
    expect(selectedFilter(new Set(), ...pageKeys(page))).toBe(true);
  });
});
