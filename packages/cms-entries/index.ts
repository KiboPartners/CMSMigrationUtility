/**
 * CMS Entries Migrator — Entry Point
 *
 * Two-step workflow:
 *
 *   Step 1 — Export (pull from source to local JSON files):
 *     npx ts-node index.ts export --schema-file ./cms-schema.json
 *     npx ts-node index.ts export --schema-file ./cms-schema.json --site-id kibo-us
 *
 *   Step 2 — Inspect / edit exported JSON files, then import:
 *     npx ts-node index.ts import --in ./export/cms --dry-run
 *     npx ts-node index.ts import --in ./export/cms
 */

import fs from "fs";
import pLimit from "p-limit";
import { Command } from "commander";
import {
  loadRootEnv, typeFieldNames, createClient, resolveEnvironment,
  buildCatalog, catalogSize, EnvRole, parseSelection, assertPurgeTargetSafe, purgeWarning,
} from "@kibo-cms-clone-tool/shared";
import { loadExportConfig, loadImportConfig } from "./src/config";
import { introspectModels } from "./src/introspect";
import { loadSchemaFile } from "./src/schema";
import { exportModel } from "./src/export";
import { importModelFile, readExportFiles, buildModelsFromExportFiles, ModelCloneResult } from "./src/clone";
import { loadRawModels, ensureModelsProvisioned, ensureModelProvisioned, fetchSourceModelDefs, listSourceModels, diffModelFields, RawModel } from "./src/provision";
import { fetchSourceStructure, importStructure, waitForModelMutations } from "./src/structure";
import { catalogEntries, catalogModels } from "./src/catalog";
import { printSummary, writeErrorReport } from "./src/report";
import {
  purgeFromExportFiles,
  purgeAllEntries,
  printPurgeSummary,
  writePurgeErrorReport,
} from "./src/purge";

loadRootEnv();

const program = new Command();

program
  .name("cms-entries")
  .description("CMS Entries Clone Tool — export from source, clone to target");

// ─── export subcommand ────────────────────────────────────────────────────────

