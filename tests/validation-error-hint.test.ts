import { describe, it, expect } from "vitest";
import { enrichValidationError } from "../src/artifacts/cms-entries/clone";

describe("enrichValidationError (pure)", () => {
  it("appends null/empty field names on a validation error", () => {
    const out = enrichValidationError("Validation failed.", { title: "x", siteId: null, tags: [] });
    expect(out).toContain("Validation failed.");
    expect(out).toContain("siteId");
    expect(out).toContain("tags");
    expect(out).not.toContain("title");
  });

  it("leaves non-validation errors untouched", () => {
    expect(enrichValidationError("HTTP 504", { siteId: null })).toBe("HTTP 504");
  });

  it("does not append when no field is null/empty", () => {
    expect(enrichValidationError("Validation failed.", { title: "x" })).toBe("Validation failed.");
  });

  it("treats undefined and empty string as suspects", () => {
    const out = enrichValidationError("validation error", { a: undefined, b: "", c: 0 });
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).not.toContain("c"); // 0 is a valid value, not empty
  });
});
