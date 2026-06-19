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
 *   file-manager first (files must exist before CMS entries/pages reference them)
 *   cms-entries → page-builder → redirects (no strict dependency between these three)
 *
 * Configuration is consolidated: all packages read a single repo-root .env
 * (see .env.example). A per-package packages/<package>/.env is still honoured
 * as a fallback for any var the root .env does not set.
 */

import fs from "fs";
import { Command } from "commander";
import { spawnSync } from "child_process";
import path from "path";
import {
  loadRootEnv, buildCatalog, Catalog, CatalogSection, planMigration, parseSelection,
  createRun, saveRun, loadRun, listRuns, pendingItems, applyResults, runSummary,
  MigrationRun, ItemResult, TYPE_ORDER,
  emitEvent, computeMetrics, aggregateMetrics,
} from "@kibo-cms-clone-tool/shared";
import { startServer } from "./server";

// Consolidated config: load the repo-root .env once; child packages inherit it
// via the spawned process env and resolve the same root .env themselves.
loadRootEnv();

const ROOT = __dirname;

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

function runPackage(pkg: string, args: string[], label: string): boolean {
  const pkgDir = path.join(ROOT, "packages", pkg);

  console.log("\n" + "═".repeat(60));
  console.log(`  ▶  ${label}`);
  console.log("═".repeat(60) + "\n");

  const startedAt = Date.now();
  const result = spawnSync(
    "npx",
    ["ts-node", "--project", path.join(pkgDir, "tsconfig.json"), "index.ts", ...args],
    {
      cwd: pkgDir,
      stdio: "inherit",
      env: process.env,
      // shell:true is required on Windows, where `npx` is a .cmd that spawnSync
      // cannot execute directly. Harmless on POSIX.
      shell: true,
    }
  );

  const ms = Date.now() - startedAt;
  const ok = result.status === 0;
  STEP_TIMINGS.push({ label, ms, ok });

  if (!ok) {
    console.error(`\n❌  ${label} failed (exit code ${result.status ?? "unknown"}) after ${(ms / 1000).toFixed(1)}s`);
    return false;
  }

  console.log(`\n  ⏱  ${label} took ${(ms / 1000).toFixed(1)}s`);
  return true;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("kibo-cms-clone-tool")
  .description("Kibo CMS Clone Tool — run all packages in sequence");

// ─── export-all ──────────────────────────────────────────────────────────────

program
  .command("export-all")
  .description("Export all content types from source in the correct order (file-manager → cms-entries → page-builder → redirects)")
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
    "Only export CMS entries where siteId matches",
    process.env["SITE_ID_FILTER"] ?? ""
  )
  .option("--locale <locale>", "Locale to export (e.g. en-US)", process.env["LOCALE"] ?? "en-US")
  .option("--tags <tags>", "Only export files with these tags (comma-sep, file-manager only)", process.env["TAGS_FILTER"] ?? "")
  .option("--out <base>", "Base output directory — sub-dirs files/, cms/, pages/, redirects/ are created automatically", "./export")
  .option(
    "--skip <packages>",
    "Comma-separated packages to skip, e.g. file-manager,redirects",
    ""
  )
  .option("--continue-on-error", "Keep going if a package fails (else stop at the first failure)", false)
  .action((opts: {
    schemaFile: string;
    models: string;
    siteId: string;
    locale: string;
    tags: string;
    out: string;
    skip: string;
    continueOnError: boolean;
  }) => {
    const skip = new Set(opts.skip.split(",").map((s) => s.trim()).filter(Boolean));

    type Step = { pkg: string; label: string; args: string[] };
    const steps: Step[] = [];

    if (!skip.has("file-manager")) {
      steps.push({
        pkg: "file-manager",
        label: "Step 1/4 — File Manager",
        args: [
          "export",
          "--out", `${opts.out}/files`,
          ...(opts.tags ? ["--tags", opts.tags] : []),
        ],
      });
    }

    if (!skip.has("cms-entries")) {
      steps.push({
        pkg: "cms-entries",
        label: "Step 2/4 — CMS Entries",
        args: [
          "export",
          "--out", `${opts.out}/cms`,
          "--locale", opts.locale,
          // No flag → cms-entries exports ALL models. Pass through whichever was given.
          ...(opts.schemaFile
            ? ["--schema-file", opts.schemaFile]
            : opts.models
            ? ["--models", opts.models]
            : []),
          ...(opts.siteId ? ["--site-id", opts.siteId] : []),
        ],
      });
    }

    if (!skip.has("page-builder")) {
      steps.push({
        pkg: "page-builder",
        label: "Step 3/4 — Page Builder",
        args: ["export", "--out", `${opts.out}/pages`, "--locale", opts.locale],
      });
    }

    if (!skip.has("redirects")) {
      steps.push({
        pkg: "redirects",
        label: "Step 4/4 — Redirects",
        args: ["export", "--out", `${opts.out}/redirects`],
      });
    }

    console.log("\n🚀  Kibo CMS Clone Tool — Export All");
    console.log(`   Packages  : ${steps.map((s) => s.pkg).join(" → ")}`);
    console.log(`   Output    : ${opts.out}/{files,cms,pages,redirects}`);

    // Export packages are independent — with --continue-on-error a failure in one
    // (e.g. files "Not authorized") doesn't block the others; without it, stop at
    // the first failure.
    const failed: string[] = [];
    for (const step of steps) {
      if (runPackage(step.pkg, step.args, step.label)) continue;
      failed.push(step.label);
      if (!opts.continueOnError) {
        console.error("\n⛔  Export stopped at the step above. Pass --continue-on-error to skip past failures.\n");
        reportTimings("Export All");
        process.exit(1);
      }
    }

    console.log("\n" + "═".repeat(60));
    console.log(failed.length ? `  ⚠  Export finished with ${failed.length} failed step(s)` : "  ✅  All exports complete!");
    for (const f of failed) console.log(`     ✗ ${f}`);
    console.log("═".repeat(60));
    reportTimings("Export All");
    console.log("  Review / edit the JSON files in each sub-directory, then run:");
    console.log(`  npx ts-node index.ts import-all --in ${opts.out}\n`);
    if (failed.length === steps.length) process.exit(1); // all failed → error exit
  });

