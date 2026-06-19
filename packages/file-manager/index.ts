/**
 * File Manager Cloner — Entry Point
 *
 * Two-step workflow:
 *
 *   Step 1 — Export file metadata from source to local JSON:
 *     npx ts-node index.ts export --out ./export/files
 *     npx ts-node index.ts export --tags hero-images,banners
 *
 *   Step 2 — Review files.json, then import metadata to target + generate S3 manifest:
 *     npx ts-node index.ts import --in ./export/files --dry-run
 *     npx ts-node index.ts import --in ./export/files
 *
 *   After import: share s3-copy-manifest.txt with your AWS admin.
 */

import fs from "fs";
import { Command } from "commander";
import { createClient, resolveEnvironment, loadRootEnv, buildCatalog, catalogSize, getLocale, EnvRole, parseSelection, assertPurgeTargetSafe, purgeWarning } from "@kibo-cms-clone-tool/shared";
import { catalogFiles } from "./src/catalog";
import { loadExportConfig, loadImportConfig } from "./src/config";
import { exportFiles } from "./src/export";
import { importFiles, readExportFile } from "./src/clone";
import { printSummary, writeErrorReport } from "./src/report";
import {
  purgeFromExportFile,
  purgeAllFiles,
  printPurgeSummary,
  writePurgeErrorReport,
} from "./src/purge";

loadRootEnv();

const program = new Command();

program
  .name("file-manager")
  .description("File Manager Clone Tool — export metadata from source, clone to target");

// ─── export subcommand ────────────────────────────────────────────────────────

