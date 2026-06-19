import { describe, it, expect } from "vitest";
import { normalizeFolderId, ROOT_FOLDER_ID } from "../packages/page-builder/src/folders";

describe("normalizeFolderId", () => {
  it("treats Kibo CMS's 'root' sentinel as no-folder (null)", () => {
    expect(normalizeFolderId(ROOT_FOLDER_ID)).toBeNull();
    expect(normalizeFolderId("root")).toBeNull();
  });

  it("treats empty/missing as null", () => {
    expect(normalizeFolderId("")).toBeNull();
    expect(normalizeFolderId(undefined)).toBeNull();
    expect(normalizeFolderId(null)).toBeNull();
    expect(normalizeFolderId(123)).toBeNull();
  });

  it("passes through a real folder id", () => {
    expect(normalizeFolderId("fldr_abc123")).toBe("fldr_abc123");
  });
});
