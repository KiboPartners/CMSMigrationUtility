import { describe, it, expect } from "vitest";
import { cleanRef } from "../packages/cms-entries/src/clone";

describe("cleanRef (ref-field input shape)", () => {
  it("strips entryId, keeping { modelId, id } (RefFieldInput)", () => {
    expect(cleanRef({ modelId: "m", entryId: "e", id: "e#0001" })).toEqual({ modelId: "m", id: "e#0001" });
  });

  it("falls back to entryId when id is absent", () => {
    expect(cleanRef({ modelId: "m", entryId: "e" })).toEqual({ modelId: "m", id: "e" });
  });

  it("maps arrays of refs (multipleValues)", () => {
    expect(cleanRef([{ modelId: "m", entryId: "a", id: "a#1" }, { modelId: "m", entryId: "b", id: "b#1" }]))
      .toEqual([{ modelId: "m", id: "a#1" }, { modelId: "m", id: "b#1" }]);
  });

  it("leaves non-ref values untouched", () => {
    expect(cleanRef("hello")).toBe("hello");
    expect(cleanRef(42)).toBe(42);
    expect(cleanRef({ foo: "bar" })).toEqual({ foo: "bar" });
  });
});