// ─── import-all ──────────────────────────────────────────────────────────────

program
  .command("import-all")
  .description("Import all content types to target in the correct order (file-manager → cms-entries → page-builder → redirects)")
  .option("--in <base>", "Base input directory containing files/, cms/, pages/, redirects/", "./export")
  .option("--locale <locale>", "Locale header for target API", process.env["LOCALE"] ?? "en-US")
  .option("--dry-run", "Preview without writing to target", process.env["DRY_RUN"] === "true")
  .option("--allow-folder-mismatch", "Import even if some folders failed to sync (items fall back to root)", false)
  .option("--select <ids>", "Import only these item ids (comma-separated or @file). Default: all in the folder", "")
  .option("--continue-on-error", "Keep going if a package fails (else stop at the first failure)", false)
  .option(
    "--skip <packages>",
    "Comma-separated packages to skip, e.g. file-manager,redirects",
    ""
  )
  .action((opts: {
    in: string;
    locale: string;
    dryRun: boolean;
    allowFolderMismatch: boolean;
    select: string;
    continueOnError: boolean;
    skip: string;
  }) => {
    const skip = new Set(opts.skip.split(",").map((s) => s.trim()).filter(Boolean));
    const dryFlags = opts.dryRun ? ["--dry-run"] : [];
    const folderFlags = opts.allowFolderMismatch ? ["--allow-folder-mismatch"] : [];
    // Item ids don't collide across types (entryId / src|key / path / redirectFrom),
    // so the same selection passed to every package's --select filters to its own.
    const selectFlags = opts.select ? ["--select", opts.select] : [];

    type Step = { pkg: string; sub: string; label: string; args: string[] };
    const steps: Step[] = [];

    if (!skip.has("file-manager")) {
      steps.push({
        pkg: "file-manager", sub: "files",
        label: "Step 1/4 — File Manager",
        args: ["import", "--in", `${opts.in}/files`, ...dryFlags, ...folderFlags, ...selectFlags],
      });
    }

    if (!skip.has("cms-entries")) {
      steps.push({
        pkg: "cms-entries", sub: "cms",
        label: "Step 2/4 — CMS Entries",
        args: ["import", "--in", `${opts.in}/cms`, "--locale", opts.locale, ...dryFlags, ...folderFlags, ...selectFlags],
      });
    }

    if (!skip.has("page-builder")) {
      steps.push({
        pkg: "page-builder", sub: "pages",
        label: "Step 3/4 — Page Builder",
        args: ["import", "--in", `${opts.in}/pages`, "--locale", opts.locale, ...dryFlags, ...folderFlags, ...selectFlags],
      });
    }

    if (!skip.has("redirects")) {
      steps.push({
        pkg: "redirects", sub: "redirects",
        label: "Step 4/4 — Redirects",
        args: ["import", "--in", `${opts.in}/redirects`, ...dryFlags, ...folderFlags, ...selectFlags],
      });
    }

    // Skip any artifact whose input sub-dir isn't in this export folder — the
    // folder may only contain a subset (e.g. a files-only export). Missing ≠ error.
    const runnable: Step[] = [];
    for (const s of steps) {
      if (fs.existsSync(`${opts.in}/${s.sub}`)) runnable.push(s);
      else console.log(`   ⏭  Skipping ${s.pkg} — no '${s.sub}/' in ${opts.in}`);
    }

    console.log("\n🚀  Kibo CMS Clone Tool — Import All");
    console.log(`   Packages  : ${runnable.map((s) => s.pkg).join(" → ") || "(none — empty export folder)"}`);
    console.log(`   Input     : ${opts.in}/{files,cms,pages,redirects}`);
    console.log(`   Dry Run   : ${opts.dryRun}`);
    if (opts.dryRun) {
      console.log("\n  ⚠   DRY RUN — remove --dry-run to execute writes");
    }

    const importFailed: string[] = [];
    for (const step of runnable) {
      if (runPackage(step.pkg, step.args, step.label)) continue;
      importFailed.push(step.label);
      if (!opts.continueOnError) {
        console.error("\n⛔  Import stopped at the step above. Pass --continue-on-error to skip past failures, or fix and re-run.\n");
        reportTimings("Import All");
        process.exit(1);
      }
    }
    if (importFailed.length) { console.warn(`\n  ⚠  ${importFailed.length} step(s) failed:`); for (const f of importFailed) console.warn(`     ✗ ${f}`); }

    console.log("\n" + "═".repeat(60));
    if (opts.dryRun) {
      console.log("  ✅  Dry run complete — no changes made.");
      console.log("═".repeat(60));
      console.log("\n  Re-run without --dry-run to execute.\n");
    } else {
      console.log("  ✅  All imports complete!");
      console.log("═".repeat(60));
      console.log("\n  Next steps:");
      console.log("  1. Share packages/file-manager/s3-copy-manifest.txt with your AWS admin");
      console.log("  2. Verify content counts and spot-check records in target");
      console.log("  3. Rebuild navigation menus manually in the target admin\n");
    }
    reportTimings("Import All");
  });

