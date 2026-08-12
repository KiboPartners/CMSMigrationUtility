import { describe, it, expect } from "vitest";
import { filterFoldersForIds, FolderNode } from "../src/shared/folders";

const N = (id: string, parentId: string | null, slug: string): FolderNode => ({
  id,
  parentId,
  slug,
  name: slug,
});

describe("filterFoldersForIds", () => {
  it("keeps only the file's folder and ancestors", () => {
    const folders = [
      N("a", null, "media"),
      N("b", "a", "images"),
      N("c", "b", "heroes"),
      N("x", null, "other"),
      N("y", "x", "unused"),
    ];
    const kept = filterFoldersForIds(folders, new Set(["c"]));
    expect(kept.map((f) => f.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("returns empty when keepIds is empty", () => {
    expect(filterFoldersForIds([N("a", null, "x")], new Set())).toEqual([]);
  });
});
