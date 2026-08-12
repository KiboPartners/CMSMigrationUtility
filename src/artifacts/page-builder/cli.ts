/**
 * Page Builder Cloner — Entry Point
 *
 * Two-step workflow:
 *
 *   Step 1 — Export ALL pages from source to a single JSON file:
 *     npx ts-node index.ts export --locale en-US --out ./export/pages
 *     npx ts-node index.ts export --include-unpublished false
 *
 *   Step 2 — Review/edit pages.json, then import:
 *     npx ts-node index.ts import --in ./export/pages --dry-run
 *     npx ts-node index.ts import --in ./export/pages
 *
 * The export file contains every page regardless of category.
 * Delete or edit entries in the JSON before importing to control scope.
 */

import fs from "fs";
import { Command } from "commander";
import { createClient, resolveEnvironment, loadRootEnv, buildCatalog, catalogSize, getLocale, EnvRole, parseSelection, assertPurgeTargetSafe, purgeWarning, resolveImportKeyMap, defaultKeymapDir, parseFilterCliOption } from "@kibo-cms-clone-tool/shared";
import { catalogPages } from "./catalog";
import { loadExportConfig, loadImportConfig } from "./config";
import { exportPages } from "./export";
import { importPages, readPagesManifest } from "./pages";
import { printSummary, writeErrorReport } from "./report";
import { discoverPageBuilderOps } from "./ops";
import {
  purgeAllPages,
  printPurgeSummary,
  writePurgeErrorReport,
} from "./purge";

loadRootEnv();

const program = new Command();

program
  .name("page-builder")
  .description("Page Builder Clone Tool — export from source, clone to target");

// ─── export subcommand ────────────────────────────────────────────────────────

