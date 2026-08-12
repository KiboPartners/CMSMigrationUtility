import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  filterCmsStructure,
  writeModelsExport,
  readModelsExport,
  MODELS_EXPORT_FILENAME,
} from "../src/artifacts/cms-entries/structure";
import {
  buildImportCatalog,
  planImportSelection,
  listExportArtifactLabels,
  packagesInExport,
} from "../server";

describe("models.json structure helpers", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-models-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("filterCmsStructure matches modelId or name", () => {
    const structure = {
      groups: [{ id: "g1" }],
      models: [
        { modelId: "heroBanner", name: "Hero Banner", fields: [1, 2] },
        { modelId: "modal", name: "Modal", fields: [] },
      ],
    };
    expect(filterCmsStructure(structure, []).models).toHaveLength(2);
    expect(filterCmsStructure(structure, ["heroBanner"]).models.map((m) => (m as { modelId: string }).modelId)).toEqual([
      "heroBanner",
    ]);
    expect(filterCmsStructure(structure, ["Modal"]).models.map((m) => (m as { modelId: string }).modelId)).toEqual([
      "modal",
    ]);
  });

  it("writeModelsExport / readModelsExport round-trip", () => {
    const structure = {
      groups: [{ name: "Content" }],
      models: [{ modelId: "m1", name: "M1", fields: [{ fieldId: "t" }] }],
    };
    const file = writeModelsExport(tmp, structure, { sourceTenant: "1000502" });
    expect(path.basename(file)).toBe(MODELS_EXPORT_FILENAME);
    const read = readModelsExport(tmp);
    expect(read).not.toBeNull();
    expect(read!.sourceTenant).toBe("1000502");
    expect(read!.models).toHaveLength(1);
    expect(read!.groups).toHaveLength(1);
    expect(read!.exportedAt).toBeTruthy();
  });
});

describe("buildImportCatalog prefers models.json", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-imp-cat-"));
    const cms = path.join(tmp, "cms");
    fs.mkdirSync(cms, { recursive: true });
    fs.writeFileSync(
      path.join(cms, "models.json"),
      JSON.stringify({
        exportedAt: "2026-01-01T00:00:00.000Z",
        groups: [],
        models: [
          { modelId: "heroBanner", name: "Hero Banner", fields: [{ fieldId: "a" }, { fieldId: "b" }] },
          { modelId: "soloModel", name: "Solo", fields: [] },
        ],
      }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(cms, "Hero Banner.json"),
      JSON.stringify({
        modelId: "heroBanner",
        modelName: "Hero Banner",
        count: 1,
        schema: { fields: [{ fieldId: "image", type: "file" }] },
      }),
      "utf-8"
    );
    const fileUrl = "https://cdn.example.com/files/x.png";
    fs.writeFileSync(
      path.join(cms, "Hero Banner.entries.ndjson"),
      JSON.stringify({ entryId: "e1", title: "One", image: fileUrl }) + "\n",
      "utf-8"
    );
    const filesDir = path.join(tmp, "files");
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(
      path.join(filesDir, "files.json"),
      JSON.stringify({ files: [{ src: fileUrl, key: "x.png", size: 10 }] }),
      "utf-8"
    );
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("model section comes from models.json including models with no entries", async () => {
    const cat = await buildImportCatalog(tmp);
    const models = cat.sections.find((s) => s.type === "model")!;
    expect(models.items.map((i) => i.id).sort()).toEqual(["heroBanner", "soloModel"]);
    expect(models.items.find((i) => i.id === "soloModel")?.label).toBe("Solo");
    expect(models.items.find((i) => i.id === "heroBanner")?.metadata?.fields).toBe(2);
  });

  it("models-only selection still works; entry selection still pulls model+file", async () => {
    expect(await planImportSelection(tmp, ["soloModel"])).toEqual({
      mode: "models-only",
      modelIds: ["soloModel"],
    });
    const plan = await planImportSelection(tmp, ["e1"]);
    expect(plan.mode).toBe("items");
    if (plan.mode !== "items") return;
    expect(plan.ids).toContain("heroBanner");
    expect(plan.ids).toContain("e1");
    expect(plan.ids).toContain("https://cdn.example.com/files/x.png");
  });

  it("export pills list Content Models separately from Content Entries", () => {
    expect(listExportArtifactLabels(tmp)).toEqual([
      "Files",
      "Content Models",
      "Content Entries",
    ]);
    expect(packagesInExport(tmp)).toEqual(["file-manager", "cms-entries"]);
  });
});
