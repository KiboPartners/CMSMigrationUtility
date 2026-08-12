import { describe, expect, it } from "vitest";
import {
  buildSelectiveExportSteps,
  bindSelectiveExportIds,
  selectiveExportStepFor,
  stripOmittedIds,
} from "../src/jobs/selectiveExport";
import type { MigrationPlan } from "../src/shared/plan";

const plan: MigrationPlan = {
  steps: [
    { type: "model", ids: ["promoBanner"] },
    { type: "file", ids: ["https://cdn.example/files/a/original/x.png"] },
    { type: "cms-entry", ids: ["entry-1"] },
    { type: "page", ids: ["/home"] },
    { type: "redirect", ids: ["/old"] },
  ],
  selectedCount: 1,
  resolvedCount: 5,
  addedByDependencies: ["promoBanner", "https://cdn.example/files/a/original/x.png"],
  unknownIds: [],
};

describe("buildSelectiveExportSteps", () => {
  it("builds ordered package args with --select placeholders", () => {
    const steps = buildSelectiveExportSteps(plan, "/tmp/exp", { withBinaries: true, maxFileSize: "10" });
    expect(steps.map((s) => s.type)).toEqual(["model", "file", "cms-entry", "page", "redirect"]);

    const models = steps.find((s) => s.type === "model")!;
    expect(models.args).toEqual(["export-models", "--out", "/tmp/exp/cms", "--models", "promoBanner"]);

    const files = steps.find((s) => s.type === "file")!;
    expect(files.args).toContain("--select");
    expect(files.args).toContain("__IDS_FILE__");
    expect(files.args).toContain("--with-binaries");
    expect(files.args).toContain("10");

    const entries = steps.find((s) => s.type === "cms-entry")!;
    expect(entries.args).toContain("--select");
    expect(entries.args).toContain("--models");
    expect(entries.args).toContain("promoBanner");

    const pages = steps.find((s) => s.type === "page")!;
    expect(pages.args.slice(0, 4)).toEqual(["export", "--out", "/tmp/exp/pages", "--select"]);

    const redirs = steps.find((s) => s.type === "redirect")!;
    expect(redirs.args).toContain("--select");
  });

  it("bindSelectiveExportIds replaces the placeholder", () => {
    const bound = bindSelectiveExportIds(
      buildSelectiveExportSteps(plan, "/tmp/exp"),
      (t) => `/tmp/ids/${t}.ids`
    );
    for (const s of bound) {
      if (s.type === "model") continue;
      expect(s.args).toContain(`@/tmp/ids/${s.type}.ids`);
      expect(s.args).not.toContain("__IDS_FILE__");
    }
  });
});

describe("selectiveExportStepFor", () => {
  it("passes modelIds into cms-entry --models without emitting a model step", () => {
    const step = selectiveExportStepFor("cms-entry", ["e1"], "/out", {
      modelIdsForEntries: ["m1", "m2"],
    });
    expect(step?.type).toBe("cms-entry");
    expect(step?.args).toContain("--models");
    expect(step?.args).toContain("m1,m2");
    expect(step?.args[0]).toBe("export");
  });
});

describe("stripOmittedIds", () => {
  it("removes omitted deps from a planned import id list", () => {
    const ids = ["page-1", "https://cdn/x.png", "modelA"];
    expect(stripOmittedIds(ids, ["https://cdn/x.png"])).toEqual(["page-1", "modelA"]);
    expect(stripOmittedIds(ids, [])).toEqual(ids);
  });
});
