import { describe, it, expect, vi } from "vitest";
import { transferBinary, presignFor, FileMeta, SourceAssetMissingError } from "../src/shared/binary";

const meta: FileMeta = { id: "f1", key: "abc/cat.png", name: "cat.png", type: "image/png", size: 5 };

function fakeTargetClient() {
  return {
    request: vi.fn(async () => ({
      fileManager: {
        getPreSignedPostPayload: {
          data: { data: { url: "https://s3/bucket", fields: { key: "newid/cat.png" } }, file: { id: "newid", key: "newid/cat.png" } },
          error: null,
        },
      },
    })),
  };
}

describe("transferBinary", () => {
  it("fetches source bytes, presigns on target, uploads, returns key", async () => {
    const target = fakeTargetClient();
    const fetchFn = vi
      .fn()
      // 1st call: source CDN GET
      .mockResolvedValueOnce(new Response(Buffer.from("bytes"), { status: 200 }))
      // 2nd call: S3 POST
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const out = await transferBinary({
      meta,
      sourceUrl: "https://cdn.source/cat.png",
      targetClient: target as never,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(out.key).toBe("newid/cat.png");
    expect(out.fileId).toBe("newid");
    expect(target.request).toHaveBeenCalledOnce(); // presign
    expect(fetchFn).toHaveBeenCalledTimes(2); // source GET + S3 POST
  });

  it("throws SourceAssetMissingError on a 404 source (orphan metadata, no binary)", async () => {
    const target = fakeTargetClient();
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 404 }));
    await expect(
      transferBinary({
        meta,
        sourceUrl: "https://cdn.source/missing.png",
        targetClient: target as never,
        fetchFn: fetchFn as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(SourceAssetMissingError);
  });

  it("throws a generic error on a non-404 source failure (e.g. 500)", async () => {
    const target = fakeTargetClient();
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(
      transferBinary({
        meta,
        sourceUrl: "https://cdn.source/x.png",
        targetClient: target as never,
        fetchFn: fetchFn as unknown as typeof fetch,
      })
    ).rejects.toThrow(/source fetch failed .*500/i);
  });

  it("presignFor sends only name/type/size — never a key (server owns key generation)", async () => {
    const target = fakeTargetClient();
    await presignFor(target as never, meta);
    const vars = target.request.mock.calls[0][1] as { data: Record<string, unknown> };
    expect(vars.data).toEqual({ name: "cat.png", type: "image/png", size: 5 });
    expect(vars.data).not.toHaveProperty("key");
  });
});
