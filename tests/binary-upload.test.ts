import { describe, it, expect, vi } from "vitest";
import { buildUploadForm, uploadToS3, PresignedPost } from "../src/shared/binary";

const presign: PresignedPost = {
  url: "https://s3.example.com/bucket",
  fields: { key: "abc/cat.png", Policy: "p", "X-Amz-Signature": "s" },
  key: "abc/cat.png",
};

describe("S3 upload", () => {
  it("puts the file field LAST after all presign fields", () => {
    const form = buildUploadForm(presign, Buffer.from("bytes"), "cat.png", "image/png");
    const keys = [...form.keys()];
    expect(keys[keys.length - 1]).toBe("file");
    expect(keys).toContain("Policy");
    expect(keys).toContain("X-Amz-Signature");
  });

  it("POSTs to the presigned url and resolves on 204", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await uploadToS3(presign, Buffer.from("bytes"), "cat.png", "image/png", fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(presign.url);
    expect((init as RequestInit).method).toBe("POST");
  });

  it("throws with S3 body text on failure", async () => {
    const fetchFn = vi.fn(async () => new Response("<Error>AccessDenied</Error>", { status: 403 }));
    await expect(
      uploadToS3(presign, Buffer.from("x"), "cat.png", "image/png", fetchFn as unknown as typeof fetch)
    ).rejects.toThrow(/AccessDenied/);
  });
});
