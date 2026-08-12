/**
 * CMS models vs entries orchestration helpers for the root CLI.
 * Keeps export-all / import-all skip + parts semantics in one place.
 */

import fs from "fs";
import path from "path";
import type { RunStatus } from "./runstore";

export const MODELS_JSON_FILENAME = "models.json";

/** Parse a comma-separated --skip string into a Set. */
export function parseSkipSet(skip: string): Set<string> {
  return new Set(skip.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Resolve whether Content Models and/or Content Entries should run.
 * --skip cms-models / cms-entries are independent; --cms-parts filters further.
 */
export function resolveCmsParts(
  skip: Iterable<string>,
  cmsParts = "both"
): { wantModels: boolean; wantEntries: boolean } {
  const skipSet = skip instanceof Set ? skip : new Set([...skip].map(String));
  const partsRaw = (cmsParts || "both").toLowerCase().replace(/\s+/g, "");
  const partsWantModels =
    partsRaw === "both" || partsRaw === "models" || /(^|,)models(,|$)/.test(partsRaw);
  const partsWantEntries =
    partsRaw === "both" || partsRaw === "entries" || /(^|,)entries(,|$)/.test(partsRaw);
  return {
    wantModels: !skipSet.has("cms-models") && partsWantModels,
    wantEntries: !skipSet.has("cms-entries") && partsWantEntries,
  };
}

/** True when directory listing includes entry manifests (not just models.json). */
export function namesIndicateCmsEntries(names: string[]): boolean {
  return names.some(
    (n) => n.endsWith(".entries.ndjson") || (n.endsWith(".json") && n !== MODELS_JSON_FILENAME)
  );
}

/** True when cms/ has entry manifests (not just models.json). */
export function cmsDirHasEntries(cmsDir: string): boolean {
  if (!fs.existsSync(cmsDir)) return false;
  return namesIndicateCmsEntries(fs.readdirSync(cmsDir));
}

export function cmsDirHasModelsJson(cmsDir: string): boolean {
  return fs.existsSync(path.join(cmsDir, MODELS_JSON_FILENAME));
}

export type CmsImportStepKind = "models" | "entries";

/**
 * Ordered CMS import steps for import-all, given skip/parts intent and what is on disk.
 * Models-only exports run import-models; entry import is skipped when there are no manifests.
 */
export function planImportAllCmsSteps(opts: {
  wantModels: boolean;
  wantEntries: boolean;
  hasModelsJson: boolean;
  hasEntryManifests: boolean;
}): CmsImportStepKind[] {
  const steps: CmsImportStepKind[] = [];
  if (opts.wantModels && opts.hasModelsJson) steps.push("models");
  if (opts.wantEntries && opts.hasEntryManifests) steps.push("entries");
  return steps;
}

/** Delete auto-managed migrate staging only on a fully successful run. */
export function shouldDeleteMigrateStaging(opts: {
  autoStaging: boolean;
  status: RunStatus;
  aborted: boolean;
}): boolean {
  return opts.autoStaging && opts.status === "complete" && !opts.aborted;
}

/** Run-scoped dir under .migrate-tmp for staging + ephemeral ids/results. */
export function migrateWorkDir(migrateTmpRoot: string, runId: string): string {
  return path.join(migrateTmpRoot, runId);
}
