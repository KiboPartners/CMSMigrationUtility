import { describe, it, expect } from "vitest";
import {
  collectHttpsUrls,
  assertTargetLocalCdn,
  assertMigratedFileRefs,
  tenantsDiffer,
} from "../e2e/cdn-assert";

describe("collectHttpsUrls", () => {
  it("walks nested objects and arrays", () => {
    const urls = collectHttpsUrls({
      a: "https://src.example/x.png",
      b: [{ c: "https://tgt.example/y.png" }, "not-a-url"],
    });
    expect(urls.sort()).toEqual(["https://src.example/x.png", "https://tgt.example/y.png"].sort());
  });
});

describe("tenantsDiffer", () => {
  it("true when both set and unequal", () => {
    expect(tenantsDiffer("1000502", "1000611")).toBe(true);
  });
  it("false when equal or blank", () => {
    expect(tenantsDiffer("1000502", "1000502")).toBe(false);
    expect(tenantsDiffer("", "1000611")).toBe(false);
  });
});

describe("assertTargetLocalCdn", () => {
  it("fails when source CDN host remains (distinct CDN hosts)", () => {
    expect(() =>
      assertTargetLocalCdn(
        { src: "https://source.cloudfront.net/a.png" },
        { sourceCdn: "source.cloudfront.net", targetCdn: "target.cloudfront.net", label: "entry" }
      )
    ).toThrow(/source\.cloudfront\.net/);
  });

  it("passes when only target CDN host is used", () => {
    expect(() =>
      assertTargetLocalCdn(
        { src: "https://target.cloudfront.net/a.png", path: "/local" },
        { sourceCdn: "source.cloudfront.net", targetCdn: "target.cloudfront.net", label: "entry" }
      )
    ).not.toThrow();
  });

  it("skips host check when CDN hosts are identical (shared multi-tenant CDN)", () => {
    // Host alone cannot prove locality; file-ref assert covers remaps.
    expect(() =>
      assertTargetLocalCdn(
        { src: "https://shared.cloudfront.net/a.png" },
        {
          sourceCdn: "shared.cloudfront.net",
          targetCdn: "shared.cloudfront.net",
          sourceTenant: "1000502",
          targetTenant: "1000611",
          label: "entry",
        }
      )
    ).not.toThrow();
  });
});

describe("assertMigratedFileRefs", () => {
  const map = {
    "https://shared.cloudfront.net/files/old/a.png": "https://shared.cloudfront.net/files/new/a.png",
  };

  it("fails when payload still has a sourceUrl that the keymap remapped", () => {
    expect(() =>
      assertMigratedFileRefs(
        { image: "https://shared.cloudfront.net/files/old/a.png" },
        { label: "entry", sourceTenant: "S", targetTenant: "T", urlMap: map }
      )
    ).toThrow(/should have been remapped/);
  });

  it("passes when payload uses the targetUrl from the keymap", () => {
    expect(() =>
      assertMigratedFileRefs(
        { image: "https://shared.cloudfront.net/files/new/a.png" },
        { label: "entry", sourceTenant: "S", targetTenant: "T", urlMap: map }
      )
    ).not.toThrow();
  });

  it("no-ops when urlMap is empty (same-key shared CDN)", () => {
    expect(() =>
      assertMigratedFileRefs(
        { image: "https://shared.cloudfront.net/files/same/a.png" },
        { label: "entry", sourceTenant: "S", targetTenant: "T", urlMap: {} }
      )
    ).not.toThrow();
  });

  it("ignores unrelated https URLs", () => {
    expect(() =>
      assertMigratedFileRefs(
        { image: "https://cdn.other.com/x.png", link: "https://example.com" },
        { label: "page", sourceTenant: "S", targetTenant: "T", urlMap: map }
      )
    ).not.toThrow();
  });
});
