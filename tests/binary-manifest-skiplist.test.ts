import { describe, it, expect } from "vitest";
import { buildManifestLines } from "../src/artifacts/file-manager/clone";

const files = [
  { id: "a", key: "a.png", src: "http://x/a.png" },
  { id: "b", key: "big.zip", src: "http://x/big.zip" },
] as never[];

describe("buildManifestLines", () => {
  it("adds an explicit copy line for each skipped-large file", () => {
    const lines = buildManifestLines(files, new Set(["big.zip"]), "src-bkt", "tgt-bkt", "files/", true);
    const joined = lines.join("\n");
    expect(joined).toMatch(/SKIPPED by the size gate/);
    expect(joined).toContain(`aws s3 cp 's3://src-bkt/big.zip' 's3://tgt-bkt/big.zip'`);
  });

  it("omits the skip section when nothing was skipped", () => {
    const lines = buildManifestLines(files, new Set(), "src-bkt", "tgt-bkt", "files/", true);
    expect(lines.join("\n")).not.toMatch(/SKIPPED by the size gate/);
  });
});
