// tests/binary-export-manifest.test.ts
import { describe, it, expect } from "vitest";
import { planBinaryDownloads, BinaryManifest } from "../src/artifacts/file-manager/export";
import { parseMaxBytes } from "../src/shared/binary";

const files = [
  { id: "a", key: "a.png", name: "a.png", size: 1000, type: "image/png", src: "http://x/a.png", tags: [] },
  { id: "b", key: "b.png", name: "b.png", size: 50_000_000, type: "image/png", src: "http://x/b.png", tags: [] },
  { id: "c", key: "c.png", name: "c.png", size: 1000, type: "image/png", src: "http://x/c.png", tags: [] },
];

describe("planBinaryDownloads", () => {
  it("skips files over the size gate", () => {
    const plan = planBinaryDownloads(files as never, null, parseMaxBytes(10)); // 10 MB
    expect(plan.skippedLarge.map((f) => f.id)).toEqual(["b"]);
    expect(plan.toDownload.map((f) => f.id)).toEqual(["a", "c"]);
  });

  it("resumes: already-downloaded files are not re-downloaded", () => {
    const manifest: BinaryManifest = {
      downloadedAt: "t",
      maxFileBytes: 0,
      entries: [{ id: "a", key: "a.png", status: "downloaded", bytes: 1000 }],
    };
    const plan = planBinaryDownloads(files as never, manifest, 0);
    expect(plan.alreadyDone).toContain("a");
    expect(plan.toDownload.map((f) => f.id)).toEqual(["b", "c"]);
  });

  it("retries previously errored files", () => {
    const manifest: BinaryManifest = {
      downloadedAt: "t",
      maxFileBytes: 0,
      entries: [{ id: "a", key: "a.png", status: "error", error: "timeout" }],
    };
    const plan = planBinaryDownloads(files as never, manifest, 0);
    expect(plan.toDownload.map((f) => f.id)).toContain("a");
  });
});