program
  .command("export")
  .description("Export CMS entries from source environment to local JSON files")
  .option("--schema-file <file>", "Offline model schema override (default: introspect live from source)", "")
  .option("--models <models>", "Comma-separated model names (used when --schema-file is not set)", process.env["MODELS"] ?? "")
  .option("--locale <locale>", "Locale to export (e.g. en-US)", process.env["LOCALE"] ?? "en-US")
  .option("--site-id <siteId>", "Only export entries where siteId matches", process.env["SITE_ID_FILTER"] ?? "")
  .option("--out <dir>", "Output directory for JSON files", "./export/cms")
  .option("--debug", "Print generated query and variables for each model")
  .action(async (opts: { schemaFile: string; models: string; locale: string; siteId: string; out: string; debug: boolean }) => {
    // No --schema-file / --models → export every (non-system) model from source.
    if (!opts.schemaFile && !opts.models) {
      console.log("  No --schema-file/--models given — exporting ALL models from source.");
    }
    const config = loadExportConfig({ ...opts, models: opts.models || "ALL" });

    console.log("\n📤 CMS Entries — Export");
    console.log("─".repeat(40));
    console.log(`  Source Manage: ${config.sourceManageUrl}`);
    if (opts.schemaFile) {
      console.log(`  Schema file  : ${opts.schemaFile}`);
    }
    console.log(`  Locale       : ${config.locale}`);
    console.log(`  Out dir      : ${config.outDir}`);
    if (config.siteIdFilter) console.log(`  Site ID      : ${config.siteIdFilter}`);
    console.log("─".repeat(40));

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const sourceClient = createClient(resolveEnvironment("source", { requireManage: true }), {
      useManage: true,
      locale: config.locale,
      rateLimit: config.rateLimitDelay,
      debug: config.debug,
    });

    // Admin client (folder tree / aco lives on the Admin endpoint, not Manage).
    const sourceAdminClient = createClient(resolveEnvironment("source"), {
      locale: config.locale,
      rateLimit: config.rateLimitDelay,
      debug: config.debug,
    });

    let models: Map<string, import("./src/introspect").ModelDefinition>;

    if (opts.schemaFile) {
      console.log("\n📄 Loading models from schema file...");
      models = loadSchemaFile(opts.schemaFile, config.models);
      console.log(`  Found ${models.size} model(s): ${[...models.keys()].join(", ")}`);
    } else {
      console.log("\n🔍 Introspecting models from source...");
      models = await introspectModels(sourceClient, config.models, sourceAdminClient);
      console.log(`  Found ${models.size} model(s): ${[...models.keys()].join(", ")}`);
    }

    if (models.size === 0) {
      console.error("\n❌ No matching models found.");
      process.exit(1);
    }

    const summary: Array<{ model: string; count: number; file: string }> = [];

    // Export models in parallel — each does several introspection round-trips
    // (often for 0-entry models), so wall-clock is dominated by latency, not CPU.
    // The adaptive per-tenant throttle still backs off if the server pushes back.
    const exportConcurrency = Math.max(1, parseInt(process.env["EXPORT_CONCURRENCY"] ?? process.env["CONCURRENCY"] ?? "6", 10) || 6);
    const limit = pLimit(exportConcurrency);
    const allModels = [...models.values()];
    const failures: Array<{ model: string; error: string }> = [];
    let done = 0;
    console.log(`\n  Exporting ${allModels.length} model(s) (concurrency ${exportConcurrency})...`);
    await Promise.all(
      allModels.map((model) =>
        limit(async () => {
          // A single model failing (not on this tenant, transient, corrupt) must
          // not abort the whole batch — record it and move on.
          try {
            const count = await exportModel(sourceClient, model, config, sourceAdminClient);
            summary.push({ model: model.name, count, file: `${config.outDir}/${model.name}.json` });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const notOnTenant = /Cannot query field "list\w+" on type "Query"/.test(msg);
            failures.push({ model: model.name, error: notOnTenant ? "model not present on this tenant" : msg });
          }
          done++;
          process.stdout.write(`\r  Exported ${done}/${allModels.length} model(s)…   `);
        })
      )
    );
    process.stdout.write("\n");
    summary.sort((a, b) => a.model.localeCompare(b.model));

    if (failures.length) {
      console.warn(`\n  ⚠  ${failures.length} model(s) skipped:`);
      for (const f of failures) console.warn(`     - ${f.model}: ${f.error}`);
      // Abort only when nothing exported at all (likely a systemic problem,
      // e.g. a stale --schema-file that matches no model on the tenant).
      if (summary.length === 0) {
        console.error("\n❌ No models could be exported. If you passed --schema-file, it may not match this tenant — omit it to introspect live.");
        process.exit(1);
      }
    }

    console.log("\n✅ Export complete:");
    for (const s of summary) {
      console.log(`   ${s.model.padEnd(20)} ${String(s.count).padStart(5)} entries  →  ${s.file}`);
    }
    console.log("\n   Review / edit the JSON files, then run:");
    console.log(`   npx ts-node index.ts import --in ${config.outDir}\n`);
  });

// ─── import subcommand ────────────────────────────────────────────────────────