program
  .command("export")
  .description("Export file metadata from source File Manager to a local JSON file")
  .option("--tags <tags>", "Only export files with these tags (comma-sep)", process.env["TAGS_FILTER"] ?? "")
  .option("--out <dir>", "Output directory", "./export/files")
  .action(async (opts: { tags: string; out: string }) => {
    const config = loadExportConfig(opts);

    console.log("\n📤 File Manager — Export");
    console.log("─".repeat(40));
    console.log(`  Source  : ${config.sourceAdminGqlUrl}`);
    console.log(`  Out dir : ${config.outDir}`);
    if (config.tagsFilter.length) console.log(`  Tags    : ${config.tagsFilter.join(", ")}`);
    console.log("─".repeat(40));

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const sourceClient = createClient(resolveEnvironment("source"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    const { fileCount, filePath } = await exportFiles(sourceClient, config);

    console.log(`\n✅ Export complete: ${fileCount} files → ${filePath}`);
    console.log("\n   Review / remove entries from files.json, then run:");
    console.log(`   npx ts-node index.ts import --in ${config.outDir}\n`);
  });

// ─── import subcommand ────────────────────────────────────────────────────────

program
  .command("import")
  .description("Register file metadata in target + write s3-copy-manifest.txt")
  .option("--in <dir>", "Directory containing exported files.json", "./export/files")
  .option("--concurrency <n>", "Parallel GraphQL writes", process.env["CONCURRENCY"] ?? "10")
  .option("--dry-run", "Preview without writing to target", process.env["DRY_RUN"] === "true")
  .option(
    "--skip-existing <bool>",
    "Skip files already registered in target (true/false)",
    process.env["SKIP_EXISTING"] ?? "true"
  )
  .option("--select <ids>", "Import only these files (src URL or key; comma-separated, or @file). Default: all", "")
  .option("--allow-folder-mismatch", "Import even if some folders failed to sync (items fall back to root)", false)
  .option("--result <file>", "Write per-item results JSON (for the run ledger)", "")
  .action(async (opts: { in: string; concurrency: string; dryRun: boolean; skipExisting: string; select: string; allowFolderMismatch: boolean; result: string }) => {
    const config = loadImportConfig({ dir: opts.in, concurrency: opts.concurrency, dryRun: opts.dryRun, skipExisting: opts.skipExisting, allowFolderMismatch: opts.allowFolderMismatch });
    const selection = opts.select ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"))) : null;

    console.log("\n📥 File Manager — Import");
    console.log("─".repeat(40));
    console.log(`  Target       : ${config.targetAdminGqlUrl}`);
    console.log(`  Source dir   : ${config.dir}`);
    console.log(`  CDN Rewrite  : ${config.sourceCdnDomain} → ${config.targetCdnDomain}`);
    console.log(`  Concurrency  : ${config.concurrency}`);
    console.log(`  Dry Run      : ${config.dryRun}`);
    console.log(`  Skip Existing: ${config.skipExisting}`);
    console.log("─".repeat(40));

    const exportFile = readExportFile(config.dir);
    if (selection) {
      const before = exportFile.files.length;
      exportFile.files = exportFile.files.filter((f) => selection.has(f.src) || selection.has(f.key));
      console.log(`\n  Selection: ${selection.size} id(s) → ${exportFile.files.length} of ${before} file(s)`);
    }
    console.log(`\n  Loaded ${exportFile.files.length} files from ${config.dir}/files.json`);

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const targetClient = createClient(resolveEnvironment("target"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    process.stdout.write("\n  Verifying target endpoint...");
    await targetClient.ping();
    console.log(" ✓\n");

    const stats = await importFiles(targetClient, exportFile, config);

    printSummary(stats);

    if (opts.result) {
      const errByKey = new Map(stats.errors.map((e) => [e.key, e.error] as const));
      const items = exportFile.files.map((f) => ({
        type: "file" as const,
        id: f.src || f.key,
        status: errByKey.has(f.key) ? "error" : "done",
        error: errByKey.get(f.key),
      }));
      fs.writeFileSync(opts.result, JSON.stringify({ items }, null, 2), "utf-8");
    }

    const errorFile = writeErrorReport(stats);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
    } else {
      console.log("✅ Import complete — no errors.");
    }

    console.log("\n📋 Next step: share s3-copy-manifest.txt with your AWS admin");
    console.log("   to copy the actual file binaries into the target S3 bucket.\n");
  });

// ─── purge subcommand ─────────────────────────────────────────────────────────

program
  .command("purge")
  .description("Delete file registrations from target File Manager (metadata only — S3 untouched)")
  .option("--in <dir>", "Export dir to use as deletion manifest (export-based mode)", "./export/files")
  .option("--all", "Delete ALL file registrations on target (ignores --in)", false)
  .option("--confirm", "Preview the purge warning (omit for dry-run)", false)
  .option("--force", "Skip the warning and actually delete (required for a real purge)", false)
  .option("--allow-same-tenant", "Permit purging when TARGET_TENANT equals SOURCE_TENANT", false)
  .option("--select <ids>", "Narrow the purge to these files (src/key/id, comma-separated or @file)", "")
  .option("--concurrency <n>", "Parallel deletes", process.env["CONCURRENCY"] ?? "5")
  .action(async (opts: { in: string; all: boolean; confirm: boolean; force: boolean; allowSameTenant: boolean; select: string; concurrency: string }) => {
    const dryRun = !(opts.confirm || opts.force);
    if (!dryRun) assertPurgeTargetSafe(opts.allowSameTenant);
    const concurrency = parseInt(opts.concurrency, 10) || 5;
    const onlyIds = opts.select
      ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8")))
      : null;

    const config = loadImportConfig({ dir: opts.in, concurrency: opts.concurrency, dryRun, skipExisting: "true" });

    console.log("\n🗑  File Manager — Purge");
    console.log("─".repeat(40));
    console.log(`  Target      : ${config.targetAdminGqlUrl}`);
    console.log(`  Tenant      : ${config.targetTenant}`);
    console.log(`  Mode        : ${opts.all ? "--all (every file registration on target)" : `export-based (${opts.in})`}`);
    console.log(`  Concurrency : ${concurrency}`);
    console.log(`  Dry Run     : ${dryRun}`);
    console.log(`  Note        : Only metadata is deleted. S3 binaries are NOT removed.`);
    if (dryRun) {
      console.log("\n  ⚠  DRY RUN — pass --force to execute (or --confirm to see the warning)");
    }
    console.log("─".repeat(40));

    if (!dryRun && !opts.force) {
      console.error(purgeWarning(
        "file registrations on the target (metadata only — S3 binaries are NOT removed)",
        config.targetTenant,
        "Removes the file records on the target; re-import to restore them."
      ));
      process.exit(1);
    }

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const targetClient = createClient(resolveEnvironment("target"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    process.stdout.write("\n  Verifying target endpoint...");
    await targetClient.ping();
    console.log(" ✓");

    let stats;

    if (opts.all) {
      stats = await purgeAllFiles(targetClient, dryRun, concurrency, onlyIds);
    } else {
      const exportFile = readExportFile(config.dir);
      console.log(`\n  Loaded ${exportFile.files.length} file(s) from ${config.dir}/files.json`);
      stats = await purgeFromExportFile(targetClient, exportFile, dryRun, concurrency, onlyIds);
    }

    printPurgeSummary(stats);

    const errorFile = writePurgeErrorReport(stats);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
    } else if (!dryRun) {
      console.log("✅ Purge complete — no errors.\n");
    }
  });

// ─── catalog subcommand ───────────────────────────────────────────────────────

program
  .command("catalog")
  .description("List files in an environment (read-only) as a selectable catalog")
  .option("--env <role>", "Environment to read: source | target", "source")
  .option("--out <file>", "Write catalog JSON to this file (omit to print summary only)", "")
  .action(async (opts: { env: string; out: string }) => {
    const role: EnvRole = opts.env === "target" ? "target" : "source";
    const env = resolveEnvironment(role);
    const client = createClient(env);

    console.log("\n📚 File Manager — Catalog");
    console.log("─".repeat(40));
    console.log(`  Environment  : ${role} (tenant ${env.tenant})`);
    console.log(`  Admin GQL    : ${env.adminGqlUrl}`);
    console.log("─".repeat(40));

    process.stdout.write("\n  Verifying endpoint...");
    await client.ping();
    console.log(" ✓");

    const section = await catalogFiles(client);
    const catalog = buildCatalog({ role, tenant: env.tenant, locale: getLocale() }, [section], new Date().toISOString());

    console.log(`\n  ${section.total} file item(s)${section.note ? ` — note: ${section.note}` : ""}`);
    if (opts.out) {
      fs.writeFileSync(opts.out, JSON.stringify(catalog, null, 2), "utf-8");
      console.log(`  Catalog (${catalogSize(catalog)} items) written → ${opts.out}\n`);
    } else {
      console.log("  (pass --out catalog.json to save the full catalog)\n");
    }
  });

program.parse(process.argv);
