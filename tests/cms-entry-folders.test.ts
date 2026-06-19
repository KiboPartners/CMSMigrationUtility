import { describe, it, expect } from "vitest";
import { normalizeFolderId, entryFolderId, ROOT_FOLDER_ID } from "../packages/cms-entries/src/folders";

describe("cms-entries normalizeFolderId", () => {
  it("treats 'root' / empty / non-string as no-folder", () => {
    expect(normalizeFolderId(ROOT_FOLDER_ID)).toBeNull();
    expect(normalizeFolderId("")).toBeNull();
    expect(normalizeFolderId(undefined)).toBeNull();
    expect(normalizeFolderId(42)).toBeNull();
  });
  it("passes through a real folder id", () => {
    expect(normalizeFolderId("fldr_x")).toBe("fldr_x");
  });
});

describe("entryFolderId", () => {
  it("reads wbyAco_location.folderId from a hoisted entry", () => {
    expect(entryFolderId({ wbyAco_location: { folderId: "fldr_x" } })).toBe("fldr_x");
  });
  it("returns null for root / missing", () => {
    expect(entryFolderId({ wbyAco_location: { folderId: "root" } })).toBeNull();
    expect(entryFolderId({})).toBeNull();
    expect(entryFolderId({ wbyAco_location: {} })).toBeNull();
  });
});