program
  .command("import")
  .description("Import CMS entries from local JSON files into target environment")
  .option("--in <dir>", "Directory containing exported JSON files", "./export/cms")
  .option("--locale <locale>", "Locale header for target API", process.env["LOCALE"] ?? "en-US")
  .option("--concurrency <n>", "Parallel writes to target", process.env["CONCURRENCY"] ?? "5")
  .option("--dry-run", "Preview without writing to target", process.env["DRY_RUN"] === "true")
  .option("--create-missing-model", "Auto-create models absent on target (fetched live from source unless --schema-file is given)", false)
  .option("--schema-file <file>", "Offline model schema override (default: fetch live from source)", "")
  .option("--select <ids>", "Import only these entryIds (comma-separated, or @file). Default: all", "")
  .option("--result <file>", "Write per-item results JSON (for the run ledger)", "")
  .option("--allow-schema-mismatch", "Proceed even if the target model schema is incompatible with the source", false)
  .option("--allow-folder-mismatch", "Import even if some folders failed to sync (entries fall back to root)", false)
  .action(async (opts: { in: string; locale: string; concurrency: string; dryRun: boolean; createMissingModel: boolean; schemaFile: string; select: string; result: string; allowSchemaMismatch: boolean; allowFolderMismatch: boolean }) => {
    const config = loadImportConfig({ dir: opts.in, locale: opts.locale, concurrency: opts.concurrency, dryRun: opts.dryRun, allowFolderMismatch: opts.allowFolderMismatch });

    // Optional selective import: keep only entries whose entryId is selected.
    const selection = opts.select ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"))) : null;
    const entryKey = (e: Record<string, unknown>) =>
      String(e["entryId"] ?? e["id"] ?? "").split("#")[0];

    console.log("\n📥 CMS Entries — Import");
    console.log("─".repeat(40));
    console.log(`  Target Manage: ${config.targetManageUrl}`);
    console.log(`  Source dir   : ${config.dir}`);
    console.log(`  Concurrency  : ${config.concurrency}`);
    console.log(`  Dry Run      : ${config.dryRun}`);
    if (config.sourceCdnDomain && config.targetCdnDomain) {
      console.log(`  CDN Rewrite  : ${config.sourceCdnDomain} → ${config.targetCdnDomain}`);
    }
    console.log("─".repeat(40));

    const allExportFiles = readExportFiles(config.dir);
    // Apply selective import filter (if any) to each file's entries.
    const exportFiles = selection
      ? allExportFiles.map((f) => ({ ...f, entries: f.entries.filter((e) => selection.has(entryKey(e))) }))
      : allExportFiles;
    if (selection) {
      const kept = exportFiles.reduce((n, f) => n + f.entries.length, 0);
      console.log(`\n  Selection: ${selection.size} id(s) → importing ${kept} matching entry(ies)`);
    }
    console.log(`\n  Found ${exportFiles.length} export file(s): ${exportFiles.map((f) => f.modelName).join(", ")}`);

    // Reconstruct ModelDefinitions directly from saved schemas — no target
    // introspection needed.  The schema was captured at export time and includes
    // all operation names and field definitions.
    const models = buildModelsFromExportFiles(exportFiles);

    for (const f of exportFiles) {
      if (!models.has(f.modelName)) {
        console.warn(`\n⚠  No saved schema for "${f.modelName}" — skipping (re-export to fix)`);
      }
    }

    if (models.size === 0) {
      console.error("\n❌ No models could be loaded from export files.");
      process.exit(1);
    }

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const targetClient = createClient(resolveEnvironment("target", { requireManage: true }), {
      useManage: true,
      locale: config.locale,
      rateLimit: config.rateLimitDelay,
      debug: config.debug,
    });
    // Admin endpoint client — folder tree (aco) lives here, not on Manage.
    const targetAdminClient = createClient(resolveEnvironment("target"), {
      locale: config.locale,
      rateLimit: config.rateLimitDelay,
      debug: config.debug,
    });

    process.stdout.write("\n  Verifying target endpoint...");
    await targetClient.ping();
    console.log(" ✓");

    // ── Clone content-model structure (source → target) before entries ──
    // Entries can't import until their models exist AND the per-model schema has
    // regenerated. Pull the structure live from source via exportStructure and
    // apply it to the target via importStructure (its inverse), then wait for the
    // generated create<Model> mutations to appear. This runs ahead of the
    // pre-flight below, which then simply confirms the models are present.
    if (!config.dryRun) {
      try {
        const structSourceClient = createClient(resolveEnvironment("source", { requireManage: true }), {
          useManage: true,
          locale: config.locale,
          rateLimit: config.rateLimitDelay,
          debug: config.debug,
        });
        console.log("\n🏗  Cloning content-model structure (source → target)…");
        // Scope to the models actually being imported (from the export files) —
        // not the entire source structure. exportStructure still pulls in any
        // models these reference, so dependencies are covered.
        const wantedModelIds = [...models.values()].map((m) => m.modelId);
        const structure = await fetchSourceStructure(structSourceClient, wantedModelIds);
        console.log(`   Source structure: ${structure.groups.length} group(s), ${structure.models.length} model(s)`);

        const res = await importStructure(targetClient, structure);
        for (const g of res.groups) console.log(`   group ${g.name.padEnd(24)} ${g.action}${g.error ? `  ❌ ${g.error}` : ""}`);
        for (const m of res.models) console.log(`   model ${m.name.padEnd(24)} ${m.action}${m.error ? `  ❌ ${m.error}` : ""}`);
        if (res.message) console.log(`   ${res.message}`);

        const createOps = [...models.values()].map((m) => m.createOperation);
        process.stdout.write("   Waiting for target schema to regenerate…");
        const stillMissing = await waitForModelMutations(targetClient, createOps, {
          onTick: (waited) => process.stdout.write(`\r   Waiting for target schema to regenerate… ${Math.round(waited / 1000)}s`),
        });
        console.log(stillMissing.length ? `\n   ⚠  Still missing after wait: ${stillMissing.join(", ")}` : "  ✓");
      } catch (e) {
        // Non-fatal: the pre-flight below will catch any models that are still
        // missing and either provision them (--create-missing-model) or fail.
        console.error(`\n⚠  Structure clone failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // ── Pre-flight: ensure each model's generated mutations exist on target ──
    // Kibo CMS only generates create<Model>/<Model>Input once the model is defined.
    // Importing into an environment that lacks the model fails per-entry; detect
    // it up front and either provision (--create-missing-model) or fail fast.
    if (!config.dryRun) {
      const available = new Set(await typeFieldNames(targetClient));
      const missing = [...models.values()].filter((m) => !available.has(m.createOperation));

      if (missing.length > 0) {
        const names = missing.map((m) => m.name).join(", ");
        if (opts.createMissingModel) {
          console.log(`\n🧩 Provisioning ${missing.length} missing model(s) on target: ${names}`);
          // Model defs come from --schema-file if given, otherwise fetched LIVE
          // from the source Manage API (no manual export needed).
          let rawModels;
          if (opts.schemaFile) {
            rawModels = loadRawModels(opts.schemaFile);
          } else {
            console.log("   Fetching model definitions from source…");
            const sourceClient = createClient(resolveEnvironment("source", { requireManage: true }), { useManage: true, locale: opts.locale, rateLimit: config.rateLimitDelay, debug: config.debug });
            rawModels = await fetchSourceModelDefs(sourceClient, missing.map((m) => m.modelId));
          }
          const provisionResults = await ensureModelsProvisioned(
            targetClient,
            rawModels,
            missing.map((m) => m.modelId),
            { onEvent: (e) => console.log(`   [${e.model}] ${e.message}`) }
          );
          for (const r of provisionResults) {
            const mark = r.action === "created" ? "✓ created" : r.action === "already-exists" ? "• exists" : `❌ ${r.action}`;
            console.log(`   ${mark}  ${r.model}${r.error ? ` — ${r.error}` : ""}`);
          }
          const failed = provisionResults.filter((r) => r.action === "failed" || r.action === "timed-out");
          const notProvisioned = missing.filter((m) => !rawModels.some((rm) => rm.modelId.toLowerCase() === m.modelId.toLowerCase() || rm.name.toLowerCase() === m.name.toLowerCase()));
          if (failed.length || notProvisioned.length) {
            if (notProvisioned.length) console.error(`\n❌ Not found in schema file: ${notProvisioned.map((m) => m.name).join(", ")}`);
            console.error("\n⛔  Provisioning incomplete — aborting before import.");
            process.exit(1);
          }
        } else {
          console.error(`\n❌ Target is missing model(s): ${names}`);
          console.error(`   Their generated mutations (e.g. ${missing[0].createOperation}) do not exist on target.`);
          console.error(`   Re-run with:  --create-missing-model --schema-file <kibo-model-export.json>`);
          process.exit(1);
        }
      }
    }

    // ── Schema validation: compare source (exported) fields vs target model ──
    // Blocking issues (target missing a field, or a type change) abort the import
    // unless --allow-schema-mismatch. Models just provisioned match by construction.
    {
      const avail = new Set(await typeFieldNames(targetClient));
      const present = [...models.values()].filter((m) => avail.has(m.createOperation));
      // Read the whole target structure once (exportStructure) instead of a
      // getContentModel round-trip per model.
      const targetDefs = new Map<string, RawModel>();
      try {
        const tStruct = await fetchSourceStructure(targetClient);
        for (const tm of tStruct.models as RawModel[]) targetDefs.set(tm.modelId.toLowerCase(), tm);
      } catch (e) {
        console.warn(`  ⚠  Could not read target structure — skipping schema validation: ${e instanceof Error ? e.message : String(e)}`);
      }
      let blocked = 0;
      for (const m of present) {
        const tdef = targetDefs.get(m.modelId.toLowerCase());
        if (!tdef) continue;
        const tFields = (tdef.fields ?? []).map((f) => ({ fieldId: String(f["fieldId"]), type: String(f["type"]) }));
        const c = diffModelFields(m.modelId, m.fields.map((f) => ({ fieldId: f.fieldId, type: f.type })), tFields);
        for (const w of c.warnings) console.warn(`  ⚠  ${c.modelId}.${w.fieldId}: ${w.issue}${w.targetType ? ` (target ${w.targetType})` : ""}`);
        for (const b of c.blocking) {
          blocked++;
          console.error(`  ✗  ${c.modelId}.${b.fieldId}: ${b.issue}${b.sourceType ? ` source=${b.sourceType}` : ""}${b.targetType ? ` target=${b.targetType}` : ""}`);
        }
      }
      if (blocked > 0) {
        if (!opts.allowSchemaMismatch) {
          console.error(`\n⛔  Target schema incompatible with source (${blocked} blocking issue(s)).`);
          console.error("   Fix the target model, or re-run with --allow-schema-mismatch to import anyway (mismatched fields may fail).");
          process.exit(1);
        }
        console.warn(`\n⚠  Proceeding despite ${blocked} schema mismatch(es) (--allow-schema-mismatch).`);
      }
    }

    const results: ModelCloneResult[] = [];

    for (const exportFile of exportFiles) {
      const model = models.get(exportFile.modelName);
      if (!model) continue;

      console.log(`\n📦 Importing ${model.name} (${exportFile.entries.length} entries)`);
      const result = await importModelFile(targetClient, model, exportFile, config, targetAdminClient);
      results.push(result);
    }

    printSummary(results);

    // Per-item results for the run ledger (mapped to the shared ItemResult shape).
    if (opts.result) {
      const items = results.flatMap((r) =>
        r.items.map((it) => ({
          type: "cms-entry" as const,
          id: it.id,
          status: it.action === "error" ? "error" : it.action === "skipped" ? "skipped" : "done",
          action: it.action,
          error: it.error,
        }))
      );
      fs.writeFileSync(opts.result, JSON.stringify({ items }, null, 2), "utf-8");
      console.log(`  Results written: ${opts.result}`);
    }

    const errorFile = writeErrorReport(results);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
    } else {
      console.log("✅ Import complete — no errors.");
    }
  });

// ─── purge subcommand ─────────────────────────────────────────────────────────

program
  .command("purge")
  .description("Delete CMS entries from the target environment (dry-run by default)")
  .option("--in <dir>", "Export dir to use as deletion manifest (export-based mode)", "./export/cms")
  .option("--all", "Delete ALL entries on target for the given models (ignores --in)", false)
  .option("--confirm", "Preview the purge warning (omit for dry-run)", false)
  .option("--force", "Skip the warning and actually delete (required for a real purge)", false)
  .option("--permanent", "Hard delete (skip the recycle bin — UNRECOVERABLE). Default: soft delete to bin.", false)
  .option("--allow-same-tenant", "Permit purging when TARGET_TENANT equals SOURCE_TENANT", false)
  .option("--schema-file <file>", "CMS model export JSON (used with --all)", process.env["SCHEMA_FILE"] ?? "")
  .option("--models <models>", "Models to purge, comma-separated (used with --all)", process.env["MODELS"] ?? "")
  .option("--select <ids>", "Narrow the purge to these entryIds (comma-separated or @file)", "")
  .option("--locale <locale>", "Locale header for target API", process.env["LOCALE"] ?? "en-US")
  .option("--concurrency <n>", "Parallel deletes", process.env["CONCURRENCY"] ?? "5")
  .action(async (opts: {
    in: string;
    all: boolean;
    confirm: boolean;
    force: boolean;
    permanent: boolean;
    allowSameTenant: boolean;
    schemaFile: string;
    models: string;
    select: string;
    locale: string;
    concurrency: string;
  }) => {
    const dryRun = !(opts.confirm || opts.force);
    if (!dryRun) assertPurgeTargetSafe(opts.allowSameTenant);
    const concurrency = parseInt(opts.concurrency, 10) || 5;
    const onlyIds = opts.select
      ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8")))
      : null;

    const config = loadImportConfig({ dir: opts.in, locale: opts.locale, concurrency: opts.concurrency, dryRun });

    console.log("\n🗑  CMS Entries — Purge");
    console.log("─".repeat(40));
    console.log(`  Target Manage: ${config.targetManageUrl}`);
    console.log(`  Tenant       : ${config.targetTenant}`);
    console.log(`  Mode         : ${opts.all ? "--all (every entry for selected models on target)" : `export-based (${opts.in})`}`);
    console.log(`  Concurrency  : ${concurrency}`);
    console.log(`  Dry Run      : ${dryRun}`);
    if (dryRun) {
      console.log("\n  ⚠  DRY RUN — pass --force to execute (or --confirm to see the warning)");
    }
    console.log("─".repeat(40));

    // Real purge requested but not forced → show the warning and stop.
    if (!dryRun && !opts.force) {
      console.error(purgeWarning(
        opts.permanent
          ? "CMS entries on the target — PERMANENT hard delete (skips the bin, unrecoverable)"
          : "CMS entries on the target — soft delete to the recycle bin (recoverable)",
        config.targetTenant,
        "Deleting a content model itself removes all of its entries and is NOT recoverable."
      ));
      process.exit(1);
    }

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const targetClient = createClient(resolveEnvironment("target", { requireManage: true }), {
      useManage: true,
      locale: config.locale,
      rateLimit: config.rateLimitDelay,
      debug: config.debug,
    });

    process.stdout.write("\n  Verifying target endpoint...");
    await targetClient.ping();
    console.log(" ✓");

    let results;

    if (opts.all) {
      if (!opts.schemaFile && !opts.models) {
        console.error("\n❌ --all mode requires --schema-file or --models to identify which models to purge.");
        process.exit(1);
      }

      let models: Map<string, import("./src/introspect").ModelDefinition>;

      if (opts.schemaFile) {
        console.log("\n📄 Loading models from schema file...");
        models = loadSchemaFile(opts.schemaFile, opts.models ? opts.models.split(",").map((m) => m.trim()) : ["ALL"]);
      } else {
        const targetAdminClient = createClient(resolveEnvironment("target"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });
        console.log("\n🔍 Introspecting models from target...");
        models = await introspectModels(
          targetClient,
          opts.models ? opts.models.split(",").map((m) => m.trim()) : ["ALL"],
          targetAdminClient
        );
      }

      console.log(`  Models: ${[...models.keys()].join(", ")}`);
      results = await purgeAllEntries(targetClient, models, dryRun, concurrency, opts.permanent, onlyIds);
    } else {
      const exportFiles = readExportFiles(config.dir);
      console.log(`\n  Found ${exportFiles.length} export file(s): ${exportFiles.map((f) => f.modelName).join(", ")}`);

      const models = buildModelsFromExportFiles(exportFiles);
      results = await purgeFromExportFiles(targetClient, exportFiles, models, dryRun, concurrency, opts.permanent, onlyIds);
    }

    printPurgeSummary(results);

    const errorFile = writePurgeErrorReport(results);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
    } else if (!dryRun) {
      console.log("✅ Purge complete — no errors.\n");
    }
  });

// ─── catalog subcommand ───────────────────────────────────────────────────────

program
  .command("catalog")
  .description("List CMS entries available in an environment (read-only) as a selectable catalog")
  .option("--env <role>", "Environment to read: source | target", "source")
  .option("--schema-file <file>", "Offline model schema override (default: introspect live)", "")
  .option("--models <models>", "Comma-separated model names (used when --schema-file is not set)", process.env["MODELS"] ?? "")
  .option("--locale <locale>", "Locale header", process.env["LOCALE"] ?? "en-US")
  .option("--out <file>", "Write catalog JSON to this file (omit to print summary only)", "")
  .action(async (opts: { env: string; schemaFile: string; models: string; locale: string; out: string }) => {
    const role: EnvRole = opts.env === "target" ? "target" : "source";
    if (!opts.schemaFile && !opts.models) {
      console.error("❌ Provide --schema-file (CMS model export JSON) or --models PromoBanner,Article");
      process.exit(1);
    }

    const env = resolveEnvironment(role, { requireManage: true });
    const client = createClient(env, { useManage: true, locale: opts.locale });
    // Admin endpoint client — folder tree (aco) for folder-path display.
    const adminClient = createClient(env, { locale: opts.locale });

    console.log("\n📚 CMS Entries — Catalog");
    console.log("─".repeat(40));
    console.log(`  Environment  : ${role} (tenant ${env.tenant})`);
    console.log(`  Manage API   : ${env.manageUrl}`);
    console.log("─".repeat(40));

    const requested = opts.models ? opts.models.split(",").map((m) => m.trim()).filter(Boolean) : ["ALL"];

    // The Manage API (models + entries) may be unauthorized for a tenant even when
    // Admin GQL (pages/redirects) works. Surface that as "not authorized" sections
    // — like files/redirects do when their API is unavailable — instead of aborting.
    let models: Map<string, import("./src/introspect").ModelDefinition> = new Map();
    let authNote: string | null = null;
    try {
      models = opts.schemaFile ? loadSchemaFile(opts.schemaFile, requested) : await introspectModels(client, requested, client);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      authNote = /401|unauthor|forbidden|403/i.test(msg)
        ? "Not authorized — the API key lacks CMS Manage (content models + entries) access for this tenant."
        : "CMS Manage API returned no content models for this tenant — check the API key's CMS Manage access, tenant id, and locale.";
      console.warn(`\n  ⚠  ${authNote}`);
    }

    let modelSection, section;
    if (authNote) {
      modelSection = { type: "model" as const, total: 0, items: [], note: authNote };
      section = { type: "cms-entry" as const, total: 0, items: [], note: authNote };
    } else {
      process.stdout.write("\n  Verifying endpoint...");
      await client.ping();
      console.log(" ✓");
      modelSection = await catalogModels(client);
      section = await catalogEntries(client, [...models.values()], adminClient);
    }
    const catalog = buildCatalog(
      { role, tenant: env.tenant, locale: opts.locale },
      [modelSection, section],
      new Date().toISOString()
    );

    console.log(`\n  ${modelSection.total} model(s); ${section.total} cms-entry item(s) across ${models.size} model(s):`);
    const byModel = new Map<string, number>();
    for (const it of section.items) byModel.set(it.group ?? "?", (byModel.get(it.group ?? "?") ?? 0) + 1);
    for (const [m, n] of byModel) console.log(`    ${m.padEnd(24)} ${String(n).padStart(4)}`);
    const withDeps = section.items.filter((i) => (i.dependsOn?.length ?? 0) > 0).length;
    if (withDeps) console.log(`  ${withDeps} item(s) have file/ref dependencies`);

    if (opts.out) {
      fs.writeFileSync(opts.out, JSON.stringify(catalog, null, 2), "utf-8");
      console.log(`\n  Catalog (${catalogSize(catalog)} items) written → ${opts.out}\n`);
    } else {
      console.log("\n  (pass --out catalog.json to save the full catalog)\n");
    }
  });

// ─── models subcommand ────────────────────────────────────────────────────────

program
  .command("models")
  .description("List content models from an environment, or provision selected models onto the target (no schema file needed)")
  .option("--env <role>", "Environment to list from: source | target", "source")
  .option("--locale <locale>", "Locale header", process.env["LOCALE"] ?? "en-US")
  .option("--provision <ids>", "Fetch these modelIds from source and create them on target (comma-separated, or @file)", "")
  .option("--out <file>", "Write the model list/results JSON to this file", "")
  .option("--result <file>", "Write per-item results JSON (for the run ledger)", "")
  .action(async (opts: { env: string; locale: string; provision: string; out: string; result: string }) => {
    if (opts.provision) {
      // Provision: fetch full defs from SOURCE, create on TARGET.
      const ids = parseSelection(opts.provision, (p) => fs.readFileSync(p, "utf-8"));
      const sourceClient = createClient(resolveEnvironment("source", { requireManage: true }), { useManage: true, locale: opts.locale });
      const targetClient = createClient(resolveEnvironment("target", { requireManage: true }), { useManage: true, locale: opts.locale });

      console.log("\n🧩 CMS Entries — Provision models (source → target)");
      console.log(`   Models: ${ids.join(", ")}`);
      const defs = await fetchSourceModelDefs(sourceClient, ids);

      const items: Array<Record<string, unknown>> = [];
      for (const def of defs) {
        const r = await ensureModelProvisioned(targetClient, def, { onEvent: (e) => console.log(`   [${e.model}] ${e.message}`) });
        const ok = r.action === "created" || r.action === "already-exists";
        const mark = r.action === "created" ? "✓ created" : r.action === "already-exists" ? "• exists" : `❌ ${r.action}`;
        console.log(`   ${mark}  ${def.modelId}${r.error ? ` — ${r.error}` : ""}`);
        items.push({ type: "model", id: def.modelId, status: ok ? "done" : "error", action: r.action, error: r.error });
      }
      if (opts.result) fs.writeFileSync(opts.result, JSON.stringify({ items }, null, 2), "utf-8");
      const failed = items.filter((i) => i.status === "error");
      if (failed.length) { console.error(`\n⛔  ${failed.length} model(s) failed.`); process.exit(1); }
      console.log("\n✅ Models provisioned.");
      return;
    }

    // List
    const role = opts.env === "target" ? "target" : "source";
    const client = createClient(resolveEnvironment(role, { requireManage: true }), { useManage: true, locale: opts.locale });
    console.log(`\n📚 CMS Entries — Models (${role})`);
    const models = await listSourceModels(client);
    console.log(`   ${models.length} model(s):`);
    for (const m of models) console.log(`     ${m.modelId.padEnd(24)} ${String(m.fieldCount).padStart(3)} fields  (${m.name}${m.group ? ", group " + m.group : ""})`);
    if (opts.out) { fs.writeFileSync(opts.out, JSON.stringify(models, null, 2), "utf-8"); console.log(`\n   Written → ${opts.out}`); }
    console.log("");
  });

program.parse(process.argv);
