import { describe, it, expect } from "vitest";
import {
  FolderNode,
  FolderAdapter,
  sortByDepth,
  buildFolderPath,
  syncFolders,
  validateFolderMapping,
} from "../shared/src/folders";

const N = (id: string, parentId: string | null, slug: string): FolderNode => ({
  id,
  parentId,
  slug,
  name: slug,
});

/** In-memory adapter. Seeds pre-existing target folders; records creates. */
function fakeAdapter(opts: {
  existing?: FolderNode[];
  failOn?: (input: { name: string; slug: string; parentId: string | null }) => boolean;
} = {}): FolderAdapter & { created: Array<{ slug: string; parentId: string | null }> } {
  const existing = opts.existing ?? [];
  const created: Array<{ slug: string; parentId: string | null }> = [];
  let seq = 0;
  return {
    created,
    listTargetFolders: async () => existing,
    createFolder: async (input) => {
      if (opts.failOn?.(input)) throw new Error(`boom: ${input.slug}`);
      created.push({ slug: input.slug, parentId: input.parentId });
      const id = `t${++seq}`;
      // make it visible to subsequent lookups in the same run via the engine's index
      return id;
    },
  };
}

describe("sortByDepth", () => {
  it("orders parents before children regardless of input order", () => {
    const folders = [N("c", "b", "deep"), N("a", null, "root"), N("b", "a", "mid")];
    const sorted = sortByDepth(folders).map((f) => f.id);
    expect(sorted.indexOf("a")).toBeLessThan(sorted.indexOf("b"));
    expect(sorted.indexOf("b")).toBeLessThan(sorted.indexOf("c"));
  });

  it("does not infinite-loop on a cycle", () => {
    const folders = [N("x", "y", "x"), N("y", "x", "y")];
    expect(() => sortByDepth(folders)).not.toThrow();
  });
});

describe("buildFolderPath", () => {
  it("joins slugs from root to leaf", () => {
    const all = [N("a", null, "media"), N("b", "a", "images"), N("c", "b", "heroes")];
    expect(buildFolderPath(all[2], all)).toBe("/media/images/heroes");
  });
});

describe("syncFolders", () => {
  it("returns empty result for no folders", async () => {
    const r = await syncFolders(fakeAdapter(), []);
    expect(r.idMap.size).toBe(0);
    expect(r.created).toBe(0);
  });

  it("creates missing folders parents-first and maps source→target", async () => {
    const adapter = fakeAdapter();
    const src = [N("s2", "s1", "child"), N("s1", null, "parent")];
    const r = await syncFolders(adapter, src);
    expect(r.created).toBe(2);
    expect(r.idMap.has("s1")).toBe(true);
    expect(r.idMap.has("s2")).toBe(true);
    // parent created before child
    expect(adapter.created[0].slug).toBe("parent");
    expect(adapter.created[1].slug).toBe("child");
    // child created under the mapped target parent id, not the source id
    expect(adapter.created[1].parentId).toBe(r.idMap.get("s1"));
  });

  it("reuses an existing target folder instead of creating", async () => {
    const adapter = fakeAdapter({ existing: [N("existing", null, "parent")] });
    const r = await syncFolders(adapter, [N("s1", null, "parent")]);
    expect(r.reused).toBe(1);
    expect(r.created).toBe(0);
    expect(r.idMap.get("s1")).toBe("existing");
  });

  it("records a failed folder and cascade-fails its descendants", async () => {
    const adapter = fakeAdapter({ failOn: (i) => i.slug === "parent" });
    const src = [N("s1", null, "parent"), N("s2", "s1", "child")];
    const r = await syncFolders(adapter, src);
    expect(r.idMap.has("s1")).toBe(false);
    expect(r.idMap.has("s2")).toBe(false);
    expect(r.failed.map((f) => f.folder.id).sort()).toEqual(["s1", "s2"]);
    // child was never even attempted
    expect(adapter.created.length).toBe(0);
  });

  it("dry-run maps every folder without touching the adapter", async () => {
    const adapter = fakeAdapter();
    const r = await syncFolders(adapter, [N("s1", null, "p")], { dryRun: true });
    expect(r.idMap.get("s1")).toBe("dry-run-s1");
    expect(adapter.created.length).toBe(0);
  });
});

describe("validateFolderMapping", () => {
  const sync = {
    idMap: new Map([["sf1", "tf1"]]),
    created: 1,
    reused: 0,
    failed: [{ folder: N("sf2", null, "broken"), error: "boom" }],
  };

  it("passes when every referenced folder resolved", () => {
    const r = validateFolderMapping([{ itemId: "i1", folderId: "sf1" }], sync);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("ignores items intentionally at root (null folderId)", () => {
    const r = validateFolderMapping([{ itemId: "i1", folderId: null }], sync);
    expect(r.ok).toBe(true);
  });

  it("treats Kibo CMS's 'root' sentinel as no-folder (not an unmapped folder)", () => {
    const r = validateFolderMapping(
      [{ itemId: "f1", folderId: "root" }, { itemId: "f2", folderId: "" }],
      sync
    );
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("flags create-failed folders", () => {
    const r = validateFolderMapping([{ itemId: "i1", folderId: "sf2" }], sync);
    expect(r.ok).toBe(false);
    expect(r.issues[0].reason).toBe("create-failed");
    expect(r.rootFallbackCount).toBe(1);
  });

  it("flags folders absent from the source tree as unmapped", () => {
    const r = validateFolderMapping([{ itemId: "i1", folderId: "ghost" }], sync);
    expect(r.ok).toBe(false);
    expect(r.issues[0].reason).toBe("unmapped");
  });
});
