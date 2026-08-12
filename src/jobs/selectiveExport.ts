/**
 * Build package CLI args for a dependency-ordered selective export
 * (shared by migrate staging and Export-selected).
 */

import type { ArtifactType } from "../shared/catalog";
import type { MigrationPlan, MigrationStep } from "../shared/plan";
import type { ArtifactPkg } from "./runArtifact";

export interface SelectiveExportStep {
  type: ArtifactType;
  pkg: ArtifactPkg;
  /** Relative subdir under the export base. */
  subDir: string;
  label: string;
  ids: string[];
  /** Full argv for the artifact CLI (no binary prefix). */
  args: string[];
}

export interface SelectiveExportOpts {
  schemaFile?: string;
  withBinaries?: boolean;
  maxFileSize?: string;
  /** When exporting cms-entry, narrow --models to these modelIds (from the plan). */
  modelIdsForEntries?: string[];
}

/**
 * Turn a hydrated MigrationPlan into ordered export steps with --select where supported.
 * Args may contain the placeholder `__IDS_FILE__` — replace via `bindSelectiveExportIds`.
 */
export function buildSelectiveExportSteps(
  plan: MigrationPlan,
  outBase: string,
  opts: SelectiveExportOpts = {}
): SelectiveExportStep[] {
  const byType = new Map(plan.steps.map((s) => [s.type, s.ids] as const));
  const modelIds = byType.get("model") ?? opts.modelIdsForEntries ?? [];
  const out: SelectiveExportStep[] = [];

  if ((byType.get("model") ?? []).length) {
    const ids = byType.get("model")!;
    out.push({
      type: "model",
      pkg: "cms-entries",
      subDir: "cms",
      label: `Export models (${ids.length})`,
      ids,
      args: ["export-models", "--out", `${outBase}/cms`, "--models", ids.join(",")],
    });
  }

  const files = byType.get("file") ?? [];
  if (files.length) {
    out.push({
      type: "file",
      pkg: "file-manager",
      subDir: "files",
      label: `Export files (${files.length})`,
      ids: files,
      args: [
        "export",
        "--out",
        `${outBase}/files`,
        "--select",
        "__IDS_FILE__",
        ...(opts.withBinaries ? ["--with-binaries"] : []),
        ...(opts.maxFileSize ? ["--max-file-size", opts.maxFileSize] : []),
      ],
    });
  }

  const entries = byType.get("cms-entry") ?? [];
  if (entries.length) {
    const modelArgs =
      modelIds.length > 0
        ? ["--models", modelIds.join(",")]
        : opts.schemaFile
          ? ["--schema-file", opts.schemaFile]
          : [];
    out.push({
      type: "cms-entry",
      pkg: "cms-entries",
      subDir: "cms",
      label: `Export entries (${entries.length})`,
      ids: entries,
      args: [
        "export",
        "--out",
        `${outBase}/cms`,
        "--select",
        "__IDS_FILE__",
        ...modelArgs,
      ],
    });
  }

  const pages = byType.get("page") ?? [];
  if (pages.length) {
    out.push({
      type: "page",
      pkg: "page-builder",
      subDir: "pages",
      label: `Export pages (${pages.length})`,
      ids: pages,
      args: ["export", "--out", `${outBase}/pages`, "--select", "__IDS_FILE__"],
    });
  }

  const redirects = byType.get("redirect") ?? [];
  if (redirects.length) {
    out.push({
      type: "redirect",
      pkg: "redirects",
      subDir: "redirects",
      label: `Export redirects (${redirects.length})`,
      ids: redirects,
      args: ["export", "--out", `${outBase}/redirects`, "--select", "__IDS_FILE__"],
    });
  }

  return out;
}

/** Single-type step used by migrate staging (one artifact type per loop iteration). */
export function selectiveExportStepFor(
  type: ArtifactType,
  ids: string[],
  outBase: string,
  opts: SelectiveExportOpts = {}
): SelectiveExportStep | undefined {
  const steps: MigrationStep[] = [];
  if (type === "model") {
    steps.push({ type: "model", ids });
  } else {
    if (type === "cms-entry" && opts.modelIdsForEntries?.length) {
      steps.push({ type: "model", ids: opts.modelIdsForEntries });
    }
    steps.push({ type, ids });
  }
  const plan: MigrationPlan = {
    steps,
    selectedCount: ids.length,
    resolvedCount: ids.length,
    addedByDependencies: [],
    unknownIds: [],
  };
  return buildSelectiveExportSteps(plan, outBase, opts).find((s) => s.type === type);
}

/** Replace `__IDS_FILE__` with `@path` for each step that needs a select file. */
export function bindSelectiveExportIds(
  steps: SelectiveExportStep[],
  idsPathFor: (type: ArtifactType) => string
): SelectiveExportStep[] {
  return steps.map((s) => ({
    ...s,
    args: s.args.map((a) => (a === "__IDS_FILE__" ? `@${idsPathFor(s.type)}` : a)),
  }));
}

/** Strip intentionally omitted deps from a planned id list (Import / Export omit). */
export function stripOmittedIds(ids: Iterable<string>, omitIds: Iterable<string>): string[] {
  const omit = new Set([...omitIds].map(String));
  return [...ids].filter((id) => !omit.has(id));
}
