import { describe, it, expect } from "vitest";
import { diffModelFields, createOpFor } from "../packages/cms-entries/src/provision";

describe("diffModelFields", () => {
  it("flags missing-on-target and type-mismatch as blocking; extra as warning", () => {
    const c = diffModelFields(
      "m",
      [{ fieldId: "title", type: "text" }, { fieldId: "n", type: "number" }, { fieldId: "b", type: "rich-text" }],
      [{ fieldId: "title", type: "text" }, { fieldId: "n", type: "text" }, { fieldId: "x", type: "boolean" }]
    );
    expect(c.ok).toBe(false);
    expect(c.blocking.map((b) => b.fieldId).sort()).toEqual(["b", "n"]);
    expect(c.blocking.find((b) => b.fieldId === "n")?.issue).toBe("type-mismatch");
    expect(c.blocking.find((b) => b.fieldId === "b")?.issue).toBe("missing-on-target");
    expect(c.warnings.map((w) => w.fieldId)).toEqual(["x"]);
  });

  it("is ok when field sets match", () => {
    const c = diffModelFields("m", [{ fieldId: "a", type: "text" }], [{ fieldId: "a", type: "text" }]);
    expect(c.ok).toBe(true);
    expect(c.blocking).toEqual([]);
  });
});

describe("createOpFor", () => {
  it("builds create<Capitalized singularApiName>", () => {
    expect(createOpFor({ singularApiName: "promoBanner" })).toBe("createPromoBanner");
    expect(createOpFor({ singularApiName: "DifferentModelOne" })).toBe("createDifferentModelOne");
  });
});
