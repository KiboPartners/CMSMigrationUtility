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
import { createClient, resolveEnvironment, loadRootEnv, buildCatalog, catalogSize, getLocale, EnvRole, parseSelection, assertPurgeTargetSafe, purgeWarning, parseFilterCliOption } from "@kibo-cms-clone-tool/shared";
import { catalogFiles } from "./catalog";
import { loadExportConfig, loadImportConfig } from "./config";
import { exportFiles } from "./export";
import { importFiles, readExportFile } from "./clone";
import { printSummary, writeErrorReport } from "./report";
import {
  purgeFromExportFile,
  purgeAllFiles,
  printPurgeSummary,
  writePurgeErrorReport,
} from "./purge";

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
  .option("--filter <file>", "Advanced filter JSON (or @file); dates/name/tags pushdown", "")
  .option("--select <ids>", "Export only these files (src URL or key; comma-separated, or @file). Scopes folders too", "")
  .option("--out <dir>", "Output directory", "./export/files")
  .option("--with-binaries", "Also download file binaries to <out>/binaries/ (resumable)", false)
  .option("--max-file-size <mb>", "Skip files larger than this many MB (0 = no limit)", process.env["MAX_FILE_SIZE_MB"] ?? "")
  .action(async (opts: { tags: string; filter: string; select: string; out: string; withBinaries: boolean; maxFileSize: string }) => {
    const filterSpec = parseFilterCliOption(opts.filter, { tags: opts.tags });
    const selectIds = opts.select
      ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8")))
      : null;
    const config = loadExportConfig({
      ...opts,
      filterSpec,
      tags: filterSpec ? "" : opts.tags,
      selectIds,
    });
    if (!filterSpec && opts.tags) {
      config.tagsFilter = opts.tags.split(",").map((t) => t.trim()).filter(Boolean);
    }

    console.log("\n📤 File Manager — Export");
    console.log("─".repeat(40));
    console.log(`  Source  : ${config.sourceAdminGqlUrl}`);
    console.log(`  Out dir : ${config.outDir}`);
    if (config.tagsFilter.length) console.log(`  Tags    : ${config.tagsFilter.join(", ")}`);
    if (filterSpec) console.log(`  Filter  : frozen at ${filterSpec.frozenAt}`);
    if (selectIds?.size) console.log(`  Select  : ${selectIds.size} id(s)`);
    console.log("─".repeat(40));

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const sourceClient = createClient(resolveEnvironment("source"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    const { fileCount, filePath } = await exportFiles(sourceClient, config);

    console.log(`\n✅ Export complete: ${fileCount} files → ${filePath}`);

    if (config.withBinaries) {
      const { exportBinaries } = await import("./export");
      const { files } = readExportFile(config.outDir);
      await exportBinaries(files, config.outDir, config.maxFileBytes, config.concurrency);
      console.log("   Binaries downloaded to <out>/binaries/ (see manifest.json)");
    }

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
  .option("--upload-binaries", "Prefer binaries from <in>/binaries/ (offline); files absent from the cache are skipped with a warning", false)
  .option("--stream-binaries", "Force streaming source CDN → target S3 even if a local cache is present", false)
  .option("--manifest-only", "Do NOT transfer or register files; emit s3-copy-manifest.txt for all files instead", false)
  .option("--max-file-size <mb>", "Skip binaries larger than this many MB (0 = no limit)", process.env["MAX_FILE_SIZE_MB"] ?? "")
  .option("--result <file>", "Write per-item results JSON (for the run ledger)", "")
  .option("--keymap-dir <dir>", "Central key-map store directory (default: <repoRoot>/.keymap)", "")
  .action(async (opts: { in: string; concurrency: string; dryRun: boolean; skipExisting: string; select: string; allowFolderMismatch: boolean; uploadBinaries: boolean; streamBinaries: boolean; manifestOnly: boolean; maxFileSize: string; result: string; keymapDir: string }) => {
    const config = loadImportConfig({ dir: opts.in, concurrency: opts.concurrency, dryRun: opts.dryRun, skipExisting: opts.skipExisting, allowFolderMismatch: opts.allowFolderMismatch, uploadBinaries: opts.uploadBinaries, streamBinaries: opts.streamBinaries, manifestOnly: opts.manifestOnly, maxFileSize: opts.maxFileSize, keymapDir: opts.keymapDir });
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

    printSummary(stats, config.dryRun);

    if (opts.result) {
      const errByKey = new Map(stats.errors.map((e) => [e.key, e.error] as const));
      const { binaryResultItems } = await import("./clone");
      const items = binaryResultItems(
        exportFile.files,
        errByKey,
        new Set(stats.skippedLarge),
        new Set(stats.uploaded),
        new Set(stats.skippedKeys),
        new Set(stats.folderUpdatedKeys),
        new Set(stats.missingSource),
        new Set(stats.manifested),
        new Set(stats.skippedGap)
      );
      fs.writeFileSync(opts.result, JSON.stringify({ items }, null, 2), "utf-8");
    }

    const errorFile = writeErrorReport(stats);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
    } else {
      console.log("✅ Import complete — no errors.");
    }

    if (config.binaryMode === "manifest") {
      console.log("\n📋 Manifest-only: no files were transferred or registered.");
      console.log("   Share s3-copy-manifest.txt with your AWS admin to copy binaries into the target bucket.");
      console.log("   References resolve once objects exist at the same key (domain swap).\n");
    }
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
  .option("--result <file>", "Write per-item results JSON (for the run ledger)", "")
  .action(async (opts: { in: string; all: boolean; confirm: boolean; force: boolean; allowSameTenant: boolean; select: string; concurrency: string; result: string }) => {
    const dryRun = !(opts.confirm || opts.force);
    if (!dryRun) assertPurgeTargetSafe(opts.allowSameTenant);
    const concurrency = parseInt(opts.concurrency, 10) || 5;
    const onlyIds = opts.select
      ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8")))
      : null;
    if (opts.select && onlyIds && onlyIds.size === 0) {
      console.error("\n❌ --select resolved to 0 ids — refusing to purge. Check the ids file / selection.");
      process.exit(1);
    }

    const config = loadImportConfig({ dir: opts.in, concurrency: opts.concurrency, dryRun, skipExisting: "true" });

    console.log("\n🗑  File Manager — Purge");
    console.log("─".repeat(40));
    console.log(`  Target      : ${config.targetAdminGqlUrl}`);
    console.log(`  Tenant      : ${config.targetTenant}`);
    const modeLabel = opts.all
      ? (onlyIds && onlyIds.size
          ? `--all narrowed by --select (${onlyIds.size} id(s))`
          : "--all (every file registration on target)")
      : `export-based (${opts.in})`;
    console.log(`  Mode        : ${modeLabel}`);
    console.log(`  Concurrency : ${concurrency}`);
    console.log(`  Dry Run     : ${dryRun}`);
    console.log("  Note        : Metadata only — S3 binaries are NOT removed.");
    if (dryRun) {
      console.log("\n  ⚠  DRY RUN — pass --force to execute (omit flags to preview)");
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

    if (opts.result && onlyIds && onlyIds.size) {
      const errByKey = new Map(stats.errors.map((e) => [e.key, e.error] as const));
      const items = [...onlyIds].map((id) => {
        const err = errByKey.get(id) || [...errByKey.entries()].find(([k]) => k === id)?.[1];
        return {
          type: "file" as const,
          id,
          status: err ? "error" as const : dryRun ? "skipped" as const : "done" as const,
          action: err ? undefined : dryRun ? "would-delete" : "deleted",
          error: err,
        };
      });
      fs.writeFileSync(opts.result, JSON.stringify({ items }, null, 2), "utf-8");
    }

    const errorFile = writePurgeErrorReport(stats);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
      process.exit(1);
    } else if (!dryRun) {
      console.log("✅ Purge complete — no errors.\n");
    }
  });

// ─── catalog subcommand ───────────────────────────────────────────────────────

program
  .command("catalog")
  .description("List files in an environment (read-only) as a selectable catalog")
  .option("--env <role>", "Environment to read: source | target", "source")
  .option("--filter <file>", "Advanced filter JSON (or @file); applied at catalog list time", "")
  .option("--out <file>", "Write catalog JSON to this file (omit to print summary only)", "")
  .action(async (opts: { env: string; filter: string; out: string }) => {
    const role: EnvRole = opts.env === "target" ? "target" : "source";
    const env = resolveEnvironment(role);
    const client = createClient(env);
    const filterSpec = parseFilterCliOption(opts.filter);

    console.log("\n📚 File Manager — Catalog");
    console.log("─".repeat(40));
    console.log(`  Environment  : ${role} (tenant ${env.tenant})`);
    console.log(`  Admin GQL    : ${env.adminGqlUrl}`);
    if (filterSpec) console.log(`  Filter       : frozen at ${filterSpec.frozenAt}`);
    console.log("─".repeat(40));

    process.stdout.write("\n  Verifying endpoint...");
    await client.ping();
    console.log(" ✓");

    const section = await catalogFiles(client, filterSpec);
    const catalog = buildCatalog({ role, tenant: env.tenant, locale: getLocale() }, [section], new Date().toISOString());

    console.log(`\n  ${section.total} file item(s)${section.note ? ` — note: ${section.note}` : ""}`);
    if (opts.out) {
      fs.writeFileSync(opts.out, JSON.stringify(catalog, null, 2), "utf-8");
      console.log(`  Catalog (${catalogSize(catalog)} items) written → ${opts.out}\n`);
    } else {
      console.log("  (pass --out catalog.json to save the full catalog)\n");
    }
  });

/** Run this artifact CLI in-process (argv without node/script). */
export async function runArtifactCli(args: string[]): Promise<void> {
  await program.parseAsync(args, { from: "user" });
}

if (require.main === module) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
