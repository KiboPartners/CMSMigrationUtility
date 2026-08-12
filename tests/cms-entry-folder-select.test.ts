import { describe, it, expect } from "vitest";
import { foldersForSelectedEntries } from "../src/artifacts/cms-entries/clone";
import type { FolderNode } from "../src/shared/folders";

const folders: FolderNode[] = [
  { id: "a", parentId: null, slug: "content", name: "content" },
  { id: "b", parentId: "a", slug: "blog", name: "blog" },
  { id: "c", parentId: "b", slug: "2026", name: "2026" },
  { id: "x", parentId: null, slug: "orphans", name: "orphans" },
];

describe("foldersForSelectedEntries", () => {
  it("keeps only folders for selected entries (+ ancestors)", () => {
    const entries = [
      { entryId: "e1", wbyAco_location: { folderId: "c" } },
      { entryId: "e2", wbyAco_location: { folderId: "x" } },
    ];
    const kept = foldersForSelectedEntries(folders, entries, new Set(["e1"]));
    expect(kept.map((f) => f.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("ignores root sentinel folder ids", () => {
    const entries = [{ entryId: "e1", wbyAco_location: { folderId: "root" } }];
    expect(foldersForSelectedEntries(folders, entries, new Set(["e1"]))).toEqual([]);
  });
});
