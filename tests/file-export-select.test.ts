import { describe, it, expect } from "vitest";
import { scopeFilesExportForSelection } from "../src/artifacts/file-manager/export";
import type { FileRecord, FolderRecord } from "../src/artifacts/file-manager/files";
import { normalizeFileDepId } from "../src/shared/file-deps";

const folders: FolderRecord[] = [
  { id: "a", name: "media", slug: "media", parentId: null },
  { id: "b", name: "images", slug: "images", parentId: "a" },
  { id: "c", name: "heroes", slug: "heroes", parentId: "b" },
  { id: "x", name: "other", slug: "other", parentId: null },
  { id: "y", name: "unused", slug: "unused", parentId: "x" },
];

function file(
  partial: Partial<FileRecord> & Pick<FileRecord, "id" | "key" | "src">
): FileRecord {
  return {
    name: partial.name ?? partial.key,
    size: 1,
    type: "image/png",
    tags: [],
    location: partial.location ?? null,
    ...partial,
  };
}

describe("scopeFilesExportForSelection", () => {
  const heroSrc = "https://CDN.Example.com/files/abc/original/hero.png?v=1";
  const heroNorm = normalizeFileDepId(heroSrc);
  const files: FileRecord[] = [
    file({
      id: "fm1",
      key: "abc/original/hero.png",
      src: heroNorm,
      location: { folderId: "c" },
    }),
    file({
      id: "fm2",
      key: "other/banner.png",
      src: "https://cdn.example.com/files/other/banner.png",
      location: { folderId: "y" },
    }),
  ];

  it("keeps only the selected file and its folder ancestors (not whole FM tree)", () => {
    const scoped = scopeFilesExportForSelection(files, folders, [heroSrc]);
    expect(scoped.files.map((f) => f.id)).toEqual(["fm1"]);
    expect(scoped.folders.map((f) => f.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("matches selection by S3 key alias", () => {
    const scoped = scopeFilesExportForSelection(files, folders, ["abc/original/hero.png"]);
    expect(scoped.files).toHaveLength(1);
    expect(scoped.files[0].key).toBe("abc/original/hero.png");
  });

  it("returns empty folders when selected file has no folder", () => {
    const rootFile = file({
      id: "fm3",
      key: "root.png",
      src: "https://cdn.example.com/files/root.png",
      location: { folderId: "root" },
    });
    const scoped = scopeFilesExportForSelection([rootFile], folders, [rootFile.src]);
    expect(scoped.files).toHaveLength(1);
    expect(scoped.folders).toEqual([]);
  });
});
