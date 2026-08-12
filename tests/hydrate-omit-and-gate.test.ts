import { describe, it, expect } from "vitest";
import { buildCatalog, CatalogItem } from "../src/shared/catalog";
import { planMigration } from "../src/shared/plan";
import {
  catalogOmittingDeps,
  hydrateDependencies,
  shouldAbortForUnresolvedDeps,
  formatUnresolvedDepsMessage,
} from "../src/shared/hydrate-deps";
import { normalizeFileDepId } from "../src/shared/file-deps";

const FILE_URL = "https://cdn.example.com/files/abc/original/hero.png";
const FILE_ID = normalizeFileDepId(FILE_URL);

describe("catalogOmittingDeps / --omit-deps", () => {
  it("strips omitted file edges so planMigration does not pull them back", () => {
    const page: CatalogItem = {
      type: "page",
      id: "/home",
      label: "Home",
      dependsOn: [FILE_URL],
    };
    const file: CatalogItem = {
      type: "file",
      id: FILE_ID,
      label: "hero.png",
    };
    const catalog = buildCatalog(
      { role: "source", tenant: "t", locale: "en-US" },
      [
        { type: "page", total: 1, items: [page] },
        { type: "file", total: 1, items: [file] },
      ],
      null
    );

    const withFile = planMigration(catalog, ["/home"]);
    expect(withFile.steps.map((s) => s.type)).toContain("file");

    const omitted = catalogOmittingDeps(catalog, [FILE_ID]);
    const plan = planMigration(omitted, ["/home"]);
    expect(plan.steps.map((s) => s.type)).toEqual(["page"]);
    expect(plan.addedByDependencies).not.toContain(FILE_ID);
  });

  it("hydrate with omitIds does not fetch or report the omitted dep", async () => {
    const page: CatalogItem = {
      type: "page",
      id: "/home",
      label: "Home",
      dependsOn: [FILE_URL + "?v=9"],
    };
    const catalog = buildCatalog(
      { role: "source", tenant: "t", locale: "en-US" },
      [{ type: "page", total: 1, items: [page] }],
      null
    );

    let fetchCalls = 0;
    const hydrated = await hydrateDependencies(
      catalog,
      ["/home"],
      {
        fetchFileByDepId: async () => {
          fetchCalls++;
          return { type: "file", id: FILE_ID, label: "hero.png" };
        },
      },
      { omitIds: [FILE_URL] }
    );

    expect(fetchCalls).toBe(0);
    expect(hydrated.hydratedIds).toEqual([]);
    expect(hydrated.unresolvedIds).toEqual([]);
    const plan = planMigration(hydrated.catalog, ["/home"]);
    expect(plan.steps.map((s) => s.type)).toEqual(["page"]);
  });
});

describe("shouldAbortForUnresolvedDeps (migrate gate)", () => {
  it("aborts when unresolved and allowMissingDeps is false", () => {
    expect(shouldAbortForUnresolvedDeps(["https://cdn/x"], false)).toBe(true);
  });

  it("does not abort when allowMissingDeps is true", () => {
    expect(shouldAbortForUnresolvedDeps(["https://cdn/x"], true)).toBe(false);
  });

  it("does not abort when nothing unresolved", () => {
    expect(shouldAbortForUnresolvedDeps([], false)).toBe(false);
  });

  it("formats a stable error message", () => {
    expect(formatUnresolvedDepsMessage(["a", "b"])).toBe("2 unresolved dep(s): a, b");
    expect(formatUnresolvedDepsMessage(["1", "2", "3", "4", "5", "6"])).toContain("…");
  });
});
