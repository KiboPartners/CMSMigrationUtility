import { describe, it, expect } from "vitest";
import { groupPurgeSelection } from "../src/shared/purge-selection";

describe("groupPurgeSelection", () => {
  const meta = new Map([
    ["PromoBanner", { type: "model" }],
    ["Article", { type: "model" }],
    ["entry-1", { type: "cms-entry", model: "PromoBanner" }],
    ["entry-2", { type: "cms-entry", model: "Article" }],
    ["https://cdn/x.png", { type: "file" }],
    ["page-1", { type: "page" }],
  ]);

  it("maps model rows to cms-entry with models set and no ids", () => {
    const { byType, modelFullPurge, unknown } = groupPurgeSelection(["PromoBanner"], meta);
    expect(unknown).toEqual([]);
    expect([...modelFullPurge]).toEqual(["PromoBanner"]);
    const g = byType.get("cms-entry")!;
    expect(g.ids).toEqual([]);
    expect([...g.models]).toEqual(["PromoBanner"]);
  });

  it("keeps entry ids separate from model-full-purge", () => {
    const { byType, modelFullPurge } = groupPurgeSelection(
      ["PromoBanner", "entry-2", "https://cdn/x.png"],
      meta
    );
    expect([...modelFullPurge]).toEqual(["PromoBanner"]);
    expect(byType.get("cms-entry")!.ids).toEqual(["entry-2"]);
    expect(byType.get("cms-entry")!.models.has("PromoBanner")).toBe(true);
    expect(byType.get("cms-entry")!.models.has("Article")).toBe(true);
    expect(byType.get("file")!.ids).toEqual(["https://cdn/x.png"]);
  });

  it("collects unknown ids", () => {
    const { unknown } = groupPurgeSelection(["nope", "page-1"], meta);
    expect(unknown).toEqual(["nope"]);
  });
});
