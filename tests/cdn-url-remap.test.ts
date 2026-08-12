import { describe, it, expect } from "vitest";
import { rewriteCdnUrls } from "../src/shared/utils";

describe("rewriteCdnUrls with key remap", () => {
  const src = "src.cdn", tgt = "tgt.cdn";
  const map = { "https://src.cdn/b/dog.png": "https://tgt.cdn/9f2/dog.png" };

  it("remaps a changed-key URL in full, then domain-swaps the rest", () => {
    const content = { hero: "https://src.cdn/b/dog.png", icon: "https://src.cdn/a/cat.png" };
    const out = rewriteCdnUrls(content, src, tgt, map) as typeof content;
    expect(out.hero).toBe("https://tgt.cdn/9f2/dog.png"); // full remap (key changed)
    expect(out.icon).toBe("https://tgt.cdn/a/cat.png");   // domain swap (key unchanged)
  });

  it("is unchanged from old behavior when no map is given", () => {
    const content = { icon: "https://src.cdn/a/cat.png" };
    const out = rewriteCdnUrls(content, src, tgt) as typeof content;
    expect(out.icon).toBe("https://tgt.cdn/a/cat.png");
  });
});
