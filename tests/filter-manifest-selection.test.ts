import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { filterManifestForSelection, readExportManifest, buildModelsFromManifest } from "../src/artifacts/cms-entries/clone";

describe("filterManifestForSelection", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-filt-"));
    const schema = (modelId: string, name: string) => ({
      modelId,
      name,
      pluralApiName: name,
      fields: [{ fieldId: "title", type: "text" }],
      listOperation: `list${name}`,
      getOperation: `get${name}`,
      createOperation: `create${name}`,
      updateOperation: `update${name}`,
      publishOperation: `publish${name}`,
    });
    for (const [file, modelId, name, entries] of [
      ["Hero Banner.json", "heroBanner", "Hero Banner", ["e1", "e2"]],
      ["Modal.json", "modal", "Modal", ["m1"]],
      ["Tooltip.json", "tooltip", "Tooltip", ["t1"]],
    ] as const) {
      fs.writeFileSync(
        path.join(tmp, file),
        JSON.stringify({ modelId, modelName: name, schema: schema(modelId, name.replace(/\s/g, "")), count: entries.length }),
        "utf-8"
      );
      fs.writeFileSync(
        path.join(tmp, `${name}.entries.ndjson`),
        entries.map((id) => JSON.stringify({ entryId: id, title: id })).join("\n") + "\n",
        "utf-8"
      );
    }
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps only the model named by modelId in selection", async () => {
    const sources = readExportManifest(tmp);
    const models = buildModelsFromManifest(sources);
    const out = await filterManifestForSelection(sources, models, new Set(["heroBanner"]));
    expect([...out.models.keys()]).toEqual(["Hero Banner"]);
    expect(out.sources.map((s) => s.modelName)).toEqual(["Hero Banner"]);
  });

  it("keeps model that owns a selected entryId (no modelId in set)", async () => {
    const sources = readExportManifest(tmp);
    const models = buildModelsFromManifest(sources);
    const out = await filterManifestForSelection(sources, models, new Set(["m1"]));
    expect([...out.models.keys()]).toEqual(["Modal"]);
  });

  it("does not pull unrelated models when selecting one entry + its model", async () => {
    const sources = readExportManifest(tmp);
    const models = buildModelsFromManifest(sources);
    const out = await filterManifestForSelection(sources, models, new Set(["e1", "heroBanner", "https://cdn.example/files/x.png"]));
    expect([...out.models.keys()].sort()).toEqual(["Hero Banner"]);
  });

  it("returns empty when selection has no cms ids", async () => {
    const sources = readExportManifest(tmp);
    const models = buildModelsFromManifest(sources);
    const out = await filterManifestForSelection(sources, models, new Set(["page-abc", "https://cdn.example/files/x.png"]));
    expect(out.models.size).toBe(0);
    expect(out.sources.length).toBe(0);
  });
});
