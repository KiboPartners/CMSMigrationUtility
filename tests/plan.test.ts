import { describe, it, expect } from "vitest";
import { buildCatalog, resolveDependencies } from "../shared/src/catalog";
import { planMigration, parseSelection } from "../shared/src/plan";

const catalog = buildCatalog(
  { role: "source", tenant: "t", locale: "en-US" },
  [
    { type: "model", total: 1, items: [{ type: "model", id: "m1", label: "M1" }] },
    { type: "cms-entry", total: 1, items: [{ type: "cms-entry", id: "e1", label: "E1", dependsOn: ["m1", "https://cdn/f.png"] }] },
    { type: "file", total: 1, items: [{ type: "file", id: "https://cdn/f.png", label: "f.png" }] },
  ],
  null
);

describe("planMigration", () => {
  it("expands dependencies and orders model → file → cms-entry", () => {
    const p = planMigration(catalog, ["e1"]);
    expect(p.selectedCount).toBe(1);
    expect(p.resolvedCount).toBe(3);
    expect(p.steps.map((s) => s.type)).toEqual(["model", "file", "cms-entry"]);
    expect(p.addedByDependencies.sort()).toEqual(["https://cdn/f.png", "m1"]);
  });

  it("reports unknown ids instead of dropping them", () => {
    const p = planMigration(catalog, ["nope"]);
    expect(p.unknownIds).toContain("nope");
  });
});

describe("resolveDependencies", () => {
  it("pulls in transitive deps", () => {
    const ids = resolveDependencies(catalog, ["e1"]);
    expect([...ids].sort()).toEqual(["e1", "https://cdn/f.png", "m1"]);
  });
});

describe("parseSelection", () => {
  it("splits on commas, spaces, and newlines", () => {
    expect(parseSelection("a, b\nc d")).toEqual(["a", "b", "c", "d"]);
  });
});
