import { describe, it, expect } from "vitest";
import { buildManifestLines, shQuote } from "../src/artifacts/file-manager/clone";

const files = [
  { id: "a", key: "a.png", src: "http://x/a.png" },
  { id: "b", key: "big.zip", src: "http://x/big.zip" },
] as never[];

const skippedOnly = [
  { id: "b", key: "big.zip", src: "http://x/big.zip" },
] as never[];

describe("buildManifestLines — manifestOnly=true (manifest-only import)", () => {
  it("includes the aws s3 sync Option A line and a cp line for every file", () => {
    const lines = buildManifestLines(files, new Set(), "src", "tgt", "files/", true);
    const joined = lines.join("\n");
    expect(joined).toContain("aws s3 sync s3://src/files/ s3://tgt/files/");
    expect(joined).toContain(`aws s3 cp 's3://src/a.png' 's3://tgt/a.png'`);
    expect(joined).toContain(`aws s3 cp 's3://src/big.zip' 's3://tgt/big.zip'`);
  });
});

describe("buildManifestLines — manifestOnly=false (streaming/upload import with gaps)", () => {
  it("includes cp lines only for the passed (not-transferred) files and no aws s3 sync line", () => {
    const lines = buildManifestLines(skippedOnly, new Set(), "src", "tgt", "files/", false);
    const joined = lines.join("\n");
    expect(joined).toContain(`aws s3 cp 's3://src/big.zip' 's3://tgt/big.zip'`);
    expect(joined).not.toContain(`aws s3 cp 's3://src/a.png' 's3://tgt/a.png'`);
    expect(joined).not.toMatch(/aws s3 sync/);
  });
});

describe("shQuote — shell-injection hardening", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shQuote("s3://b/k.png")).toBe(`'s3://b/k.png'`);
  });
  it("neutralizes command substitution and metachars by single-quoting", () => {
    const raw = "k$(rm -rf /)`whoami`;.png";
    // no single quote in raw → the whole thing is wrapped verbatim in single
    // quotes, so $(), backticks and ; are all inert to a POSIX shell.
    expect(shQuote(raw)).toBe(`'${raw}'`);
  });
  it("escapes an embedded single quote so it cannot terminate the quote", () => {
    // key with a quote → close, escaped-quote, reopen: '...'\''...'
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });
  it("a crafted key stays fully quoted in the generated cp line", () => {
    const lines = buildManifestLines(
      [{ id: "x", key: "e';touch pwned;'.png", src: "http://x/e.png" }] as never[],
      new Set(), "src", "tgt", "files/", true
    );
    const cpLine = lines.find((l) => l.startsWith("aws s3 cp"))!;
    // the injected `;touch pwned;` is inside single quotes, not a bare command
    expect(cpLine).not.toMatch(/;touch pwned;(?!')/);
    expect(cpLine).toContain(`'\\''`);
  });
});