// ─── catalog-all ───────────────────────────────────────────────────────────────

program
  .command("catalog-all")
  .description("Build one combined catalog of all artifact types (files, cms-entries, pages, redirects) for an environment")
  .option("--env <role>", "Environment to read: source | target", "source")
  .option("--schema-file <file>", "Offline model schema override (default: introspect live)", "")
  .option("--out <file>", "Merged catalog JSON output", "./catalog.json")
  .option("--skip <packages>", "Comma-separated packages to skip", "")
  .action((opts: { env: string; schemaFile: string; out: string; skip: string }) => {
    const skip = new Set(opts.skip.split(",").map((s) => s.trim()).filter(Boolean));
    const tmpDir = path.join(ROOT, ".catalog-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });

    type Step = { pkg: string; label: string; args: string[]; file: string };
    const steps: Step[] = [];
    const add = (pkg: string, extra: string[] = []) => {
      const file = path.join(tmpDir, `${pkg}.json`);
      steps.push({ pkg, label: pkg, args: ["catalog", "--env", opts.env, "--out", file, ...extra], file });
    };

    if (!skip.has("file-manager")) add("file-manager");
    if (!skip.has("cms-entries")) {
      // With a schema file, use it; otherwise introspect models live from the env.
      add("cms-entries", opts.schemaFile ? ["--schema-file", opts.schemaFile] : ["--models", "ALL"]);
    }
    if (!skip.has("page-builder")) add("page-builder");
    if (!skip.has("redirects")) add("redirects");

    console.log("\n🗂️  Catalog All");
    console.log(`   Environment : ${opts.env}`);
    console.log(`   Types       : ${steps.map((s) => s.pkg).join(", ")}`);

    const sections: CatalogSection[] = [];
    let environment: Catalog["environment"] | null = null;

    for (const step of steps) {
      const ok = runPackage(step.pkg, step.args, `Catalog — ${step.label}`);
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
  .action((opts: { catalog: string; select: string; out: string }) => {
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
  "file":      { pkg: "file-manager", sub: "files",     exp: () => [], imp: () => [] },
  "cms-entry": { pkg: "cms-entries",  sub: "cms",       exp: (sf) => (sf ? ["--schema-file", sf] : []), imp: (sf) => [...(sf ? ["--schema-file", sf] : []), "--create-missing-model"] },
  "page":      { pkg: "page-builder", sub: "pages",     exp: () => [], imp: () => [] },
  "redirect":  { pkg: "redirects",    sub: "redirects", exp: () => [], imp: () => [] },
};

program
  .command("migrate")
  .description("Execute a dependency-ordered migration of selected artifacts (source → target), recording a resumable run")
  .option("--catalog <file>", "Catalog JSON (from catalog-all)", "./catalog.json")
  .option("--select <ids>", "Selected ids: comma/space-separated, or @file", "")
  .option("--in <base>", "Export staging dir (sub-dirs files/, cms/, pages/, redirects/)", "./export")
  .option("--schema-file <file>", "Offline model schema override (default: fetch live from source)", "")
  .option("--dry-run", "Preview the plan without writing or recording a run", process.env["DRY_RUN"] === "true")
  .option("--skip-export", "Reuse the existing export staging dir instead of re-exporting from source", false)
  .option("--resume <runId>", "Resume a previous run — re-run only items not yet done", "")
  .option("--runs-dir <dir>", "Directory for run ledgers", ".runs")
  .option("--allow-schema-mismatch", "Import entries even if a target model is field-incompatible with source", false)
  .option("--allow-folder-mismatch", "Import items even if some folders failed to sync (they fall back to root)", false)
  .option("--continue-on-error", "Keep migrating remaining types if one fails (else stop; resume later)", false)
  .action((opts: { catalog: string; select: string; in: string; schemaFile: string; dryRun: boolean; skipExport: boolean; resume: string; runsDir: string; allowSchemaMismatch: boolean; allowFolderMismatch: boolean; continueOnError: boolean }) => {
    const runsDir = path.join(ROOT, opts.runsDir || ".runs");
    const now = () => new Date().toISOString();

    let run: MigrationRun;

    if (opts.resume) {
      run = loadRun(runsDir, opts.resume);
      const s = runSummary(run);
      console.log(`\n🚚 Migrate — resuming ${run.id}`);
      console.log(`   Status: done ${s.done}, pending ${s.pending}, error ${s.error}, skipped ${s.skipped}`);
    } else {
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

      console.log("\n🚚 Migrate");
      console.log(`   Selected ${plan.selectedCount} → ${plan.resolvedCount} after deps`);
      console.log(`   Order: ${plan.steps.map((s) => `${s.type}(${s.ids.length})`).join(" → ")}`);
      if (plan.unknownIds.length) console.log(`   ⚠  ${plan.unknownIds.length} unknown id(s) ignored`);

      if (opts.dryRun) {
        console.log("   ⚠  DRY RUN — no target writes, no run recorded.\n");
        return;
      }

      const id = "run-" + now().replace(/[:.]/g, "-");
      run = createRun(id, catalog.environment, plan, now());
      saveRun(runsDir, run);
      console.log(`   Run id: ${run.id}  (ledger: ${path.relative(ROOT, runsDir)}/)`);
    }

    const tmpDir = path.join(ROOT, ".migrate-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
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

      const idsFile = path.join(tmpDir, `${type}.ids`);
      fs.writeFileSync(idsFile, stepIds.join("\n"), "utf-8");
      const resultFile = path.join(tmpDir, `${type}.result.json`);
      let ok: boolean;

      if (type === "model") {
        // Provision models source → target (fetches full defs live from source).
        ok = runPackage("cms-entries", ["models", "--provision", `@${idsFile}`, "--result", resultFile], `Provision models (${stepIds.length})`);
      } else {
        const wiring = TYPE_WIRING[type];
        const outDir = `${opts.in}/${wiring.sub}`;
        if (!opts.skipExport) {
          const exportOk = runPackage(wiring.pkg, ["export", "--out", outDir, ...wiring.exp(opts.schemaFile)], `Export — ${type}`);
          if (!exportOk) {
            console.error(`\n⛔  Export failed for ${type}${opts.continueOnError ? " — skipping this type." : ` — aborting (resume with --resume ${run.id}).`}`);
            if (!opts.continueOnError) { aborted = true; break; }
            continue;
          }
        }
        ok = runPackage(
          wiring.pkg,
          ["import", "--in", outDir, "--select", `@${idsFile}`, ...wiring.imp(opts.schemaFile),
           ...(type === "cms-entry" && opts.allowSchemaMismatch ? ["--allow-schema-mismatch"] : []),
           // file-manager, cms-entries, page-builder, redirects all accept this.
           ...(opts.allowFolderMismatch ? ["--allow-folder-mismatch"] : []), "--result", resultFile],
          `Import — ${type} (${stepIds.length})`
        );
      }

      // Record per-item outcomes. cms-entries writes a real result file; other
      // types are recorded coarsely from the step exit code (per-item result
      // emission for them is a follow-on).
      let results: ItemResult[];
      if (fs.existsSync(resultFile)) {
        results = (JSON.parse(fs.readFileSync(resultFile, "utf-8")) as { items: ItemResult[] }).items;
      } else {
        results = stepIds.map((id) => ({ type, id, status: ok ? "done" : "error", error: ok ? undefined : "import step failed" }));
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

    fs.rmSync(tmpDir, { recursive: true, force: true });
    emitEvent(runsDir, { ts: now(), type: "run.end", runId: run.id, data: { status: run.status, aborted } });

    const m = computeMetrics(run);
    console.log("\n" + "═".repeat(60));
    console.log(`  Run ${run.id} — ${run.status}`);
    console.log(`  done ${m.byStatus.done} · skipped ${m.byStatus.skipped} · error ${m.byStatus.error} · pending ${m.byStatus.pending}`);
    console.log(`  duration ${m.durationMs ?? "?"}ms · ${m.itemsPerSec ?? "?"} items/s · error-rate ${(m.errorRate * 100).toFixed(1)}%`);
    console.log(`  events: ${path.relative(ROOT, runsDir)}/${run.id}.events.jsonl`);
    if (aborted) console.log(`  ↻  resume:  migrate --resume ${run.id}`);
    console.log("═".repeat(60) + "\n");
    reportTimings("Migrate");
  });

// ─── runs ────────────────────────────────────────────────────────────────────

program
  .command("runs")
  .description("List recorded migration runs, or show one (the audit ledger)")
  .option("--runs-dir <dir>", "Directory for run ledgers", ".runs")
  .option("--show <id>", "Show items for a specific run", "")
  .action((opts: { runsDir: string; show: string }) => {
    const dir = path.join(ROOT, opts.runsDir || ".runs");
    if (opts.show) {
      const run = loadRun(dir, opts.show);
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
      const runs = listRuns(dir);
      if (!runs.length) { console.log(`\nNo runs in ${path.relative(ROOT, dir)}/\n`); return; }
      console.log(`\n${runs.length} run(s) in ${path.relative(ROOT, dir)}/:`);
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
  .description("Aggregate metrics + error tracking across all recorded runs")
  .option("--runs-dir <dir>", "Directory for run ledgers", ".runs")
  .action((opts: { runsDir: string }) => {
    const dir = path.join(ROOT, opts.runsDir || ".runs");
    const runs = listRuns(dir);
    const a = aggregateMetrics(runs);
    console.log("\n📊 Migration Metrics");
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
  .description("Start the local web UI — Export / Import / Copy / Logs workspaces")
  .option("--port <n>", "Port", "4317")
  .option("--catalog <file>", "Catalog JSON to browse", "./catalog.json")
  .option("--schema-file <file>", "Offline model schema override (default: fetch live from source)", "")
  .option("--runs-dir <dir>", "Directory for run ledgers", ".runs")
  .action((opts: { port: string; catalog: string; schemaFile: string; runsDir: string }) => {
    startServer({
      root: ROOT,
      port: parseInt(opts.port, 10) || 4317,
      catalogPath: opts.catalog,
      schemaFile: opts.schemaFile,
      runsDir: opts.runsDir,
    });
  });

program.parse(process.argv);
