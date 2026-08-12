import { describe, it, expect } from "vitest";
import { parsePresignResponse, buildPresignQuery, PRESIGN_FALLBACK } from "../src/shared/binary";

// Webiny nests the AWS presigned-POST object ({ url, fields }) inside the
// `data` JSON scalar — there is no sibling `url` GraphQL field.
const ok = {
  fileManager: {
    getPreSignedPostPayload: {
      data: {
        data: {
          url: "https://s3.example.com/bucket",
          fields: { key: "abc/cat.png", Policy: "p", "X-Amz-Signature": "s" },
        },
        file: { id: "f1", key: "abc/cat.png", name: "cat.png", type: "image/png", size: 10 },
      },
      error: null,
    },
  },
};

describe("presign parsing", () => {
  it("normalizes url, fields, key from the nested data scalar", () => {
    const p = parsePresignResponse(ok);
    expect(p.url).toBe("https://s3.example.com/bucket");
    expect(p.key).toBe("abc/cat.png");
    expect(p.fields["X-Amz-Signature"]).toBe("s");
    expect(p.fields["url"]).toBeUndefined(); // url is not an S3 form field
  });

  it("parses the data scalar delivered as a JSON string", () => {
    const stringy = JSON.parse(JSON.stringify(ok));
    stringy.fileManager.getPreSignedPostPayload.data.data =
      JSON.stringify(ok.fileManager.getPreSignedPostPayload.data.data);
    const p = parsePresignResponse(stringy);
    expect(p.url).toBe("https://s3.example.com/bucket");
    expect(p.fields.key).toBe("abc/cat.png");
  });

  it("throws a clear error when the upload url is absent", () => {
    const noUrl = { fileManager: { getPreSignedPostPayload: { data: { data: { fields: { key: "k" } }, file: { key: "k" } }, error: null } } };
    expect(() => parsePresignResponse(noUrl)).toThrow(/upload url/i);
  });

  it("throws on GraphQL error payload", () => {
    const bad = { fileManager: { getPreSignedPostPayload: { data: null, error: { message: "denied" } } } };
    expect(() => parsePresignResponse(bad)).toThrow("denied");
  });

  it("builds a query for the discovered op + input type", () => {
    const q = buildPresignQuery(PRESIGN_FALLBACK.opName, PRESIGN_FALLBACK.inputType);
    expect(q).toContain("getPreSignedPostPayload(data: $data)");
    expect(q).toContain("$data: PreSignedPostPayloadInput!");
  });
});
