import { describe, it, expect } from "vitest";
import { parseSkippableField, buildSelectionSet, buildListQuery } from "../packages/cms-entries/src/introspect";

const MODEL = {
  modelId: "promoBanner",
  name: "PromoBanner",
  pluralApiName: "promoBanners",
  fields: [{ fieldId: "title", type: "text", multipleValues: false }],
  listOperation: "listPromoBanners",
  createOperation: "createPromoBanner",
  updateOperation: "updatePromoBanner",
  publishOperation: "publishPromoBanner",
  deleteOperation: "deletePromoBanner",
  whereInputType: "PromoBannerListWhereInput",
};

describe("parseSkippableField", () => {
  it("extracts a corrupt (fromStorage) field", () => {
    expect(parseSkippableField(new Error(
      'RichText value received in "fromStorage" function is not an object in field "rich-text@il530fs9" - description.'
    ))).toBe("description");
  });

  it('extracts from "Cannot query field"', () => {
    expect(parseSkippableField(new Error('Cannot query field "gallery" on type "PromoBannerValues".'))).toBe("gallery");
  });

  it('extracts from "must not have a selection"', () => {
    expect(parseSkippableField(new Error('Field "image" must not have a selection since type "String" has no subfields.'))).toBe("image");
  });

  it('extracts from "must have a selection of subfields"', () => {
    expect(parseSkippableField(new Error('Field "block" of type "BlockType" must have a selection of subfields. Did you mean "block { ... }"?'))).toBe("block");
  });

  it("returns null for unrelated errors", () => {
    expect(parseSkippableField(new Error("Network error: ECONNRESET"))).toBeNull();
  });
});

describe("buildSelectionSet extraRootLines (ACO folder line)", () => {
  it("places wbyAco_location beside values, not inside it", () => {
    const sel = buildSelectionSet(MODEL.fields, undefined, undefined, ["wbyAco_location { folderId }"]);
    expect(sel).toContain("wbyAco_location { folderId }");
    // it sits at the entry root: after the values block (which holds `title`),
    // never nested among the content fields.
    expect(sel.indexOf("wbyAco_location")).toBeGreaterThan(sel.indexOf("values {"));
    expect(sel.indexOf("wbyAco_location")).toBeGreaterThan(sel.indexOf("title"));
  });

  it("omits extra root lines when none given", () => {
    expect(buildSelectionSet(MODEL.fields)).not.toContain("wbyAco_location");
  });

  it("buildListQuery threads the ACO line into the query", () => {
    const q = buildListQuery(MODEL, undefined, undefined, undefined, undefined, ["wbyAco_location { folderId }"]);
    expect(q).toContain("wbyAco_location { folderId }");
    expect(q).toContain("listPromoBanners");
  });
});
