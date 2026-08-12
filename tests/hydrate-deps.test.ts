import { describe, it, expect } from "vitest";
import { buildCatalog, CatalogItem } from "../src/shared/catalog";
import { planMigration } from "../src/shared/plan";
import { hydrateDependencies } from "../src/shared/hydrate-deps";
import { normalizeFileDepId } from "../src/shared/file-deps";

const FILE_URL = "https://cdn.example.com/files/abc/original/hero.png";

describe("hydrateDependencies", () => {
  it("fetches a filtered-out file and planMigration includes a file step", async () => {
    const page: CatalogItem = {
      type: "page",
      id: "/home",
      label: "Home",
      dependsOn: [FILE_URL + "?v=2"],
    };
    const catalog = buildCatalog(
      { role: "source", tenant: "t", locale: "en-US" },
      [
        { type: "page", total: 1, items: [page] },
        { type: "file", total: 0, items: [] },
      ],
      null
    );

    const fileItem: CatalogItem = {
      type: "file",
      id: normalizeFileDepId(FILE_URL),
      label: "hero.png",
      metadata: { key: "abc/original/hero.png" },
    };

    const hydrated = await hydrateDependencies(catalog, ["/home"], {
      fetchFileByDepId: async (id) => {
        expect(normalizeFileDepId(id)).toBe(normalizeFileDepId(FILE_URL));
        return fileItem;
      },
    });

    expect(hydrated.hydratedIds).toEqual([fileItem.id]);
    expect(hydrated.unresolvedIds).toEqual([]);
    const plan = planMigration(hydrated.catalog, hydrated.selectedIds);
    expect(plan.steps.map((s) => s.type)).toEqual(["file", "page"]);
    expect(plan.steps.find((s) => s.type === "file")!.ids).toContain(fileItem.id);
  });

  it("hydrates a model for an entry when models were filtered out", async () => {
    const entry: CatalogItem = {
      type: "cms-entry",
      id: "entry-1",
      label: "E1",
      dependsOn: ["blogPost"],
    };
    const catalog = buildCatalog(
      { role: "source", tenant: "t", locale: "en-US" },
      [
        { type: "cms-entry", total: 1, items: [entry] },
        { type: "model", total: 0, items: [] },
      ],
      null
    );

    const model: CatalogItem = {
      type: "model",
      id: "blogPost",
      label: "Blog Post",
    };

    const hydrated = await hydrateDependencies(catalog, ["entry-1"], {
      fetchModelById: async (id) => (id === "blogPost" ? model : null),
    });

    expect(hydrated.hydratedIds).toContain("blogPost");
    const plan = planMigration(hydrated.catalog, hydrated.selectedIds);
    expect(plan.steps.map((s) => s.type)).toEqual(["model", "cms-entry"]);
  });

  it("reports unresolved when fetcher returns null", async () => {
    const page: CatalogItem = {
      type: "page",
      id: "/x",
      label: "X",
      dependsOn: ["https://cdn.example.com/files/missing/x.png"],
    };
    const catalog = buildCatalog(
      { role: "source", tenant: "t", locale: "en-US" },
      [{ type: "page", total: 1, items: [page] }],
      null
    );
    const hydrated = await hydrateDependencies(catalog, ["/x"], {
      fetchFileByDepId: async () => null,
    });
    expect(hydrated.unresolvedIds.length).toBe(1);
  });
});
