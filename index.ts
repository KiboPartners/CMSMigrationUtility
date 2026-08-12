/**
 * Kibo CMS Clone Tool — Root Orchestrator
 *
 * Runs all four packages in the correct dependency order for a full
 * export or import in one command.
 *
 * Export everything from source:
 *   npx ts-node index.ts export-all --schema-file ./cms-schema.json
 *   npx ts-node index.ts export-all --schema-file ./cms-schema.json --out ./export
 *
 * Import everything to target:
 *   npx ts-node index.ts import-all --dry-run
 *   npx ts-node index.ts import-all
 *
 * Skip specific packages:
 *   npx ts-node index.ts export-all --schema-file ./cms-schema.json --skip file-manager
 *   npx ts-node index.ts import-all --skip cms-entries,page-builder
 *
 * Order:
 *   file-manager first (files must exist before Content Entries/pages reference them)
 *   cms-entries → page-builder → redirects (no strict dependency between these three)
 *
 * Configuration is consolidated: all artifacts read a single repo-root .env
 * (see .env.example).
 */

import fs from "fs";
import { Command } from "commander";
import path from "path";
import {
  loadRootEnv, buildCatalog, Catalog, CatalogSection, planMigration, parseSelection,
  createRun, createEmptyRun, createRunFromItems, saveRun, loadRunWithFallback, listRuns,
  pendingItems, applyResults, runSummary, readResultFile, synthesizePurgeResults,
  workstreamLedgerDirs, readNdjsonLines,
  MigrationRun, ItemResult, ArtifactType, TYPE_ORDER, assertPurgeTargetSafe, purgeWarning,
  emitEvent, computeMetrics, aggregateMetrics, groupPurgeSelection,
  parseSkipSet, resolveCmsParts, planImportAllCmsSteps, cmsDirHasEntries, cmsDirHasModelsJson,
  shouldDeleteMigrateStaging, migrateWorkDir,
  parseFilterCliOption, writeFilterSpec, saveCapsCache, capsCacheKey, DEFAULT_WHERE_CAPS,
  hydrateDependencies, catalogOmittingDeps, shouldAbortForUnresolvedDeps, formatUnresolvedDepsMessage,
  createClient, resolveEnvironment, getLocale, getRateLimitDelay, getDebug,
} from "@kibo-cms-clone-tool/shared";
import { startServer } from "./server";
import { runArtifact, ArtifactPkg } from "./src/jobs/runArtifact";
import {
  buildSelectiveExportSteps,
  bindSelectiveExportIds,
  selectiveExportStepFor,
} from "./src/jobs/selectiveExport";
import { openCliWorkstream, defaultLogsRoot, inheritedRunId, Workstream } from "./src/jobs/logstore";
import { fetchFileByDepId } from "./src/artifacts/file-manager/fetch-file";
import { fetchModelById } from "./src/artifacts/cms-entries/fetch-model";

const DEFAULT_MIGRATE_RUNS_DIR = path.join(".logs", "migrate");
const LEGACY_RUNS_DIR = ".runs";

const PKG_FOR_TYPE: Record<string, ArtifactPkg> = {
  file: "file-manager",
  "cms-entry": "cms-entries",
  page: "page-builder",
  redirect: "redirects",
};

// Consolidated config: load the repo-root .env once; child packages inherit it
// via the spawned process env and resolve the same root .env themselves.
loadRootEnv();

const ROOT = __dirname;
const KEYMAP_DIR = path.join(ROOT, ".keymap");

// ─── Runner ───────────────────────────────────────────────────────────────────

// Wall-clock timing per spawned step — so a run reports WHERE its time went
// (export vs import, which artifact) before anyone tunes concurrency/throttle.
const STEP_TIMINGS: Array<{ label: string; ms: number; ok: boolean }> = [];

function reportTimings(title: string): void {
  if (STEP_TIMINGS.length === 0) return;
  const total = STEP_TIMINGS.reduce((n, s) => n + s.ms, 0);
  const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";
  console.log("\n" + "─".repeat(60));
  console.log(`  ⏱  ${title} — step timings`);
  for (const s of STEP_TIMINGS) {
    const pct = total ? Math.round((s.ms / total) * 100) : 0;
    console.log(`     ${(s.ok ? "✓" : "✗")} ${s.label.padEnd(34)} ${secs(s.ms).padStart(8)}  ${String(pct).padStart(3)}%`);
  }
  console.log(`     ${"".padEnd(34)} ${secs(total).padStart(10)}  total`);
  console.log("─".repeat(60) + "\n");
}

/**
 * Distill a captured stderr blob to the lines that explain a failure, so the run
 * ledger records the REAL error instead of a generic "import step failed". Prefers
 * lines that look like errors; falls back to the last few non-empty lines.
 */
function errorTail(stderr: string, maxLines = 6): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const flagged = lines.filter((l) =>
    /❌|⛔|error|failed|not found|already exists|exception|unauthor|forbidden|HTTP \d|validation/i.test(l)
  );
  return (flagged.length ? flagged : lines).slice(-maxLines).join(" | ");
}

/** Persist a failed step's full captured stderr next to the run ledger. Returns
 *  the log path, or null when there's nothing to write. */
function writeStepLog(runsDir: string, runId: string, label: string, output: string): string | null {
  if (!output.trim()) return null;
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const p = path.join(runDir, `${label}.log`);
  fs.writeFileSync(p, output, "utf-8");
  return p;
}

function resolveMigrateRunsDir(opt?: string): { runsDir: string; legacyDir: string } {
  const runsDir = opt && path.isAbsolute(opt)
    ? opt
    : path.join(ROOT, opt || DEFAULT_MIGRATE_RUNS_DIR);
  return { runsDir, legacyDir: path.join(ROOT, LEGACY_RUNS_DIR) };
}

function workstreamRunsDir(ws: Workstream): string {
  return path.join(defaultLogsRoot(ROOT), ws);
}

/** Primary ledger dir + fallbacks across all workstreams (and legacy `.runs/`). */
function resolveAllLedgerDirs(primaryOpt?: string): { primary: string; fallbacks: string[] } {
  const logsRoot = defaultLogsRoot(ROOT);
  const legacy = path.join(ROOT, LEGACY_RUNS_DIR);
  const all = workstreamLedgerDirs(logsRoot, [legacy]);
  const primary = primaryOpt && path.isAbsolute(primaryOpt)
    ? primaryOpt
    : path.join(ROOT, primaryOpt || DEFAULT_MIGRATE_RUNS_DIR);
  return { primary, fallbacks: all.filter((d) => path.resolve(d) !== path.resolve(primary)) };
}

function ledgerEnv(role: "source" | "target", tenant?: string): MigrationRun["environment"] {
  const fromEnv = role === "target" ? process.env["TARGET_TENANT"] : process.env["SOURCE_TENANT"];
  return {
    role,
    tenant: tenant || fromEnv || "root",
    locale: process.env["LOCALE"] || "en-US",
  };
}

function printLedgerSummary(run: MigrationRun, runsDir: string): void {
  const m = computeMetrics(run);
  console.log(`  Ledger ${run.id} — ${run.status}`);
  console.log(`  done ${m.byStatus.done} · skipped ${m.byStatus.skipped} · error ${m.byStatus.error} · pending ${m.byStatus.pending}`);
  console.log(`  ledger: ${path.relative(ROOT, path.join(runsDir, run.id))}/ledger.json`);
}

async function scanExportedFiles(dir: string): Promise<ItemResult[]> {
  const f = path.join(dir, "files.json");
  if (!fs.existsSync(f)) return [];
  const body = JSON.parse(fs.readFileSync(f, "utf-8")) as { files?: Array<{ src?: string; key?: string }> };
  return (body.files || [])
    .map((file) => ({
      type: "file" as const,
      id: file.src || file.key || "",
      status: "done" as const,
      action: "exported",
    }))
    .filter((i) => i.id);
}

async function scanExportedModels(dir: string): Promise<ItemResult[]> {
  const f = path.join(dir, "models.json");
  if (!fs.existsSync(f)) return [];
  const body = JSON.parse(fs.readFileSync(f, "utf-8")) as { models?: Array<{ modelId?: string; name?: string }> };
  return (body.models || [])
    .map((m) => ({
      type: "model" as const,
      id: String(m.modelId || m.name || ""),
      status: "done" as const,
      action: "exported",
    }))
    .filter((i) => i.id);
}

async function scanExportedEntries(dir: string): Promise<ItemResult[]> {
  const items: ItemResult[] = [];
  if (!fs.existsSync(dir)) return items;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".entries.ndjson")) {
      await readNdjsonLines(path.join(dir, name), (e) => {
        const id = String(e["entryId"] ?? String(e["id"] ?? "").split("#")[0] ?? "");
        if (id) items.push({ type: "cms-entry", id, status: "done", action: "exported" });
      });
      continue;
    }
    if (!name.endsWith(".json") || name === "models.json") continue;
    try {
      const body = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as {
        entries?: Array<Record<string, unknown>>;
      };
      if (!Array.isArray(body.entries)) continue;
      for (const e of body.entries) {
        const id = String(e["entryId"] ?? String(e["id"] ?? "").split("#")[0] ?? "");
        if (id) items.push({ type: "cms-entry", id, status: "done", action: "exported" });
      }
    } catch {
      /* skip non-manifest JSON */
    }
  }
  return items;
}

