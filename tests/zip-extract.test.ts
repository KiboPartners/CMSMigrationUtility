import { describe, it, expect } from "vitest";
import path from "path";
import { safeZipEntryPath } from "../server";

const dest = path.resolve("/tmp/extract");

describe("safeZipEntryPath", () => {
  it("accepts a normal entry", () => {
    expect(safeZipEntryPath(dest, "files/files.json")).toBe(path.join(dest, "files/files.json"));
  });
  it("rejects a parent-escaping entry", () => {
    expect(safeZipEntryPath(dest, "../../etc/passwd")).toBeNull();
  });
  it("rejects an absolute entry", () => {
    expect(safeZipEntryPath(dest, "/etc/passwd")).toBeNull();
  });
});
