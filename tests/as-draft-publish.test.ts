import { describe, it, expect } from "vitest";
import { sourceIsPublished, shouldPublishAfterUpsert } from "../src/shared/utils";

describe("sourceIsPublished", () => {
  it("reads meta.status first", () => {
    expect(sourceIsPublished({ meta: { status: "published" }, status: "draft" })).toBe(true);
    expect(sourceIsPublished({ meta: { status: "draft" }, status: "published" })).toBe(false);
  });

  it("falls back to root status", () => {
    expect(sourceIsPublished({ status: "published" })).toBe(true);
    expect(sourceIsPublished({ status: "draft" })).toBe(false);
  });

  it("missing/unknown → not published", () => {
    expect(sourceIsPublished({})).toBe(false);
    expect(sourceIsPublished({ meta: {} })).toBe(false);
    expect(sourceIsPublished({ status: "unpublished" })).toBe(false);
  });
});

describe("shouldPublishAfterUpsert", () => {
  it("asDraft true → never publish", () => {
    expect(shouldPublishAfterUpsert(true, true)).toBe(false);
    expect(shouldPublishAfterUpsert(true, false)).toBe(false);
  });

  it("asDraft false → publish only when source published", () => {
    expect(shouldPublishAfterUpsert(false, true)).toBe(true);
    expect(shouldPublishAfterUpsert(false, false)).toBe(false);
  });
});
