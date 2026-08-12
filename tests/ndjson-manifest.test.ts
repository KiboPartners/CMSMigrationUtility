// tests/ndjson-manifest.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { readExportManifest } from "../src/artifacts/cms-entries/clone";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-")); }
const schema = { modelId: "m", name: "M", pluralApiName: "Ms", fields: [], listOperation: "listMs", createOperation: "createM", updateOperation: "updateM", publishOperation: "publishM", deleteOperation: "deleteM", whereInputType: "MWhere" };

describe("readExportManifest", () => {
  it("detects the ndjson sidecar and sets ndjsonPath (no entries loaded)", () => {
    dir = tmp();
    fs.writeFileSync(path.join(dir, "M.json"), JSON.stringify({ modelName: "M", schema, folderType: "m", folders: [], count: 2 }));
    fs.writeFileSync(path.join(dir, "M.entries.ndjson"), '{"entryId":"a"}\n{"entryId":"b"}\n');
    const out = readExportManifest(dir);
    expect(out).toHaveLength(1);
    expect(out[0].modelName).toBe("M");
    expect(out[0].ndjsonPath).toBe(path.join(dir, "M.entries.ndjson"));
    expect(out[0].legacyEntries).toBeNull();
  });

  it("falls back to legacy inline entries when no sidecar", () => {
    dir = tmp();
    fs.writeFileSync(path.join(dir, "Legacy.json"), JSON.stringify({ modelName: "Legacy", schema, folderType: "m", folders: [], entries: [{ entryId: "x" }] }));
    const out = readExportManifest(dir);
    expect(out).toHaveLength(1);
    expect(out[0].ndjsonPath).toBeNull();
    expect(out[0].legacyEntries).toEqual([{ entryId: "x" }]);
  });

  it("ignores a metadata .json whose .entries.ndjson sibling is the item file (no double count)", () => {
    dir = tmp();
    fs.writeFileSync(path.join(dir, "M.json"), JSON.stringify({ modelName: "M", schema, folders: [], count: 0 }));
    fs.writeFileSync(path.join(dir, "M.entries.ndjson"), "");
    const out = readExportManifest(dir);
    expect(out).toHaveLength(1); // only M, the .ndjson is not read as its own model
  });
});
