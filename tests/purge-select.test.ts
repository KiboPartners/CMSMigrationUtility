/**
 * Tests for the purge --select narrowing filter (`selectedFilter`).
 *
 * `selectedFilter(onlyIds, ...keys)` returns true when an item should be KEPT
 * (i.e. deleted by the purge). It is a NARROWING filter: an empty/absent
 * selection keeps everything (current behavior); a populated selection keeps
 * only items whose key(s) intersect the selection.
 *
 * The cms-entries variant is the canonical one (it also normalizes entryIds by
 * stripping any `#revision` suffix, which we exercise here via the helper).
 */
import { describe, it, expect } from "vitest";
import { selectedFilter } from "../packages/cms-entries/src/purge";

/** Mirror of the bare-entryId normalization used inside purgeFromExportFiles/purgeAllEntries. */
function bareEntryId(value: string | null | undefined): string {
  return String(value ?? "").split("#")[0];
}

describe("selectedFilter (purge --select narrowing)", () => {
  it("keeps all items when onlyIds is null/undefined", () => {
    expect(selectedFilter(null, "a")).toBe(true);
    expect(selectedFilter(undefined, "anything")).toBe(true);
  });

  it("keeps all items when onlyIds is an empty set", () => {
    expect(selectedFilter(new Set<string>(), "a")).toBe(true);
  });

  it("keeps only items whose key is in the selection", () => {
    const sel = new Set(["keep-1", "keep-2"]);
    expect(selectedFilter(sel, "keep-1")).toBe(true);
    expect(selectedFilter(sel, "keep-2")).toBe(true);
    expect(selectedFilter(sel, "drop-me")).toBe(false);
  });

  it("keeps an item if ANY of its keys matches (multi-key match)", () => {
    const sel = new Set(["/the/path"]);
    // e.g. a page matched by id / pid / path / slug — only path is selected
    expect(selectedFilter(sel, "page-id-xyz", undefined, "/the/path", "the-slug")).toBe(true);
    expect(selectedFilter(sel, "page-id-xyz", undefined, "/other", "the-slug")).toBe(false);
  });

  it("ignores null/empty keys when matching", () => {
    const sel = new Set(["x"]);
    expect(selectedFilter(sel, null, "", undefined)).toBe(false);
    expect(selectedFilter(sel, null, "x")).toBe(true);
  });

  it("entryId match ignores a #revision suffix", () => {
    const sel = new Set(["entry-123"]);
    // An entry whose id carries a revision suffix is normalized to its bare entryId.
    expect(selectedFilter(sel, bareEntryId("entry-123#0003"))).toBe(true);
    expect(selectedFilter(sel, bareEntryId("entry-999#0001"))).toBe(false);
    // The raw revisioned id should NOT match without normalization.
    expect(selectedFilter(sel, "entry-123#0003")).toBe(false);
  });
});