program
  .command("export")
  .description("Export all pages (and categories) from source to a local JSON file")
  .option("--locale <locale>", "Locale to export (e.g. en-US)", process.env["LOCALE"] ?? "en-US")
  .option(
    "--include-unpublished <bool>",
    "Include draft pages (true/false)",
    process.env["INCLUDE_UNPUBLISHED"] ?? "true"
  )
  .option("--filter <file>", "Advanced filter JSON (or @file); date/status pushdown, name/path residual", "")
  .option("--out <dir>", "Output directory", "./export/pages")
  .option("--select <ids>", "Export only these page ids (comma-separated, or @file). Default: all", "")
  .action(async (opts: { locale: string; includeUnpublished: string; filter: string; out: string; select: string }) => {
    const filterSpec = parseFilterCliOption(opts.filter);
    const config = loadExportConfig({ ...opts, filterSpec });
    const selection = opts.select ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"))) : null;

    console.log("\n📤 Page Builder — Export");
    console.log("─".repeat(40));
    console.log(`  Source             : ${config.sourceAdminGqlUrl}`);
    console.log(`  Locale             : ${config.locale}`);
    console.log(`  Include Unpublished: ${config.includeUnpublished}`);
    console.log(`  Out dir            : ${config.outDir}`);
    if (selection) console.log(`  Selection          : ${selection.size} id(s)`);
    if (filterSpec) console.log(`  Filter             : frozen at ${filterSpec.frozenAt}`);
    console.log("─".repeat(40) + "\n");

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const sourceClient = createClient(resolveEnvironment("source"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    const { pageCount, categoryCount, filePath } = await exportPages(sourceClient, config, selection);

    console.log(`\n✅ Export complete:`);
    console.log(`   ${pageCount} pages + ${categoryCount} categories → ${filePath}`);
    console.log("\n   Review / edit pages.json, then run:");
    console.log(`   npx ts-node index.ts import --in ${config.outDir}\n`);
  });

// ─── import subcommand ────────────────────────────────────────────────────────

program
  .command("import")
  .description("Import pages from local JSON file into target environment")
  .option("--in <dir>", "Directory containing exported pages.json", "./export/pages")
  .option("--locale <locale>", "Locale header for target API", process.env["LOCALE"] ?? "en-US")
  .option("--concurrency <n>", "Parallel page writes", process.env["CONCURRENCY"] ?? "3")
  .option("--dry-run", "Preview without writing to target", process.env["DRY_RUN"] === "true")
  .option("--select <ids>", "Import only these page ids (comma-separated, or @file). Default: all", "")
  .option("--allow-folder-mismatch", "Import even if some folders failed to sync (pages fall back to root)", false)
  .option("--result <file>", "Write per-item results JSON (for the run ledger)", "")
  .option("--key-map <file>", "JSON map of source→target file URLs whose S3 key changed (from file-manager import)", "")
  .option("--keymap-dir <dir>", "Central key-map store directory (default: <repoRoot>/.keymap)", "")
  .option("--as-draft", "Leave pages as draft on target (skip publish); default on", process.env["AS_DRAFT"] !== "false")
  .option("--no-as-draft", "Publish when source was published (disable as-draft)")
  .action(async (opts: { in: string; locale: string; concurrency: string; dryRun: boolean; select: string; allowFolderMismatch: boolean; result: string; keyMap: string; keymapDir: string; asDraft: boolean }) => {
    const keymapDir = opts.keymapDir || defaultKeymapDir();
    let sourceTenant = "";
    try { sourceTenant = resolveEnvironment("source").tenant; } catch { /* source creds absent — tenant tag unavailable */ }
    const keyMap = resolveImportKeyMap({
      keymapDir,
      sourceTenant,
      targetTenant: resolveEnvironment("target").tenant,
      explicitFile: opts.keyMap,
    });
    const config = loadImportConfig({ dir: opts.in, locale: opts.locale, concurrency: opts.concurrency, dryRun: opts.dryRun, allowFolderMismatch: opts.allowFolderMismatch, keyMap, keymapDir, asDraft: opts.asDraft });
    const selection = opts.select ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"))) : null;

    console.log("\n📥 Page Builder — Import");
    console.log("─".repeat(40));
    console.log(`  Target      : ${config.targetAdminGqlUrl}`);
    console.log(`  Source dir  : ${config.dir}`);
    console.log(`  Concurrency : ${config.concurrency}`);
    console.log(`  Dry Run     : ${config.dryRun}`);
    console.log(`  As draft    : ${config.asDraft}${config.asDraft ? "" : " (publish when source published)"}`);
    if (config.sourceCdnDomain && config.targetCdnDomain) {
      console.log(`  CDN Rewrite : ${config.sourceCdnDomain} → ${config.targetCdnDomain}`);
    }
    console.log("─".repeat(40));

    // Read the (small) metadata sidecar — pages themselves are streamed later,
    // never buffered as one big array here (unless this is a legacy export).
    const source = readPagesManifest(config.dir);
    if (selection) {
      console.log(`\n  Selection: ${selection.size} id(s) — filtered per page while streaming`);
    }
    console.log(
      `\n  Loaded pages source${source.ndjsonPath ? " (streaming)" : ` (${source.legacyPages?.length ?? 0} pages)`}, ` +
        `${source.categories.length} categories from ${config.dir}/pages.json`
    );

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const targetClient = createClient(resolveEnvironment("target"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    process.stdout.write("\n  Verifying target endpoint...");
    await targetClient.ping();
    console.log(" ✓\n");

    const result = await importPages(targetClient, source, config, selection);

    printSummary(result);

    if (result.total === 0 && selection && selection.size > 0) {
      console.warn(`  ⚠  None of the ${selection.size} selected id(s) matched a page in this export — the export dir is stale or from another tenant. Re-export before importing.`);
    }

    if (opts.result) {
      // Per-item results for the run ledger (mapped from the streaming outcomes).
      const items = result.items.map((it) => ({
        type: "page" as const,
        id: it.id || it.slug,
        status: it.action === "error" ? "error" : it.action === "skipped" ? "skipped" : "done",
        action: it.action,
        error: it.error,
      }));
      fs.writeFileSync(opts.result, JSON.stringify({ items }, null, 2), "utf-8");
    }

    const errorFile = writeErrorReport(result);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
    } else {
      console.log("✅ Import complete — no errors.");
    }
  });

// ─── purge subcommand ─────────────────────────────────────────────────────────

program
  .command("purge")
  .description(
    "Move all pages on the target to trash (dry-run by default).\n" +
    "Note: the WbPage API does not expose a stable cross-environment identifier,\n" +
    "so purge always operates on all pages rather than a subset from an export file.\n" +
    "Pages are moved to trash — empty the Trash folder in the CMS admin to remove them permanently."
  )
  .option("--confirm", "Preview the purge warning (omit for dry-run)", false)
  .option("--force", "Skip the warning and actually delete (required for a real purge)", false)
  .option("--permanent", "Hard delete (skip Trash — UNRECOVERABLE). Default: soft delete to Trash.", false)
  .option("--allow-same-tenant", "Permit purging when TARGET_TENANT equals SOURCE_TENANT", false)
  .option("--select <ids>", "Narrow the purge to these pages (id/pid/path/slug, comma-separated or @file)", "")
  .option("--locale <locale>", "Locale header for target API", process.env["LOCALE"] ?? "en-US")
  .option("--concurrency <n>", "Parallel deletes", process.env["CONCURRENCY"] ?? "3")
  .option("--result <file>", "Write per-item results JSON (for the run ledger)", "")
  .action(async (opts: { confirm: boolean; force: boolean; permanent: boolean; allowSameTenant: boolean; select: string; locale: string; concurrency: string; result: string }) => {
    const dryRun = !(opts.confirm || opts.force);
    if (!dryRun) assertPurgeTargetSafe(opts.allowSameTenant);
    const concurrency = parseInt(opts.concurrency, 10) || 3;
    const onlyIds = opts.select
      ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8")))
      : null;

    const config = loadImportConfig({ dir: "./export/pages", locale: opts.locale, concurrency: opts.concurrency, dryRun });

    console.log("\n🗑  Page Builder — Purge");
    console.log("─".repeat(40));
    console.log(`  Target      : ${config.targetAdminGqlUrl}`);
    console.log(`  Tenant      : ${config.targetTenant}`);
    if (opts.select && onlyIds && onlyIds.size === 0) {
      console.error("\n❌ --select resolved to 0 ids — refusing to purge. Check the ids file / selection.");
      process.exit(1);
    }
    const dest = opts.permanent ? "hard delete" : "trash (soft)";
    const modeLabel = onlyIds && onlyIds.size
      ? `--select (${onlyIds.size} id(s)) → ${dest}`
      : `all pages → ${dest}`;
    console.log(`  Mode        : ${modeLabel}`);
    console.log(`  Concurrency : ${concurrency}`);
    console.log(`  Dry Run     : ${dryRun}`);
    if (dryRun) {
      console.log("\n  ⚠  DRY RUN — pass --force to execute (omit flags to preview)");
    }
    console.log("─".repeat(40));

    if (!dryRun && !opts.force) {
      console.error(purgeWarning(
        opts.permanent
          ? (onlyIds?.size ? "selected pages — PERMANENT hard delete (skips Trash, unrecoverable)" : "ALL pages on the target — PERMANENT hard delete (skips Trash, unrecoverable)")
          : (onlyIds?.size ? "selected pages — soft delete to Trash (recoverable)" : "ALL pages on the target — soft delete to Trash (recoverable)"),
        config.targetTenant,
        "Soft delete sends permanently:false; omit would hard-delete. --permanent sends permanently:true."
      ));
      process.exit(1);
    }

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const targetClient = createClient(resolveEnvironment("target"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    process.stdout.write("\n  Verifying target endpoint...");
    await targetClient.ping();
    console.log(" ✓\n");

    console.log("  Discovering Page Builder operations on target...");
    const ops = await discoverPageBuilderOps(targetClient);

    if (!ops.deletePage) {
      console.error("\n❌ deletePage operation not found on target schema. Cannot purge.");
      process.exit(1);
    }

    const result = await purgeAllPages(targetClient, ops, dryRun, concurrency, opts.permanent, onlyIds);

    printPurgeSummary(result);

    if (opts.result && onlyIds && onlyIds.size) {
      const errById = new Map(result.errors.map((e) => [e.id, e.error] as const));
      const items = [...onlyIds].map((id) => {
        const err = errById.get(id);
        return {
          type: "page" as const,
          id,
          status: err ? "error" as const : dryRun ? "skipped" as const : "done" as const,
          action: err ? undefined : dryRun ? "would-delete" : "deleted",
          error: err,
        };
      });
      fs.writeFileSync(opts.result, JSON.stringify({ items }, null, 2), "utf-8");
    }

    const errorFile = writePurgeErrorReport(result);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
      process.exit(1);
    } else if (!dryRun) {
      console.log(
        opts.permanent
          ? "✅ Purge complete — pages hard-deleted.\n"
          : "✅ Purge complete — pages moved to trash. Empty Trash in the CMS admin to remove them permanently.\n"
      );
    }
  });

// ─── catalog subcommand ───────────────────────────────────────────────────────

program
  .command("catalog")
  .description("List pages in an environment (read-only) as a selectable catalog")
  .option("--env <role>", "Environment to read: source | target", "source")
  .option("--filter <file>", "Advanced filter JSON (or @file); applied at catalog list time", "")
  .option("--out <file>", "Write catalog JSON to this file (omit to print summary only)", "")
  .action(async (opts: { env: string; filter: string; out: string }) => {
    const role: EnvRole = opts.env === "target" ? "target" : "source";
    const env = resolveEnvironment(role);
    const client = createClient(env);
    const filterSpec = parseFilterCliOption(opts.filter);

    console.log("\n📚 Page Builder — Catalog");
    console.log("─".repeat(40));
    console.log(`  Environment  : ${role} (tenant ${env.tenant})`);
    console.log(`  Admin GQL    : ${env.adminGqlUrl}`);
    if (filterSpec) console.log(`  Filter       : frozen at ${filterSpec.frozenAt}`);
    console.log("─".repeat(40));

    process.stdout.write("\n  Verifying endpoint...");
    await client.ping();
    console.log(" ✓");

    const section = await catalogPages(client, filterSpec);
    const catalog = buildCatalog({ role, tenant: env.tenant, locale: getLocale() }, [section], new Date().toISOString());

    const withDeps = section.items.filter((i) => (i.dependsOn?.length ?? 0) > 0).length;
    console.log(`\n  ${section.total} page item(s)${section.note ? ` — note: ${section.note}` : ""}`);
    if (withDeps) console.log(`  ${withDeps} page(s) reference files`);
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
