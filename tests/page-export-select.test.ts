import { describe, it, expect } from "vitest";
import { filterFoldersForIds } from "../src/artifacts/page-builder/export";
import { pageKeys, pagePathOf, selectedFilter } from "../src/artifacts/page-builder/page-ids";
import type { FolderNode } from "../src/shared/folders";

describe("page export --select helpers", () => {
  const folders: FolderNode[] = [
    { id: "f-root", name: "Rootish", slug: "rootish", parentId: null },
    { id: "f-a", name: "A", slug: "a", parentId: "f-root" },
    { id: "f-b", name: "B", slug: "b", parentId: "f-root" },
    { id: "f-a1", name: "A1", slug: "a1", parentId: "f-a" },
  ];

  it("keeps selected folder and ancestors only", () => {
    const kept = filterFoldersForIds(folders, new Set(["f-a1"]));
    expect(kept.map((f) => f.id).sort()).toEqual(["f-a", "f-a1", "f-root"]);
  });

  it("returns empty when nothing selected", () => {
    expect(filterFoldersForIds(folders, new Set())).toEqual([]);
  });

  it("pagePathOf reads properties.path when root path missing", () => {
    expect(pagePathOf({ properties: { path: "/cardio" } })).toBe("/cardio");
    expect(pagePathOf({ path: "/root", properties: { path: "/props" } })).toBe("/root");
  });

  it("import-style selection matches properties.path like purge", () => {
    const page = { entryId: "e1", properties: { path: "/only-me" } };
    expect(selectedFilter(new Set(["/only-me"]), ...pageKeys(page))).toBe(true);
    expect(selectedFilter(new Set(["other"]), ...pageKeys(page))).toBe(false);
  });
});