async function scanExportedPages(dir: string): Promise<ItemResult[]> {
  const items: ItemResult[] = [];
  const nd = path.join(dir, "pages.entries.ndjson");
  if (fs.existsSync(nd)) {
    await readNdjsonLines(nd, (p) => {
      const id = String(p["entryId"] ?? p["id"] ?? "");
      if (id) items.push({ type: "page", id, status: "done", action: "exported" });
    });
    return items;
  }
  const f = path.join(dir, "pages.json");
  if (!fs.existsSync(f)) return items;
  const body = JSON.parse(fs.readFileSync(f, "utf-8")) as { pages?: Array<Record<string, unknown>> };
  for (const p of body.pages || []) {
    const id = String(p["entryId"] ?? p["id"] ?? "");
    if (id) items.push({ type: "page", id, status: "done", action: "exported" });
  }
  return items;
}

async function scanExportedRedirects(dir: string): Promise<ItemResult[]> {
  const items: ItemResult[] = [];
  const nd = path.join(dir, "redirects.entries.ndjson");
  if (fs.existsSync(nd)) {
    await readNdjsonLines(nd, (r) => {
      const id = String(r["redirectFrom"] ?? "");
      if (id) items.push({ type: "redirect", id, status: "done", action: "exported" });
    });
    return items;
  }
  const f = path.join(dir, "redirects.json");
  if (!fs.existsSync(f)) return items;
  const body = JSON.parse(fs.readFileSync(f, "utf-8")) as { redirects?: Array<{ redirectFrom?: string }> };
  for (const r of body.redirects || []) {
    if (r.redirectFrom) items.push({ type: "redirect", id: r.redirectFrom, status: "done", action: "exported" });
  }
  return items;
}

export interface RunPackageResult {
  ok: boolean;
  /** Combined child stdout+stderr when `capture` is set (else ""). The packages
   *  split failure detail across both streams (per-item lines on stdout via
   *  console.log, ⛔/❌ summaries on stderr), so both are needed for the ledger. */
  output: string;
}

/**
 * Run an artifact CLI in-process. With `capture`, console output is collected
 * for the run ledger (migrate). Without it, output streams live (progress bars).
 */
