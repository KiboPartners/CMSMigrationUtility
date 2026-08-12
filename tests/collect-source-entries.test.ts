// tests/collect-source-entries.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { readExportManifest, collectSourceEntries } from "../src/artifacts/cms-entries/clone";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "collect-entries-")); }
const schema = { modelId: "m", name: "M", pluralApiName: "Ms", fields: [], listOperation: "listMs", createOperation: "createM", updateOperation: "updateM", publishOperation: "publishM", deleteOperation: "deleteM", whereInputType: "MWhere" };

describe("collectSourceEntries", () => {
  it("streams the ndjson sidecar and returns all entries (sidecar case)", async () => {
    dir = tmp();
    fs.writeFileSync(path.join(dir, "M.json"), JSON.stringify({ modelName: "M", schema, folderType: "m", folders: [], count: 2 }));
    fs.writeFileSync(path.join(dir, "M.entries.ndjson"), '{"entryId":"a"}\n{"entryId":"b"}\n');

    const sources = readExportManifest(dir);
    expect(sources).toHaveLength(1);

    const entries = await collectSourceEntries(sources[0]);
    expect(entries).toEqual([{ entryId: "a" }, { entryId: "b" }]);
  });

  it("returns the legacy inline entries array when no sidecar exists", async () => {
    dir = tmp();
    fs.writeFileSync(
      path.join(dir, "Legacy.json"),
      JSON.stringify({ modelName: "Legacy", schema, folderType: "m", folders: [], entries: [{ entryId: "x" }, { entryId: "y" }] })
    );

    const sources = readExportManifest(dir);
    expect(sources).toHaveLength(1);

    const entries = await collectSourceEntries(sources[0]);
    expect(entries).toEqual([{ entryId: "x" }, { entryId: "y" }]);
  });
});
