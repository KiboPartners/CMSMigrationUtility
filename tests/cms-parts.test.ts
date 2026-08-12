import { describe, it, expect } from "vitest";
import {
  resolveCmsParts,
  parseSkipSet,
  namesIndicateCmsEntries,
  planImportAllCmsSteps,
  shouldDeleteMigrateStaging,
  migrateWorkDir,
  MODELS_JSON_FILENAME,
} from "../src/shared/cms-parts";

describe("resolveCmsParts", () => {
  const cases: Array<{
    name: string;
    skip: string;
    cmsParts?: string;
    wantModels: boolean;
    wantEntries: boolean;
  }> = [
    { name: "default both", skip: "", wantModels: true, wantEntries: true },
    { name: "skip cms-models", skip: "cms-models", wantModels: false, wantEntries: true },
    { name: "skip cms-entries only", skip: "cms-entries", wantModels: true, wantEntries: false },
    {
      name: "skip both cms parts",
      skip: "cms-models,cms-entries",
      wantModels: false,
      wantEntries: false,
    },
    {
      name: "cms-parts entries",
      skip: "",
      cmsParts: "entries",
      wantModels: false,
      wantEntries: true,
    },
    {
      name: "cms-parts models",
      skip: "",
      cmsParts: "models",
      wantModels: true,
      wantEntries: false,
    },
    {
      name: "skip cms-models + cms-parts both",
      skip: "cms-models",
      cmsParts: "both",
      wantModels: false,
      wantEntries: true,
    },
    {
      name: "skip unrelated package",
      skip: "file-manager,redirects",
      wantModels: true,
      wantEntries: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const r = resolveCmsParts(parseSkipSet(c.skip), c.cmsParts ?? "both");
      expect(r).toEqual({ wantModels: c.wantModels, wantEntries: c.wantEntries });
    });
  }
});

describe("namesIndicateCmsEntries", () => {
  it("ignores models.json alone", () => {
    expect(namesIndicateCmsEntries([MODELS_JSON_FILENAME])).toBe(false);
  });
  it("detects per-model json and ndjson", () => {
    expect(namesIndicateCmsEntries([MODELS_JSON_FILENAME, "Blog.json"])).toBe(true);
    expect(namesIndicateCmsEntries(["Blog.entries.ndjson"])).toBe(true);
  });
});

describe("planImportAllCmsSteps", () => {
  it("runs models then entries when both present", () => {
    expect(
      planImportAllCmsSteps({
        wantModels: true,
        wantEntries: true,
        hasModelsJson: true,
        hasEntryManifests: true,
      })
    ).toEqual(["models", "entries"]);
  });

  it("models-only export → import-models only", () => {
    expect(
      planImportAllCmsSteps({
        wantModels: true,
        wantEntries: true,
        hasModelsJson: true,
        hasEntryManifests: false,
      })
    ).toEqual(["models"]);
  });

  it("legacy entries without models.json → entries only", () => {
    expect(
      planImportAllCmsSteps({
        wantModels: true,
        wantEntries: true,
        hasModelsJson: false,
        hasEntryManifests: true,
      })
    ).toEqual(["entries"]);
  });

  it("skip models → entries only", () => {
    expect(
      planImportAllCmsSteps({
        wantModels: false,
        wantEntries: true,
        hasModelsJson: true,
        hasEntryManifests: true,
      })
    ).toEqual(["entries"]);
  });

  it("nothing on disk → empty", () => {
    expect(
      planImportAllCmsSteps({
        wantModels: true,
        wantEntries: true,
        hasModelsJson: false,
        hasEntryManifests: false,
      })
    ).toEqual([]);
  });
});

describe("shouldDeleteMigrateStaging", () => {
  it("deletes only auto-staging on complete success", () => {
    expect(
      shouldDeleteMigrateStaging({ autoStaging: true, status: "complete", aborted: false })
    ).toBe(true);
  });

  it("keeps on failed / aborted / custom --in", () => {
    expect(
      shouldDeleteMigrateStaging({ autoStaging: true, status: "failed", aborted: false })
    ).toBe(false);
    expect(
      shouldDeleteMigrateStaging({ autoStaging: true, status: "complete", aborted: true })
    ).toBe(false);
    expect(
      shouldDeleteMigrateStaging({ autoStaging: true, status: "in-progress", aborted: false })
    ).toBe(false);
    expect(
      shouldDeleteMigrateStaging({ autoStaging: false, status: "complete", aborted: false })
    ).toBe(false);
  });
});

describe("migrateWorkDir", () => {
  it("nests under migrate-tmp by run id", () => {
    expect(migrateWorkDir("/repo/.migrate-tmp", "run-1")).toMatch(/[/\\]run-1$/);
  });
});