async function runPackage(pkg: string, args: string[], label: string, capture = false): Promise<RunPackageResult> {
  console.log("\n" + "═".repeat(60));
  console.log(`  ▶  ${label}`);
  console.log("═".repeat(60) + "\n");

  const startedAt = Date.now();
  const result = await runArtifact(pkg as ArtifactPkg, args, { capture });
  const ms = Date.now() - startedAt;
  STEP_TIMINGS.push({ label, ms, ok: result.ok });

  if (!result.ok) {
    console.error(`\n❌  ${label} failed (exit code ${result.exitCode}) after ${(ms / 1000).toFixed(1)}s`);
    return { ok: false, output: result.output };
  }

  console.log(`\n  ⏱  ${label} took ${(ms / 1000).toFixed(1)}s`);
  return { ok: true, output: result.output };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("kibo-cms-clone-tool")
  .description("Kibo CMS Clone Tool — run all packages in sequence");

// ─── export-all ──────────────────────────────────────────────────────────────

program
  .command("export-all")
  .description("Export all content types from source in the correct order (file-manager → cms models/entries → page-builder → redirects)")
  .option(
    "--schema-file <file>",
    "Offline CMS model schema override for cms-entries (default: introspect live from source)",
    ""
  )
  .option(
    "--models <models>",
    "Comma-separated model names for cms-entries (used when --schema-file not set)",
    process.env["MODELS"] ?? ""
  )
  .option(
    "--site-id <siteId>",
    "Only export Content Entries where siteId matches",
    process.env["SITE_ID_FILTER"] ?? ""
  )
  .option("--locale <locale>", "Locale to export (e.g. en-US)", process.env["LOCALE"] ?? "en-US")
  .option("--tags <tags>", "Only export files with these tags (comma-sep, file-manager only)", process.env["TAGS_FILTER"] ?? "")
  .option("--filter <file>", "Advanced filter JSON (or @file); GraphQL where pushdown for dates/name/tags/siteId", "")
  .option("--out <base>", "Base output directory — sub-dirs files/, cms/, pages/, redirects/ are created automatically", "./export")
  .option(
    "--skip <packages>",
    "Comma-separated packages to skip, e.g. file-manager,redirects. Also: cms-models, cms-entries (cms parts).",
    ""
  )
  .option(
    "--cms-parts <parts>",
    "Which CMS pieces to export when cms is not fully skipped: models, entries, or both (default: both)",
    "both"
  )
  .option("--continue-on-error", "Keep going if a package fails (else stop at the first failure)", false)
  .option("--with-binaries", "Also download file binaries (file-manager only)", false)
  .option("--max-file-size <mb>", "Skip files larger than this many MB (0 = no limit)", process.env["MAX_FILE_SIZE_MB"] ?? "")
  .action(async (opts: {
    schemaFile: string;
    models: string;
    siteId: string;
    locale: string;
    tags: string;
    filter: string;
    out: string;
    skip: string;
    cmsParts: string;
    continueOnError: boolean;
    withBinaries: boolean;
    maxFileSize: string;
  }) => {
    const skip = parseSkipSet(opts.skip);
    // --cms-parts models|entries|both (default both). --skip cms-models / cms-entries are independent.
    const { wantModels, wantEntries } = resolveCmsParts(skip, opts.cmsParts);

    // Freeze filter once at job start so relative presets don't drift across pages.
    const frozen = parseFilterCliOption(opts.filter, { siteId: opts.siteId, tags: opts.tags });
    let filterArg: string[] = [];
    if (frozen) {
      const filterPath = path.join(ROOT, ".catalog-tmp", `export-filter-${Date.now()}.json`);
      writeFilterSpec(filterPath, frozen);
      filterArg = ["--filter", filterPath];
      console.log(`\n  Filter frozen at ${frozen.frozenAt}`);
      if (frozen.date) console.log(`  Date      : ${frozen.date.wireField} ${frozen.date.from} … ${frozen.date.to}`);
    }

    type ExportScan = "files" | "models" | "entries" | "pages" | "redirects";
    type Step = { pkg: string; label: string; args: string[]; scan: ExportScan; artifactType: ArtifactType };
    const steps: Step[] = [];
    let stepN = 0;
    const label = (name: string) => `Step ${++stepN} — ${name}`;

    if (!skip.has("file-manager")) {
      steps.push({
        pkg: "file-manager",
        label: label("File Manager"),
        scan: "files",
        artifactType: "file",
        args: [
          "export",
          "--out", `${opts.out}/files`,
          ...filterArg,
          ...(!frozen && opts.tags ? ["--tags", opts.tags] : []),
          ...(opts.withBinaries ? ["--with-binaries"] : []),
          ...(opts.maxFileSize ? ["--max-file-size", opts.maxFileSize] : []),
        ],
      });
    }

    if (wantModels || wantEntries) {
      const cmsOut = `${opts.out}/cms`;
      const modelFilterArgs = opts.models ? ["--models", opts.models] : [];
      if (wantModels) {
        steps.push({
          pkg: "cms-entries",
          label: label("Content Models"),
          scan: "models",
          artifactType: "model",
          args: ["export-models", "--out", cmsOut, "--locale", opts.locale, ...modelFilterArgs],
        });
      }
      if (wantEntries) {
        steps.push({
          pkg: "cms-entries",
          label: label("Content Entries"),
          scan: "entries",
          artifactType: "cms-entry",
          args: [
            "export",
            "--out", cmsOut,
            "--locale", opts.locale,
            ...filterArg,
            ...(opts.schemaFile
              ? ["--schema-file", opts.schemaFile]
              : opts.models
              ? ["--models", opts.models]
              : []),
            ...(!frozen && opts.siteId ? ["--site-id", opts.siteId] : []),
          ],
        });
      }
    }

    if (!skip.has("page-builder")) {
      steps.push({
        pkg: "page-builder",
        label: label("Page Builder"),
        scan: "pages",
        artifactType: "page",
        args: ["export", "--out", `${opts.out}/pages`, "--locale", opts.locale, ...filterArg],
      });
    }

    if (!skip.has("redirects")) {
      steps.push({
        pkg: "redirects",
        label: label("Redirects"),
        scan: "redirects",
        artifactType: "redirect",
        args: ["export", "--out", `${opts.out}/redirects`, ...filterArg],
      });
    }

    // Resolve --out against repo root so artifact modules always write to one place.
    opts.out = path.resolve(ROOT, opts.out);
    for (const step of steps) {
      for (let i = 0; i < step.args.length - 1; i++) {
        if (step.args[i] === "--out") step.args[i + 1] = path.resolve(ROOT, step.args[i + 1]);
      }
    }

    console.log("\n🚀  Kibo CMS Clone Tool — Export All");
    console.log(`   Packages  : ${steps.map((s) => s.pkg).join(" → ")}`);
    console.log(`   Output    : ${opts.out}/{files,cms,pages,redirects}`);

    const { run: wsRun, restore: restoreLog } = openCliWorkstream(defaultLogsRoot(ROOT), "export", {
      sourceTenant: process.env["SOURCE_TENANT"],
      argsSummary: `export-all --out ${opts.out}`,
    });
    wsRun.emitEvent("run.start", { packages: steps.map((s) => s.pkg) });

    const runsDir = workstreamRunsDir("export");
    const now = () => new Date().toISOString();
    const ledger = createEmptyRun(wsRun.meta.runId, ledgerEnv("source", wsRun.meta.sourceTenant), now());
    saveRun(runsDir, ledger);
    console.log(`   Run id: ${ledger.id}  (ledger: ${path.relative(ROOT, runsDir)}/)`);

    // Export packages are independent — with --continue-on-error a failure in one
    // (e.g. files "Not authorized") doesn't block the others; without it, stop at
    // the first failure.
    const failed: string[] = [];
    try {
      for (const step of steps) {
        const outIdx = step.args.indexOf("--out");
        const outDir = outIdx >= 0 ? step.args[outIdx + 1] : "";
        const ok = (await runPackage(step.pkg, step.args, step.label)).ok;
        if (ok && outDir) {
          const scanned =
            step.scan === "files" ? await scanExportedFiles(outDir)
            : step.scan === "models" ? await scanExportedModels(outDir)
            : step.scan === "entries" ? await scanExportedEntries(outDir)
            : step.scan === "pages" ? await scanExportedPages(outDir)
            : await scanExportedRedirects(outDir);
          applyResults(ledger, scanned, now());
          saveRun(runsDir, ledger);
          continue;
        }
        failed.push(step.label);
        applyResults(ledger, [{
          type: step.artifactType,
          id: `__step__:${step.scan}`,
          status: "error",
          error: `${step.label} failed`,
        }], now());
        saveRun(runsDir, ledger);
        if (!opts.continueOnError) {
          console.error("\n⛔  Export stopped at the step above. Pass --continue-on-error to skip past failures.\n");
          reportTimings("Export All");
          printLedgerSummary(ledger, runsDir);
          wsRun.finish("error", "stopped at first failure");
          process.exit(1);
        }
      }

      console.log("\n" + "═".repeat(60));
      console.log(failed.length ? `  ⚠  Export finished with ${failed.length} failed step(s)` : "  ✅  All exports complete!");
      for (const f of failed) console.log(`     ✗ ${f}`);
      printLedgerSummary(ledger, runsDir);
      console.log("═".repeat(60));
      reportTimings("Export All");
      console.log("  Review / edit the JSON files in each sub-directory, then run:");
      console.log(`  npx ts-node index.ts import-all --in ${opts.out}\n`);
      console.log(`  Logs: ${path.relative(ROOT, wsRun.dir)}`);
      wsRun.finish(failed.length ? "error" : "done", failed.length ? `${failed.length} step(s) failed` : undefined);
      if (failed.length === steps.length) process.exit(1); // all failed → error exit
    } finally {
      restoreLog();
    }
  });

// ─── export-selected ─────────────────────────────────────────────────────────

program
  .command("export-selected")
  .description("Hydrate deps for a selection and export only that closure (Migrate-style selective export)")
  .option("--catalog <file>", "Catalog JSON (from catalog-all)", "./catalog.json")
  .option("--select <ids>", "Selected ids: comma/space-separated, or @file", "")
  .option("--omit-deps <ids>", "Dependency ids to leave out after user uncheck (comma/space-separated or @file)", "")
  .option("--out <base>", "Output directory for the selective export (sub-dirs files/, cms/, pages/, redirects/)", "")
  .option("--schema-file <file>", "Offline model schema override", "")
  .option("--allow-missing-deps", "Continue when hydrated dependencies cannot be resolved from source", false)
  .option("--with-binaries", "Also download file binaries (file-manager only)", false)
  .option("--max-file-size <mb>", "Skip binaries larger than this many MB (0 = no limit)", process.env["MAX_FILE_SIZE_MB"] ?? "")
  .action(async (opts: {
    catalog: string;
    select: string;
    omitDeps: string;
    out: string;
    schemaFile: string;
    allowMissingDeps: boolean;
    withBinaries: boolean;
    maxFileSize: string;
  }) => {
    if (!opts.select) {
      console.error("❌ Provide --select <ids> (comma/space-separated, or @file).");
      process.exit(1);
    }
    if (!opts.out) {
      console.error("❌ Provide --out <dir> for the selective export folder.");
      process.exit(1);
    }
    const catalogPath = path.resolve(ROOT, opts.catalog);
    if (!fs.existsSync(catalogPath)) {
      console.error(`❌ Catalog not found: ${catalogPath}`);
      process.exit(1);
    }
    let catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as Catalog;
    const ids = parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"));
    const omitIds = opts.omitDeps
      ? parseSelection(opts.omitDeps, (p) => fs.readFileSync(p, "utf-8"))
      : [];

    const adminClient = createClient(resolveEnvironment("source"), {
      locale: getLocale(),
      rateLimit: getRateLimitDelay(),
      debug: getDebug(),
    });
    let manageClient: ReturnType<typeof createClient> | null = null;
    try {
      manageClient = createClient(resolveEnvironment("source", { requireManage: true }), {
        useManage: true,
        locale: getLocale(),
        rateLimit: getRateLimitDelay(),
        debug: getDebug(),
      });
    } catch { /* optional */ }

    if (omitIds.length) console.log(`   Omitting ${omitIds.length} intentionally unchecked dep(s)`);
    const hydrated = await hydrateDependencies(catalog, ids, {
      fetchFileByDepId: (id) => fetchFileByDepId(adminClient, id),
      fetchModelById: manageClient ? (id) => fetchModelById(manageClient!, id) : undefined,
    }, { omitIds });
    catalog = catalogOmittingDeps(hydrated.catalog, omitIds);
    if (hydrated.hydratedIds.length) {
      console.log(`   Hydrated ${hydrated.hydratedIds.length} dep(s) outside catalog window`);
    }
    if (hydrated.unresolvedIds.length) {
      const msg = formatUnresolvedDepsMessage(hydrated.unresolvedIds);
      if (shouldAbortForUnresolvedDeps(hydrated.unresolvedIds, opts.allowMissingDeps)) {
        console.error(`❌ ${msg}\n   Re-catalog with broader filters, or pass --allow-missing-deps.`);
        process.exit(1);
      }
      console.log(`   ⚠  ${msg} (continuing with --allow-missing-deps)`);
    }

    const plan = planMigration(catalog, ids);
    console.log(`   Selected ${plan.selectedCount} → ${plan.resolvedCount} after deps`);
    console.log(`   Order: ${plan.steps.map((s) => `${s.type}(${s.ids.length})`).join(" → ")}`);

    const outBase = path.resolve(ROOT, opts.out);
    fs.mkdirSync(outBase, { recursive: true });
    const workDir = path.join(ROOT, ".migrate-tmp", `export-selected-${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    const rawSteps = buildSelectiveExportSteps(plan, outBase, {
      schemaFile: opts.schemaFile,
      withBinaries: opts.withBinaries,
      maxFileSize: opts.maxFileSize,
    });
    for (const step of rawSteps) {
      const idsFile = path.join(workDir, `${step.type}.ids`);
      fs.writeFileSync(idsFile, step.ids.join("\n"), "utf-8");
    }
    const steps = bindSelectiveExportIds(rawSteps, (type) => path.join(workDir, `${type}.ids`));

    let failed = 0;
    for (const step of steps) {
      // Keep models.json when exporting entries into the same cms/ dir.
      if (step.type === "cms-entry") {
        const cmsDir = path.join(outBase, "cms");
        if (fs.existsSync(path.join(cmsDir, "models.json"))) {
          const keep = fs.readFileSync(path.join(cmsDir, "models.json"));
          for (const name of fs.readdirSync(cmsDir)) {
            if (name === "models.json") continue;
            fs.rmSync(path.join(cmsDir, name), { recursive: true, force: true });
          }
          fs.writeFileSync(path.join(cmsDir, "models.json"), keep);
        } else {
          fs.rmSync(cmsDir, { recursive: true, force: true });
        }
      } else if (step.type !== "model") {
        fs.rmSync(path.join(outBase, step.subDir), { recursive: true, force: true });
      }
      const r = await runPackage(step.pkg, step.args, step.label);
      if (!r.ok) {
        failed++;
        console.error(`\n⛔  ${step.label} failed`);
        process.exit(1);
      }
    }
    console.log(`\n✅ Selective export complete → ${path.relative(ROOT, outBase) || outBase}`);
    if (failed) process.exit(1);
  });

// ─── import-all ──────────────────────────────────────────────────────────────

program
  .command("import-all")
  .description("Import all content types to target in the correct order (file-manager → cms-entries → page-builder → redirects)")
  .option("--in <base>", "Base input directory containing files/, cms/, pages/, redirects/", "./export")
  .option("--locale <locale>", "Locale header for target API", process.env["LOCALE"] ?? "en-US")
  .option("--dry-run", "Preview without writing to target", process.env["DRY_RUN"] === "true")
  .option("--allow-folder-mismatch", "Import even if some folders failed to sync (items fall back to root)", false)
  .option("--allow-schema-mismatch", "Import entries even if a target model is field-incompatible with source", false)
  .option("--select <ids>", "Import only these item ids (comma-separated or @file). Default: all in the folder", "")
  .option("--continue-on-error", "Keep going if a package fails (else stop at the first failure)", false)
  .option(
    "--skip <packages>",
    "Comma-separated packages to skip, e.g. file-manager,redirects. Also: cms-models, cms-entries (cms parts).",
    ""
  )
  .option("--upload-binaries", "Upload binaries from <in>/files/binaries/ (file-manager only)", false)
  .option("--stream-binaries", "Force streaming even if a local cache exists (default already streams)", false)
  .option("--manifest-only", "Do not transfer/register files; emit S3 copy manifest instead (file-manager only)", false)
  .option("--max-file-size <mb>", "Skip binaries larger than this many MB (0 = no limit)", process.env["MAX_FILE_SIZE_MB"] ?? "")
  .option("--as-draft", "Leave entries/pages as draft on target (skip publish); default on", process.env["AS_DRAFT"] !== "false")
  .option("--no-as-draft", "Publish when source was published (disable as-draft)")
  .action(async (opts: {
    in: string;
    locale: string;
    dryRun: boolean;
    allowFolderMismatch: boolean;
    allowSchemaMismatch: boolean;
    select: string;
    continueOnError: boolean;
    skip: string;
    uploadBinaries: boolean;
    streamBinaries: boolean;
    manifestOnly: boolean;
    maxFileSize: string;
    asDraft: boolean;
  }) => {
    const skip = parseSkipSet(opts.skip);
    const { wantModels, wantEntries } = resolveCmsParts(skip, "both");
    const dryFlags = opts.dryRun ? ["--dry-run"] : [];
    const folderFlags = opts.allowFolderMismatch ? ["--allow-folder-mismatch"] : [];
    // Item ids don't collide across types (entryId / src|key / path / redirectFrom),
    // so the same selection passed to every package's --select filters to its own.
    const selectFlags = opts.select ? ["--select", opts.select] : [];
    const draftFlags = opts.asDraft === false ? ["--no-as-draft"] : [];
    const binFlags = [
      ...(opts.manifestOnly ? ["--manifest-only"] : []),
      ...(opts.uploadBinaries ? ["--upload-binaries"] : []),
      ...(opts.streamBinaries ? ["--stream-binaries"] : []),
      ...(opts.maxFileSize ? ["--max-file-size", opts.maxFileSize] : []),
    ];

    type Step = { pkg: string; sub: string; label: string; args: string[]; kind?: string; artifactType: ArtifactType };
    const steps: Step[] = [];
    let stepN = 0;
    const label = (name: string) => `Step ${++stepN} — ${name}`;

    const keymapDir = path.join(ROOT, ".keymap");
    opts.in = path.resolve(ROOT, opts.in);
    const cmsDir = path.join(opts.in, "cms");

    if (!skip.has("file-manager")) {
      steps.push({
        pkg: "file-manager", sub: "files", artifactType: "file",
        label: label("File Manager"),
        args: ["import", "--in", path.join(opts.in, "files"), ...dryFlags, ...folderFlags, ...selectFlags, ...binFlags, "--keymap-dir", keymapDir],
      });
    }

    const cmsKinds = planImportAllCmsSteps({
      wantModels,
      wantEntries,
      hasModelsJson: cmsDirHasModelsJson(cmsDir),
      hasEntryManifests: cmsDirHasEntries(cmsDir),
    });
    for (const kind of cmsKinds) {
      if (kind === "models") {
        steps.push({
          pkg: "cms-entries", sub: "cms", kind: "models", artifactType: "model",
          label: label("Content Models"),
          args: [
            "import-models", "--in", cmsDir, "--locale", opts.locale,
            ...dryFlags, ...selectFlags,
          ],
        });
      } else {
        steps.push({
          pkg: "cms-entries", sub: "cms", kind: "entries", artifactType: "cms-entry",
          label: label("Content Entries"),
          // create-missing-model: provision absent models from source when no models.json
          args: [
            "import", "--in", cmsDir, "--locale", opts.locale, "--create-missing-model",
            ...dryFlags, ...folderFlags, ...selectFlags, ...draftFlags,
            ...(opts.allowSchemaMismatch ? ["--allow-schema-mismatch"] : []),
            "--keymap-dir", keymapDir,
          ],
        });
      }
    }

    if (!skip.has("page-builder")) {
      steps.push({
        pkg: "page-builder", sub: "pages", artifactType: "page",
        label: label("Page Builder"),
        args: ["import", "--in", path.join(opts.in, "pages"), "--locale", opts.locale, ...dryFlags, ...folderFlags, ...selectFlags, ...draftFlags, "--keymap-dir", keymapDir],
      });
    }

    if (!skip.has("redirects")) {
      steps.push({
        pkg: "redirects", sub: "redirects", artifactType: "redirect",
        label: label("Redirects"),
        args: ["import", "--in", path.join(opts.in, "redirects"), ...dryFlags, ...folderFlags, ...selectFlags],
      });
    }

    for (const step of steps) {
      for (let i = 0; i < step.args.length - 1; i++) {
        if (step.args[i] === "--in" || step.args[i] === "--keymap-dir") {
          step.args[i + 1] = path.resolve(ROOT, step.args[i + 1]);
        }
      }
    }

    // Skip any artifact whose input sub-dir isn't in this export folder — the
    // folder may only contain a subset (e.g. a files-only export). Missing ≠ error.
    // CMS steps already gated on models.json / entry manifests; only require cms/.
    const runnable: Step[] = [];
    for (const s of steps) {
      if (fs.existsSync(path.join(opts.in, s.sub))) runnable.push(s);
      else console.log(`   ⏭  Skipping ${s.kind ? `${s.pkg}/${s.kind}` : s.pkg} — no '${s.sub}/' in ${opts.in}`);
    }

    console.log("\n🚀  Kibo CMS Clone Tool — Import All");
    console.log(`   Packages  : ${runnable.map((s) => (s.kind ? `${s.pkg}:${s.kind}` : s.pkg)).join(" → ") || "(none — empty export folder)"}`);
    console.log(`   Input     : ${opts.in}/{files,cms,pages,redirects}`);
    console.log(`   Dry Run   : ${opts.dryRun}`);
    if (opts.dryRun) {
      console.log("\n  ⚠   DRY RUN — remove --dry-run to execute writes");
    }

    const { run: wsRun, restore: restoreLog } = openCliWorkstream(defaultLogsRoot(ROOT), "import", {
      targetTenant: process.env["TARGET_TENANT"],
      argsSummary: `import-all --in ${opts.in}`,
    });
    wsRun.emitEvent("run.start", { packages: runnable.map((s) => s.pkg) });

    const runsDir = workstreamRunsDir("import");
    const now = () => new Date().toISOString();
    const ledger = createEmptyRun(wsRun.meta.runId, ledgerEnv("target", wsRun.meta.targetTenant), now());
    saveRun(runsDir, ledger);
    console.log(`   Run id: ${ledger.id}  (ledger: ${path.relative(ROOT, runsDir)}/)`);

    const resultWorkDir = path.join(ROOT, ".migrate-tmp", ledger.id);
    fs.mkdirSync(resultWorkDir, { recursive: true });

    const importFailed: string[] = [];
    try {
      for (const step of runnable) {
        const resultFile = path.join(resultWorkDir, `${step.kind || step.pkg}.result.json`);
        const args = [...step.args, "--result", resultFile];
        const ok = (await runPackage(step.pkg, args, step.label)).ok;
        let results = readResultFile(resultFile);
        if (!results.length) {
          results = [{
            type: step.artifactType,
            id: `__step__:${step.kind || step.pkg}`,
            status: ok ? "done" : "error",
            action: ok ? (opts.dryRun ? "would-import" : "imported") : undefined,
            error: ok ? undefined : `${step.label} failed (no per-item result file)`,
          }];
        }
        applyResults(ledger, results, now());
        saveRun(runsDir, ledger);
        if (ok) continue;
        importFailed.push(step.label);
        if (!opts.continueOnError) {
          console.error("\n⛔  Import stopped at the step above. Pass --continue-on-error to skip past failures, or fix and re-run.\n");
          reportTimings("Import All");
          printLedgerSummary(ledger, runsDir);
          wsRun.finish("error", "stopped at first failure");
          process.exit(1);
        }
      }
      if (importFailed.length) { console.warn(`\n  ⚠  ${importFailed.length} step(s) failed:`); for (const f of importFailed) console.warn(`     ✗ ${f}`); }

      console.log("\n" + "═".repeat(60));
      if (opts.dryRun) {
        console.log("  ✅  Dry run complete — no changes made.");
        printLedgerSummary(ledger, runsDir);
        console.log("═".repeat(60));
        console.log("\n  Re-run without --dry-run to execute.\n");
      } else {
        console.log("  ✅  All imports complete!");
        printLedgerSummary(ledger, runsDir);
        console.log("═".repeat(60));
        console.log("\n  Next steps:");
        console.log("  1. Review s3-copy-manifest.txt (if any) for manual S3 copies");
        console.log("  2. Verify content counts and spot-check records in target");
        console.log("  3. Rebuild navigation menus manually in the target admin\n");
      }
      console.log(`  Logs: ${path.relative(ROOT, wsRun.dir)}`);
      reportTimings("Import All");
      wsRun.finish(importFailed.length ? "error" : "done", importFailed.length ? `${importFailed.length} step(s) failed` : undefined);
    } finally {
      try { fs.rmSync(resultWorkDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      restoreLog();
    }
  });

// ─── provision-models ─────────────────────────────────────────────────────────

program
  .command("provision-models")
  .description("Create selected content models on the target (from cms/models.json when --in is set, else live from source)")
  .requiredOption("--select <ids>", "modelIds: comma/space-separated, or @file")
  .option("--in <dir>", "Export cms dir containing models.json (offline importStructure)", "")
  .option("--result <file>", "Write per-item results JSON", "")
  .action(async (opts: { select: string; in: string; result: string }) => {
    const ids = parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"));
    if (!ids.length) {
      console.error("❌ Provide --select <modelIds> (comma/space-separated, or @file).");
      process.exit(1);
    }
    const tmpDir = path.join(ROOT, ".migrate-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const idsFile = path.join(tmpDir, `provision-models-${Date.now()}.ids`);
    fs.writeFileSync(idsFile, ids.join("\n"), "utf-8");

    const modelsJson = opts.in
      ? path.join(path.resolve(ROOT, opts.in), "models.json")
      : "";
    let args: string[];
    let label: string;
    if (modelsJson && fs.existsSync(modelsJson)) {
      console.log(`   Using offline models.json → ${modelsJson}`);
      args = ["import-models", "--in", path.resolve(ROOT, opts.in), "--select", `@${idsFile}`];
      label = `Import models from file (${ids.length})`;
    } else {
      if (opts.in) console.log(`   ⚠  models.json not under ${opts.in} — falling back to live source provision`);
      args = ["models", "--provision", `@${idsFile}`];
      label = `Provision models live (${ids.length})`;
    }
    if (opts.result) args.push("--result", opts.result);
    const r = await runPackage("cms-entries", args, label, true);
    try { fs.unlinkSync(idsFile); } catch { /* best-effort */ }
    if (!r.ok) process.exit(1);
  });

// ─── catalog-all ───────────────────────────────────────────────────────────────

program
  .command("catalog-all")
  .description("Build one combined catalog of all artifact types (files, cms-entries, pages, redirects) for an environment")
  .option("--env <role>", "Environment to read: source | target", "source")
  .option("--schema-file <file>", "Offline model schema override (default: introspect live)", "")
  .option("--filter <file>", "Advanced filter JSON (or @file); applied during each catalog list", "")
  .option("--models <models>", "Comma-separated CMS model names/ids for cms-entries catalog (default: ALL)", "")
  .option("--out <file>", "Merged catalog JSON output", "./catalog.json")
  .option("--skip <packages>", "Comma-separated packages to skip", "")
  .action(async (opts: { env: string; schemaFile: string; filter: string; models: string; out: string; skip: string }) => {
    const skip = new Set(opts.skip.split(",").map((s) => s.trim()).filter(Boolean));
    const tmpDir = path.join(ROOT, ".catalog-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });

    const frozen = parseFilterCliOption(opts.filter);
    let filterArg: string[] = [];
    if (frozen) {
      const filterPath = path.join(tmpDir, `catalog-filter-${Date.now()}.json`);
      writeFilterSpec(filterPath, frozen);
      filterArg = ["--filter", filterPath];
    }

    // Warm default where-caps cache for UI badges / support (probe-validated defaults).
    const tenant =
      opts.env === "target"
        ? process.env["TARGET_TENANT"] ?? "root"
        : process.env["SOURCE_TENANT"] ?? "root";
    saveCapsCache(tmpDir, {
      key: capsCacheKey({
        manageUrl: opts.env === "target" ? process.env["TARGET_MANAGE_URL"] : process.env["SOURCE_MANAGE_URL"],
        adminUrl: opts.env === "target" ? process.env["TARGET_ADMIN_GQL_URL"] : process.env["SOURCE_ADMIN_GQL_URL"],
        tenant,
      }),
      savedAt: new Date().toISOString(),
      ttlMs: 24 * 3600_000,
      caps: { ...DEFAULT_WHERE_CAPS },
    });

    type Step = { pkg: string; label: string; args: string[]; file: string };
    const steps: Step[] = [];
    const add = (pkg: string, extra: string[] = []) => {
      const file = path.join(tmpDir, `${pkg}.json`);
      steps.push({
        pkg,
        label: pkg,
        args: ["catalog", "--env", opts.env, "--out", file, ...filterArg, ...extra],
        file,
      });
    };

    if (!skip.has("file-manager")) add("file-manager");
    if (!skip.has("cms-entries")) {
      // With a schema file, use it; otherwise introspect models live from the env.
      // --models narrows which content models (and their entries) are cataloged.
      const modelsList = (opts.models || "").trim() || "ALL";
      const cmsExtra = opts.schemaFile
        ? ["--schema-file", opts.schemaFile, ...(modelsList !== "ALL" ? ["--models", modelsList] : [])]
        : ["--models", modelsList];
      add("cms-entries", cmsExtra);
    }
    if (!skip.has("page-builder")) add("page-builder");
    if (!skip.has("redirects")) add("redirects");

    console.log("\n🗂️  Catalog All");
    console.log(`   Environment : ${opts.env}`);
    console.log(`   Types       : ${steps.map((s) => s.pkg).join(", ")}`);
    if (frozen) console.log(`   Filter      : frozen at ${frozen.frozenAt}`);

    const sections: CatalogSection[] = [];
    let environment: Catalog["environment"] | null = null;

    for (const step of steps) {
      const ok = (await runPackage(step.pkg, step.args, `Catalog — ${step.label}`)).ok;
      if (!ok || !fs.existsSync(step.file)) {
        console.warn(`  ⚠  ${step.pkg} catalog produced no output — skipping`);
        continue;
      }
      const cat = JSON.parse(fs.readFileSync(step.file, "utf-8")) as Catalog;
      if (!environment) environment = cat.environment;
      sections.push(...cat.sections);
    }

    const merged = buildCatalog(
      environment ?? { role: opts.env, tenant: "?", locale: "en-US" },
      sections,
      new Date().toISOString()
    );
    fs.writeFileSync(opts.out, JSON.stringify(merged, null, 2), "utf-8");
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log("\n" + "═".repeat(60));
    console.log("  ✅  Combined catalog written → " + opts.out);
    for (const s of merged.sections) {
      console.log(`     ${s.type.padEnd(12)} ${String(s.total).padStart(5)}${s.note ? `  (note: ${s.note})` : ""}`);
    }
    console.log("═".repeat(60) + "\n");
  });

// ─── plan ────────────────────────────────────────────────────────────────────

program
  .command("plan")
  .description("Build a dependency-ordered migration plan from a catalog + a selection")
  .option("--catalog <file>", "Catalog JSON (from catalog-all)", "./catalog.json")
  .option("--select <ids>", "Selected ids: comma/space-separated, or @file", "")
  .option("--out <file>", "Write the plan JSON to this file", "")
  .action(async (opts: { catalog: string; select: string; out: string }) => {
    if (!fs.existsSync(opts.catalog)) {
      console.error(`❌ Catalog not found: ${opts.catalog}\n   Run 'catalog-all' first.`);
      process.exit(1);
    }
    const catalog = JSON.parse(fs.readFileSync(opts.catalog, "utf-8")) as Catalog;
    const ids = parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"));
    if (ids.length === 0) {
      console.error("❌ Provide --select <ids> (comma/space-separated, or @file).");
      process.exit(1);
    }

    const plan = planMigration(catalog, ids);

    console.log("\n🧭 Migration Plan");
    console.log("─".repeat(50));
    console.log(`  Environment      : ${catalog.environment.role} (tenant ${catalog.environment.tenant})`);
    console.log(`  Selected         : ${plan.selectedCount}`);
    console.log(`  After deps       : ${plan.resolvedCount} (+${plan.addedByDependencies.length} pulled in)`);
    if (plan.unknownIds.length) console.log(`  ⚠  Unknown ids   : ${plan.unknownIds.length} (${plan.unknownIds.slice(0, 3).join(", ")}…)`);
    console.log("─".repeat(50));
    console.log("  Order (dependencies first):");
    for (const step of plan.steps) {
      console.log(`    ${step.type.padEnd(12)} ${String(step.ids.length).padStart(4)} item(s)`);
    }
    if (plan.addedByDependencies.length) {
      console.log("\n  Pulled in by dependencies:");
      for (const id of plan.addedByDependencies.slice(0, 8)) console.log(`    + ${id}`);
      if (plan.addedByDependencies.length > 8) console.log(`    … and ${plan.addedByDependencies.length - 8} more`);
    }
    console.log("");

    if (opts.out) {
      fs.writeFileSync(opts.out, JSON.stringify(plan, null, 2), "utf-8");
      console.log(`  Plan written → ${opts.out}\n`);
    }
  });

// ─── migrate ─────────────────────────────────────────────────────────────────

// Per-artifact-type wiring: which package handles it, its export sub-dir, and
// any extra export/import args. cms-entries needs the schema file + provisioning.
const TYPE_WIRING: Record<string, { pkg: string; sub: string; exp: (sf: string) => string[]; imp: (sf: string) => string[] }> = {
  "file":      { pkg: "file-manager", sub: "files",     exp: () => [], imp: () => ["--keymap-dir", KEYMAP_DIR] },
  "cms-entry": { pkg: "cms-entries",  sub: "cms",       exp: (sf) => (sf ? ["--schema-file", sf] : []), imp: (sf) => [...(sf ? ["--schema-file", sf] : []), "--create-missing-model", "--keymap-dir", KEYMAP_DIR] },
  "page":      { pkg: "page-builder", sub: "pages",     exp: () => [], imp: () => ["--keymap-dir", KEYMAP_DIR] },
  "redirect":  { pkg: "redirects",    sub: "redirects", exp: () => [], imp: () => [] },
};

program
  .command("migrate")
  .description("Execute a dependency-ordered migration of selected artifacts (source → target), recording a resumable run")
  .option("--catalog <file>", "Catalog JSON (from catalog-all)", "./catalog.json")
  .option("--select <ids>", "Selected ids: comma/space-separated, or @file", "")
  .option("--omit-deps <ids>", "Dependency ids to leave out after user uncheck (comma/space-separated or @file)", "")
  .option("--in <base>", "Staging dir for this run (default: .migrate-tmp/<runId>; sub-dirs files/, cms/, pages/, redirects/)", "./export")
  .option("--schema-file <file>", "Offline model schema override (default: fetch live from source)", "")
  .option("--dry-run", "Preview the plan without writing or recording a run", process.env["DRY_RUN"] === "true")
  .option("--skip-export", "Reuse the existing export staging dir instead of re-exporting from source", false)
  .option("--resume <runId>", "Resume a previous run — re-run only items not yet done", "")
  .option("--runs-dir <dir>", "Directory for migrate ledgers", DEFAULT_MIGRATE_RUNS_DIR)
  .option("--allow-schema-mismatch", "Import entries even if a target model is field-incompatible with source", false)
  .option("--allow-folder-mismatch", "Import items even if some folders failed to sync (they fall back to root)", false)
  .option("--allow-missing-deps", "Continue when hydrated dependencies cannot be resolved from source", false)
  .option("--continue-on-error", "Keep migrating remaining types if one fails (else stop; resume later)", false)
  .option("--manifest-only", "Do not transfer/register files; emit S3 copy manifest instead", false)
  .option("--stream-binaries", "Force streaming even if a local cache exists (default already streams)", false)
  .option("--max-file-size <mb>", "Skip binaries larger than this many MB (0 = no limit)", process.env["MAX_FILE_SIZE_MB"] ?? "")
  .option("--as-draft", "Leave entries/pages as draft on target (skip publish); default on", process.env["AS_DRAFT"] !== "false")
  .option("--no-as-draft", "Publish when source was published (disable as-draft)")
  .action(async (opts: { catalog: string; select: string; omitDeps: string; in: string; schemaFile: string; dryRun: boolean; skipExport: boolean; resume: string; runsDir: string; allowSchemaMismatch: boolean; allowFolderMismatch: boolean; allowMissingDeps: boolean; continueOnError: boolean; manifestOnly: boolean; streamBinaries: boolean; maxFileSize: string; asDraft: boolean }) => {
    const { runsDir, legacyDir } = resolveMigrateRunsDir(opts.runsDir);
    const now = () => new Date().toISOString();

    let run: MigrationRun;

    if (opts.resume) {
      run = loadRunWithFallback(runsDir, opts.resume, [legacyDir]);
      const s = runSummary(run);
      console.log(`\n🚚 Migrate — resuming ${run.id}`);
      console.log(`   Status: done ${s.done}, pending ${s.pending}, error ${s.error}, skipped ${s.skipped}`);
    } else {
      if (!fs.existsSync(opts.catalog)) {
        console.error(`❌ Catalog not found: ${opts.catalog}\n   Run 'catalog-all' first.`);
        process.exit(1);
      }
      let catalog = JSON.parse(fs.readFileSync(opts.catalog, "utf-8")) as Catalog;
      const ids = parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"));
      if (ids.length === 0) {
        console.error("❌ Provide --select <ids> (comma/space-separated, or @file).");
        process.exit(1);
      }

      // Hydrate file/model deps outside the catalog filter window before planning.
      console.log("\n🚚 Migrate");
      console.log("   Hydrating dependencies outside catalog/filter window…");
      const srcAdmin = resolveEnvironment("source");
      const adminClient = createClient(srcAdmin, {
        locale: getLocale(),
        rateLimit: getRateLimitDelay(),
        debug: getDebug(),
      });
      let manageClient: ReturnType<typeof createClient> | null = null;
      try {
        manageClient = createClient(resolveEnvironment("source", { requireManage: true }), {
          useManage: true,
          locale: getLocale(),
          rateLimit: getRateLimitDelay(),
          debug: getDebug(),
        });
      } catch {
        /* Manage URL optional when selection has no entry→model edges */
      }
      const omitIds = opts.omitDeps
        ? parseSelection(opts.omitDeps, (p) => fs.readFileSync(p, "utf-8"))
        : [];
      if (omitIds.length) {
        console.log(`   Omitting ${omitIds.length} intentionally unchecked dep(s)`);
      }
      const hydrated = await hydrateDependencies(catalog, ids, {
        fetchFileByDepId: (id) => fetchFileByDepId(adminClient, id),
        fetchModelById: manageClient
          ? (id) => fetchModelById(manageClient!, id)
          : undefined,
      }, { omitIds });
      catalog = catalogOmittingDeps(hydrated.catalog, omitIds);
      if (hydrated.hydratedIds.length) {
        const byType = new Map<string, number>();
        for (const hid of hydrated.hydratedIds) {
          const it = catalog.sections.flatMap((s) => s.items).find((x) => x.id === hid);
          const t = it?.type ?? "item";
          byType.set(t, (byType.get(t) ?? 0) + 1);
        }
        const parts = [...byType.entries()].map(([t, n]) => `${n} ${t}(s)`);
        console.log(`   Hydrated ${parts.join(", ")} outside filter/catalog window`);
      }
      if (hydrated.unresolvedIds.length) {
        const msg = formatUnresolvedDepsMessage(hydrated.unresolvedIds);
        if (shouldAbortForUnresolvedDeps(hydrated.unresolvedIds, opts.allowMissingDeps)) {
          console.error(`❌ ${msg}\n   Re-export/catalog with broader filters, or pass --allow-missing-deps.`);
          process.exit(1);
        }
        console.log(`   ⚠  ${msg} (continuing with --allow-missing-deps)`);
      }

      const plan = planMigration(catalog, ids);

      console.log(`   Selected ${plan.selectedCount} → ${plan.resolvedCount} after deps`);
      console.log(`   Order: ${plan.steps.map((s) => `${s.type}(${s.ids.length})`).join(" → ")}`);
      if (plan.unknownIds.length) console.log(`   ⚠  ${plan.unknownIds.length} unknown id(s) ignored`);

      if (opts.dryRun) {
        console.log("   ⚠  DRY RUN — no target writes, no run recorded.\n");
        return;
      }

      // Under the UI, reuse KIBO_RUN_ID so ledger + console share one .logs/migrate/<id>/ folder.
      const id = inheritedRunId() || ("run-" + now().replace(/[:.]/g, "-"));
      run = createRun(id, catalog.environment, plan, now());
      saveRun(runsDir, run);
      console.log(`   Run id: ${run.id}  (ledger: ${path.relative(ROOT, runsDir)}/)`);
    }

    // Run-scoped work dir under .migrate-tmp/<runId>/ for ephemeral ids/results.
    // Default staging is the same dir (not export/) so Migrate scratch never
    // appears in the Import UI list. Explicit --in is respected and never auto-deleted.
    const migrateTmpRoot = path.join(ROOT, ".migrate-tmp");
    const workDir = migrateWorkDir(migrateTmpRoot, run.id);
    const autoStaging = opts.in === "./export";
    const stagingBase = autoStaging ? workDir : path.resolve(ROOT, opts.in);
    console.log(`   Export staging: ${path.relative(ROOT, stagingBase) || stagingBase}`);

    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(stagingBase, { recursive: true });
    let aborted = false;

    emitEvent(runsDir, { ts: now(), type: "run.start", runId: run.id, data: { resumed: !!opts.resume, dryRun: opts.dryRun } });

    // Execute pending items per type, in dependency order. `done` items are
    // skipped (idempotent); each step's outcome is written back to the ledger.
    for (const type of TYPE_ORDER) {
      if (type !== "model" && !TYPE_WIRING[type]) continue;
      const pend = pendingItems(run, type);
      if (pend.length === 0) continue;
      const stepIds = pend.map((i) => i.id);
      emitEvent(runsDir, { ts: now(), type: "step.start", runId: run.id, scope: type, data: { count: stepIds.length } });

      const idsFile = path.join(workDir, `${type}.ids`);
      fs.writeFileSync(idsFile, stepIds.join("\n"), "utf-8");
      const resultFile = path.join(workDir, `${type}.result.json`);
      let ok: boolean;
      let stepOutput = "";

      if (type === "model") {
        // Prefer offline models.json in staging; else live provision from source.
        const cmsDir = path.join(stagingBase, "cms");
        if (!opts.skipExport) {
          fs.mkdirSync(cmsDir, { recursive: true });
          const er = await runPackage(
            "cms-entries",
            ["export-models", "--out", cmsDir, "--models", stepIds.join(",")],
            `Export models (${stepIds.length})`,
            true
          );
          if (!er.ok) {
            stepOutput = er.output;
            ok = false;
          } else {
            const mr = await runPackage(
              "cms-entries",
              ["import-models", "--in", cmsDir, "--select", `@${idsFile}`, "--result", resultFile],
              `Import models from file (${stepIds.length})`,
              true
            );
            ok = mr.ok; stepOutput = (stepOutput ? stepOutput + "\n" : "") + mr.output;
          }
        } else {
          const modelsJson = path.join(cmsDir, "models.json");
          if (fs.existsSync(modelsJson)) {
            const mr = await runPackage(
              "cms-entries",
              ["import-models", "--in", cmsDir, "--select", `@${idsFile}`, "--result", resultFile],
              `Import models from file (${stepIds.length})`,
              true
            );
            ok = mr.ok; stepOutput = mr.output;
          } else {
            const mr = await runPackage(
              "cms-entries",
              ["models", "--provision", `@${idsFile}`, "--result", resultFile],
              `Provision models live (${stepIds.length})`,
              true
            );
            ok = mr.ok; stepOutput = mr.output;
          }
        }
      } else {
        const wiring = TYPE_WIRING[type];
        const outDir = path.join(stagingBase, wiring.sub);
        if (!opts.skipExport) {
          // Own the staging sub-dir for this run: wipe any leftover before export
          // so a re-export (or resume) starts clean — no stale/phantom files.
          // Keep models.json if present (written by the model step).
          if (type === "cms-entry" && fs.existsSync(path.join(outDir, "models.json"))) {
            const keep = fs.readFileSync(path.join(outDir, "models.json"));
            fs.rmSync(outDir, { recursive: true, force: true });
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, "models.json"), keep);
          } else {
            fs.rmSync(outDir, { recursive: true, force: true });
          }
          // Selective export via shared helper (pages/files/entries/redirects).
          const modelIdsForEntries =
            type === "cms-entry"
              ? run.items.filter((i) => i.type === "model").map((i) => i.id)
              : [];
          const selStep = selectiveExportStepFor(type as ArtifactType, stepIds, stagingBase, {
            schemaFile: opts.schemaFile,
            modelIdsForEntries,
            withBinaries: false,
            maxFileSize: opts.maxFileSize,
          });
          const exportArgs = selStep
            ? bindSelectiveExportIds([selStep], () => idsFile)[0].args
            : ["export", "--out", outDir, ...wiring.exp(opts.schemaFile)];
          const er = await runPackage(wiring.pkg, exportArgs, `Export — ${type}`, true);
          if (!er.ok) {
            const detail = errorTail(er.output);
            const logPath = writeStepLog(runsDir, run.id, `${type}-export`, er.output);
            console.error(`\n⛔  Export failed for ${type}${detail ? `: ${detail}` : ""}${logPath ? `\n     full log: ${path.relative(ROOT, logPath)}` : ""}${opts.continueOnError ? "\n     — skipping this type." : `\n     — aborting (resume with --resume ${run.id}).`}`);
            // Record the real reason on this type's items instead of leaving them pending.
            applyResults(run, stepIds.map((id) => ({ type, id, status: "error" as const, error: `export failed: ${detail || "see log"}${logPath ? ` (log: ${path.relative(ROOT, logPath)})` : ""}` })), now());
            saveRun(runsDir, run);
            if (!opts.continueOnError) { aborted = true; break; }
            continue;
          }
        }
        const ir = await runPackage(
          wiring.pkg,
          ["import", "--in", outDir, "--select", `@${idsFile}`, ...wiring.imp(opts.schemaFile),
           ...(type === "cms-entry" && opts.allowSchemaMismatch ? ["--allow-schema-mismatch"] : []),
           // file-manager, cms-entries, page-builder, redirects all accept this.
           ...(opts.allowFolderMismatch ? ["--allow-folder-mismatch"] : []),
           ...((type === "cms-entry" || type === "page") && opts.asDraft === false ? ["--no-as-draft"] : []),
           ...(type === "file" && opts.manifestOnly ? ["--manifest-only"] : []),
           ...(type === "file" && opts.streamBinaries ? ["--stream-binaries"] : []),
           ...(type === "file" && opts.maxFileSize ? ["--max-file-size", opts.maxFileSize] : []),
           "--result", resultFile],
          `Import — ${type} (${stepIds.length})`,
          true
        );
        ok = ir.ok; stepOutput = ir.output;
      }

      // Record per-item outcomes. A package that ran to completion writes a real
      // result file (per-item statuses + errors). If the step exited BEFORE that
      // (a pre-flight process.exit — missing model, schema mismatch, phantom stale
      // export, structure 504), no result file exists: fall back to the captured
      // stderr so the ledger shows the REAL reason, not a generic string, and dump
      // the full child stderr to a per-run log for the complete trace.
      let results: ItemResult[];
      if (fs.existsSync(resultFile)) {
        results = (JSON.parse(fs.readFileSync(resultFile, "utf-8")) as { items: ItemResult[] }).items;
      } else if (ok) {
        results = stepIds.map((id) => ({ type, id, status: "done" }));
      } else {
        const detail = errorTail(stepOutput);
        const logPath = writeStepLog(runsDir, run.id, `${type}-import`, stepOutput);
        const err = `${detail || "step failed with no result file"}${logPath ? ` (log: ${path.relative(ROOT, logPath)})` : ""}`;
        results = stepIds.map((id) => ({ type, id, status: "error" as const, error: err }));
      }

      // Reconcile: a selected id with no result row was never imported — almost
      // always a stale/mismatched export dir (e.g. skip-export reusing an old
      // export that lacks these ids). Mark it as an error so the run concludes
      // and the gap is visible, instead of leaving it pending forever.
      const seen = new Set(results.map((r) => r.id));
      const orphans = stepIds.filter((id) => !seen.has(id));
      if (orphans.length) {
        console.error(`\n  ⚠  ${orphans.length}/${stepIds.length} selected ${type}(s) were not in the export — re-export (disable --skip-export) so the selection matches.`);
        results = results.concat(
          orphans.map((id) => ({ type, id, status: "error" as const, error: "not found in export dir (stale/mismatched export — re-export without --skip-export)" }))
        );
      }

      applyResults(run, results, now());
      saveRun(runsDir, run);

      const errs = results.filter((r) => r.status === "error");
      for (const e of errs) emitEvent(runsDir, { ts: now(), type: "item.error", runId: run.id, scope: type, data: { id: e.id, error: e.error } });
      emitEvent(runsDir, { ts: now(), type: "step.end", runId: run.id, scope: type, data: { ok, count: results.length, errors: errs.length } });

      if (!ok) {
        console.error(`\n⛔  Import failed for ${type}${opts.continueOnError ? " — continuing with remaining types." : ` — aborting (resume with --resume ${run.id}).`}`);
        if (!opts.continueOnError) { aborted = true; break; }
      }
    }

    // Keep incomplete auto-staging so --resume --skip-export can reuse exports.
    // Never wipe the whole .migrate-tmp tree (other runs may still need theirs).
    if (shouldDeleteMigrateStaging({ autoStaging, status: run.status, aborted })) {
      fs.rmSync(workDir, { recursive: true, force: true });
    } else if (autoStaging) {
      console.log(`  📂 staging kept: ${path.relative(ROOT, workDir)}  (resume: migrate --resume ${run.id} --skip-export)`);
    } else {
      // Custom --in: drop only ephemeral ids/results under workDir (not user export).
      try {
        for (const name of fs.readdirSync(workDir)) {
          if (name.endsWith(".ids") || name.endsWith(".result.json")) {
            fs.rmSync(path.join(workDir, name), { force: true });
          }
        }
        if (fs.readdirSync(workDir).length === 0) fs.rmSync(workDir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
    emitEvent(runsDir, { ts: now(), type: "run.end", runId: run.id, data: { status: run.status, aborted } });

    const m = computeMetrics(run);
    console.log("\n" + "═".repeat(60));
    console.log(`  Run ${run.id} — ${run.status}`);
    console.log(`  done ${m.byStatus.done} · skipped ${m.byStatus.skipped} · error ${m.byStatus.error} · pending ${m.byStatus.pending}`);
    console.log(`  duration ${m.durationMs ?? "?"}ms · ${m.itemsPerSec ?? "?"} items/s · error-rate ${(m.errorRate * 100).toFixed(1)}%`);
    console.log(`  events: ${path.relative(ROOT, runsDir)}/${run.id}/events.jsonl`);
    if (aborted || run.status !== "complete") console.log(`  ↻  resume:  migrate --resume ${run.id}${autoStaging ? " --skip-export" : ""}`);
    console.log("═".repeat(60) + "\n");
    reportTimings("Migrate");
  });

// ─── purge ───────────────────────────────────────────────────────────────────

program
  .command("purge")
  .description("Delete selected artifacts on the target (dry-run unless --force); groups by type from a target catalog")
  .option("--catalog <file>", "Target catalog JSON (from catalog-all --env target)", "./target-catalog.json")
  .option("--select <ids>", "Ids to purge: comma/space-separated, or @file", "")
  .option("--force", "Actually delete (omit for dry-run preview)", false)
  .option("--permanent", "Hard delete where supported (unrecoverable)", false)
  .option("--allow-same-tenant", "Permit purging when TARGET_TENANT equals SOURCE_TENANT", false)
  .option("--continue-on-error", "Keep purging remaining types if one fails", false)
  .action(async (opts: {
    catalog: string;
    select: string;
    force: boolean;
    permanent: boolean;
    allowSameTenant: boolean;
    continueOnError: boolean;
  }) => {
    const catalogPath = path.resolve(ROOT, opts.catalog);
    if (!fs.existsSync(catalogPath)) {
      console.error(`❌ Catalog not found: ${catalogPath}\n   Run: catalog-all --env target --out target-catalog.json`);
      process.exit(1);
    }
    const ids = parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"));
    if (!ids.length) {
      console.error("❌ Provide --select <ids> (comma/space-separated, or @file).");
      process.exit(1);
    }

    if (opts.force) assertPurgeTargetSafe(opts.allowSameTenant);

    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as Catalog;
    const meta = new Map<string, { type: string; model?: string }>();
    for (const s of catalog.sections) {
      for (const it of s.items) {
        meta.set(it.id, { type: s.type, model: (it.metadata as { model?: string } | undefined)?.model });
      }
    }

    // Catalog "model" rows → cms-entries --models (never modelId in --select).
    const { byType, modelFullPurge, unknown } = groupPurgeSelection(ids, meta);
    if (byType.size === 0) {
      console.error("❌ None of the selected ids were found in the catalog.");
      process.exit(1);
    }
    if (unknown.length) console.warn(`⚠  ${unknown.length} id(s) not in catalog — ignored`);

    const tmpDir = path.join(ROOT, ".migrate-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });

    const { run: wsRun, restore: restoreLog } = openCliWorkstream(defaultLogsRoot(ROOT), "purge", {
      targetTenant: process.env["TARGET_TENANT"],
      argsSummary: `purge ${ids.length} ids${opts.force ? " --force" : " (dry-run)"}`,
    });
    wsRun.emitEvent("run.start", { types: [...byType.keys()], force: opts.force });

    const runsDir = workstreamRunsDir("purge");
    const now = () => new Date().toISOString();
    const seeds: Array<{ type: ArtifactType; id: string }> = [];
    for (const id of ids) {
      const m = meta.get(id);
      if (!m) continue;
      seeds.push({ type: m.type as ArtifactType, id });
    }
    const ledger = createRunFromItems(wsRun.meta.runId, ledgerEnv("target", wsRun.meta.targetTenant), seeds, now());
    saveRun(runsDir, ledger);

    console.log("\n🗑  Purge");
    console.log(`   Catalog : ${path.relative(ROOT, catalogPath)}`);
    console.log(`   Mode    : ${opts.force ? "EXECUTE" : "DRY RUN (pass --force to delete)"}`);
    console.log(`   Run id  : ${ledger.id}  (ledger: ${path.relative(ROOT, runsDir)}/)`);
    if (!opts.force) {
      console.log(purgeWarning(
        "selected artifacts on the target",
        process.env["TARGET_TENANT"] || "?",
        "This is a preview — nothing will be deleted until you pass --force."
      ));
    }

    const failed: string[] = [];
    const resultWorkDir = path.join(tmpDir, `purge-results-${ledger.id}`);
    fs.mkdirSync(resultWorkDir, { recursive: true });

    const applyPurgeOutcomes = (
      type: ArtifactType,
      stepIds: string[],
      ok: boolean,
      resultFile: string
    ): void => {
      let results = readResultFile(resultFile);
      if (!results.length) {
        results = synthesizePurgeResults(type, stepIds, !opts.force, [], !ok);
      } else {
        const seen = new Set(results.map((r) => r.id));
        const missing = stepIds.filter((id) => !seen.has(id));
        if (missing.length) {
          results = results.concat(synthesizePurgeResults(type, missing, !opts.force, [], !ok));
        }
      }
      applyResults(ledger, results, now());
      saveRun(runsDir, ledger);
    };

    const runPurgeStep = async (
      pkg: ArtifactPkg,
      args: string[],
      label: string,
      type: ArtifactType,
      stepIds: string[],
      resultTag: string
    ): Promise<boolean> => {
      const resultFile = path.join(resultWorkDir, `${resultTag}.result.json`);
      const ok = (await runPackage(pkg, [...args, "--result", resultFile], label)).ok;
      applyPurgeOutcomes(type, stepIds, ok, resultFile);
      if (!ok) {
        failed.push(label);
        if (!opts.continueOnError) {
          printLedgerSummary(ledger, runsDir);
          wsRun.finish("error", `failed at ${label}`);
          process.exit(1);
        }
        return false;
      }
      return true;
    };
    // --permanent is only implemented by cms-entries / page-builder (soft→bin/Trash).
    // file-manager and redirects always hard-delete and reject the unknown flag.
    const commonFlags = (pkg: ArtifactPkg): string[] => {
      const f: string[] = [];
      if (opts.force) f.push("--force");
      if (opts.permanent && (pkg === "cms-entries" || pkg === "page-builder")) f.push("--permanent");
      if (opts.allowSameTenant) f.push("--allow-same-tenant");
      return f;
    };

    try {
      for (const [type, g] of byType) {
        const pkg = PKG_FOR_TYPE[type];
        if (!pkg) continue;

        if (pkg === "cms-entries") {
          // Full-model wipes (catalog type=model) must not share --select with entry ids,
          // or --select would narrow away the other models' entries.
          const fullModels = [...modelFullPurge].filter((m) => g.models.has(m));
          if (fullModels.length) {
            const args = ["purge", "--all", "--models", fullModels.join(","), ...commonFlags(pkg)];
            await runPurgeStep(
              pkg, args, `Purge — cms-entry (all entries in ${fullModels.length} model(s))`,
              "model", fullModels, `cms-models`
            );
          }
          const entryIds = g.ids.filter((eid) => {
            const model = meta.get(eid)?.model;
            return !model || !modelFullPurge.has(model);
          });
          if (entryIds.length) {
            const idsFile = path.join(tmpDir, `purge-${type}.ids`);
            fs.writeFileSync(idsFile, entryIds.join("\n"), "utf-8");
            const entryModels = new Set(
              entryIds.map((eid) => meta.get(eid)?.model).filter((m): m is string => !!m)
            );
            const args = ["purge", "--all", "--select", `@${idsFile}`, ...commonFlags(pkg)];
            if (entryModels.size) args.push("--models", [...entryModels].join(","));
            await runPurgeStep(
              pkg, args, `Purge — cms-entry (${entryIds.length})`,
              "cms-entry", entryIds, `cms-entries`
            );
          }
          continue;
        }

        if (g.ids.length === 0) {
          console.warn(`⚠  Skipping ${type}: no selectable ids`);
          continue;
        }
        const idsFile = path.join(tmpDir, `purge-${type}.ids`);
        fs.writeFileSync(idsFile, g.ids.join("\n"), "utf-8");
        const args = ["purge", "--select", `@${idsFile}`, ...commonFlags(pkg)];
        if (pkg !== "page-builder") args.push("--all");

        await runPurgeStep(
          pkg, args, `Purge — ${type} (${g.ids.length})`,
          type as ArtifactType, g.ids, type
        );
      }
      console.log("\n" + "═".repeat(60));
      printLedgerSummary(ledger, runsDir);
      console.log("═".repeat(60));
      console.log(`  Logs: ${path.relative(ROOT, wsRun.dir)}`);
      wsRun.finish(failed.length ? "error" : "done", failed.length ? `${failed.length} step(s) failed` : undefined);
      if (failed.length) process.exit(1);
    } finally {
      try { fs.rmSync(resultWorkDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      restoreLog();
    }
  });

// ─── runs ────────────────────────────────────────────────────────────────────

program
  .command("runs")
  .description("List recorded audit ledgers (export/import/migrate/purge), or show one")
  .option("--runs-dir <dir>", "Primary ledger directory (default: .logs/migrate; others are still searched)", DEFAULT_MIGRATE_RUNS_DIR)
  .option("--show <id>", "Show items for a specific run", "")
  .action(async (opts: { runsDir: string; show: string }) => {
    const { primary: dir, fallbacks } = resolveAllLedgerDirs(opts.runsDir);
    if (opts.show) {
      const run = loadRunWithFallback(dir, opts.show, fallbacks);
      const m = computeMetrics(run);
      console.log(`\nRun ${run.id} — ${run.status} (${run.environment.role} tenant ${run.environment.tenant})`);
      console.log(`  created ${run.createdAt} · updated ${run.updatedAt}`);
      console.log(`  done ${m.byStatus.done} · skipped ${m.byStatus.skipped} · error ${m.byStatus.error} · pending ${m.byStatus.pending}`);
      console.log(`  duration ${m.durationMs ?? "?"}ms · ${m.itemsPerSec ?? "?"} items/s · error-rate ${(m.errorRate * 100).toFixed(1)}%\n`);
      for (const it of run.items) {
        const mark = it.status === "done" ? "✓" : it.status === "error" ? "✗" : it.status === "skipped" ? "•" : "·";
        console.log(`  ${mark} ${it.type.padEnd(10)} ${it.id}${it.action ? `  [${it.action}]` : ""}${it.error ? `  — ${it.error}` : ""}`);
      }
      console.log("");
    } else {
      const runs = listRuns(dir, fallbacks);
      if (!runs.length) { console.log(`\nNo ledgers under .logs/{migrate,import,export,purge}/ (or legacy .runs/)\n`); return; }
      console.log(`\n${runs.length} ledger(s) across workstreams (+ legacy .runs/ if any):`);
      for (const r of runs) {
        const s = runSummary(r);
        console.log(`  ${r.id}  ${r.status.padEnd(12)} done ${s.done} / err ${s.error} / pend ${s.pending}  ${r.createdAt}`);
      }
      console.log("");
    }
  });

// ─── metrics ─────────────────────────────────────────────────────────────────

program
  .command("metrics")
  .description("Aggregate metrics + error tracking across all recorded ledgers (all workstreams)")
  .option("--runs-dir <dir>", "Primary ledger directory (default: .logs/migrate; others are still searched)", DEFAULT_MIGRATE_RUNS_DIR)
  .action(async (opts: { runsDir: string }) => {
    const { primary: dir, fallbacks } = resolveAllLedgerDirs(opts.runsDir);
    const runs = listRuns(dir, fallbacks);
    const a = aggregateMetrics(runs);
    console.log("\n📊 Ledger Metrics");
    console.log("─".repeat(50));
    console.log(`  Runs           : ${a.runs} (${a.failedRuns} failed)`);
    console.log(`  Items          : ${a.items}  (done ${a.byStatus.done} · skipped ${a.byStatus.skipped} · error ${a.byStatus.error} · pending ${a.byStatus.pending})`);
    console.log(`  Error rate     : ${(a.errorRate * 100).toFixed(1)}%`);
    if (a.topErrors.length) {
      console.log("\n  Top errors:");
      for (const e of a.topErrors) console.log(`    ${String(e.count).padStart(4)} × ${e.error}`);
    }
    console.log("");
  });

// ─── serve ───────────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the local web UI — Export / Import / Migrate / Purge / Logs workspaces")
  .option("--port <n>", "Port", "4317")
  .option("--catalog <file>", "Catalog JSON to browse", "./catalog.json")
  .option("--schema-file <file>", "Offline model schema override (default: fetch live from source)", "")
  .option("--runs-dir <dir>", "Directory for migrate ledgers", DEFAULT_MIGRATE_RUNS_DIR)
  .action(async (opts: { port: string; catalog: string; schemaFile: string; runsDir: string }) => {
    startServer({
      root: ROOT,
      port: parseInt(opts.port, 10) || 4317,
      catalogPath: opts.catalog,
      schemaFile: opts.schemaFile,
      runsDir: opts.runsDir,
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
