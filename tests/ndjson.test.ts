import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { encodeLine, parseLine, readNdjsonLines } from "../src/shared/ndjson";

describe("ndjson pure (encode/parse)", () => {
  it("encodeLine appends exactly one newline and no raw newline inside", () => {
    const s = encodeLine({ a: 1, note: "line1\nline2" });
    expect(s.endsWith("\n")).toBe(true);
    expect(s.slice(0, -1).includes("\n")).toBe(false); // inner newline escaped by JSON
    expect(JSON.parse(s)).toEqual({ a: 1, note: "line1\nline2" });
  });

  it("round-trips unicode", () => {
    const obj = { title: "Café — 日本語 — 😀" };
    expect(parseLine(encodeLine(obj))).toEqual(obj);
  });

  it("escapes U+2028 / U+2029 so one record stays one physical \\n line", () => {
    const obj = { title: "Trusted\u2028Brands", note: "a\u2029b" };
    const s = encodeLine(obj);
    expect(s.slice(0, -1).includes("\u2028")).toBe(false);
    expect(s.slice(0, -1).includes("\u2029")).toBe(false);
    expect(s.includes("\\u2028")).toBe(true);
    expect(s.includes("\\u2029")).toBe(true);
    expect(parseLine(s)).toEqual(obj);
  });

  it("parseLine returns undefined for blank/whitespace lines", () => {
    expect(parseLine("")).toBeUndefined();
    expect(parseLine("   ")).toBeUndefined();
    expect(parseLine("\t")).toBeUndefined();
  });

  it("parseLine parses a normal record", () => {
    expect(parseLine('{"x":true}')).toEqual({ x: true });
  });
});

describe("readNdjsonLines", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-ndjson-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads records that contain literal U+2028 (legacy exports / Node readline trap)", async () => {
    // Simulate a file written before we escaped LS — valid JSON, broken under readline.
    const file = path.join(tmp, "x.ndjson");
    fs.writeFileSync(file, `{"title":"Trusted\u2028Brands","entryId":"e1"}\n`, "utf-8");
    const items: Array<Record<string, unknown>> = [];
    const n = await readNdjsonLines(file, (o) => {
      items.push(o);
    });
    expect(n).toBe(1);
    expect(items[0]).toEqual({ title: "Trusted\u2028Brands", entryId: "e1" });
  });
});
