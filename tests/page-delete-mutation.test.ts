import { describe, it, expect } from "vitest";
import { buildDeletePageMutation } from "../src/artifacts/page-builder/purge";
import type { PageBuilderOps } from "../src/artifacts/page-builder/ops";

function ops(arg: "options" | "permanently"): PageBuilderOps {
  return {
    namespace: "websiteBuilder",
    mutNamespace: "websiteBuilder",
    listPages: "listPages",
    createPage: null,
    updatePage: null,
    publishPage: null,
    deletePage: "deletePage",
    deletePagePermanentArg: arg,
    listCategories: null,
    createCategory: null,
    pageSelection: "id",
    listPagesWhereType: null,
    createPageInputType: null,
    updatePageInputType: null,
    createPageInputFields: new Set(),
    updatePageInputFields: new Set(),
    pageKeyFields: {
      hasSlug: false, hasPath: false, hasPid: false, hasStatus: false, hasEntryId: true, hasProperties: false,
    },
  };
}

describe("buildDeletePageMutation", () => {
  it("Kibo style always binds permanently (omit = hard delete)", () => {
    const q = buildDeletePageMutation(ops("permanently"), false);
    expect(q).toContain("$permanently: Boolean");
    expect(q).toContain("deletePage(id: $id, permanently: $permanently)");
    expect(q).not.toContain("options");
  });

  it("options style inlines permanently for soft/hard", () => {
    expect(buildDeletePageMutation(ops("options"), false)).toContain("options: { permanently: false }");
    expect(buildDeletePageMutation(ops("options"), true)).toContain("options: { permanently: true }");
  });
});
