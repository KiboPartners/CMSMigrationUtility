import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { expandImportSelection, planImportSelection, buildImportCatalog } from "../server";

describe("planImportSelection / expandImportSelection", () => {
  let tmp: string;
  const fileUrl = "https://cdn.example.com/files/hero.png";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-imp-sel-"));
    const cms = path.join(tmp, "cms");
    fs.mkdirSync(cms, { recursive: true });
    fs.writeFileSync(
      path.join(cms, "Hero Banner.json"),
      JSON.stringify({
        modelId: "heroBanner",
        modelName: "Hero Banner",
        count: 2,
        schema: {
          fields: [
            { fieldId: "title", type: "text" },
            { fieldId: "image", type: "file" },
            { fieldId: "related", type: "ref" },
          ],
        },
      }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(cms, "Hero Banner.entries.ndjson"),
      [
        JSON.stringify({
          entryId: "e1",
          title: "One",
          image: fileUrl,
          related: { modelId: "heroBanner", entryId: "e2", id: "e2" },
        }),
        JSON.stringify({ entryId: "e2", title: "Two" }),
      ].join("\n") + "\n",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(cms, "Modal.json"),
      JSON.stringify({ modelId: "modal", modelName: "Modal", count: 0, schema: { fields: [] } }),
      "utf-8"
    );
    const filesDir = path.join(tmp, "files");
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(
      path.join(filesDir, "files.json"),
      JSON.stringify({ files: [{ src: fileUrl, key: "hero.png", size: 100 }] }),
      "utf-8"
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("empty selection → import all", async () => {
    expect(await planImportSelection(tmp, [])).toEqual({ mode: "all" });
  });

  it("only model ids → models-only (no entry expansion)", async () => {
    expect(await planImportSelection(tmp, ["heroBanner", "modal"])).toEqual({
      mode: "models-only",
      modelIds: ["heroBanner", "modal"],
    });
  });

  it("entry selection pulls model + file + ref deps (Migrate-style)", async () => {
    const plan = await planImportSelection(tmp, ["e1"]);
    expect(plan.mode).toBe("items");
    if (plan.mode !== "items") return;
    expect(plan.ids.sort()).toEqual(["e1", "e2", "heroBanner", fileUrl].sort());
    expect(plan.addedByDependencies.sort()).toEqual(["e2", "heroBanner", fileUrl].sort());
    expect(plan.packages).toEqual(["file-manager", "cms-entries"]);
  });

  it("model + page does not expand model to all entries", async () => {
    const plan = await planImportSelection(tmp, ["heroBanner", "page-abc"]);
    expect(plan.mode).toBe("items");
    if (plan.mode !== "items") return;
    // page-abc is unknown → reported in planMigration unknownIds but still not e1/e2
    expect(plan.ids).toContain("heroBanner");
    expect(plan.ids).not.toContain("e1");
    expect(plan.ids).not.toContain("e2");
  });

  it("buildImportCatalog attaches dependsOn on entries", async () => {
    const cat = await buildImportCatalog(tmp);
    const e1 = cat.sections.find((s) => s.type === "cms-entry")?.items.find((i) => i.id === "e1");
    expect(e1?.dependsOn).toEqual(expect.arrayContaining(["heroBanner", fileUrl, "e2"]));
  });

  it("expandImportSelection still expands modelId to entry ids", async () => {
    const ids = await expandImportSelection(tmp, ["heroBanner"]);
    expect(ids.sort()).toEqual(["e1", "e2"]);
  });
});
