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
import { createClient, resolveEnvironment, loadRootEnv, buildCatalog, catalogSize, getLocale, EnvRole, parseSelection, assertPurgeTargetSafe, purgeWarning } from "@kibo-cms-clone-tool/shared";
import { catalogPages } from "./src/catalog";
import { loadExportConfig, loadImportConfig } from "./src/config";
import { exportPages } from "./src/export";
import { importPages, readExportFile } from "./src/pages";
import { printSummary, writeErrorReport } from "./src/report";
import { discoverPageBuilderOps } from "./src/ops";
import {
  purgeAllPages,
  printPurgeSummary,
  writePurgeErrorReport,
} from "./src/purge";

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
  .option("--out <dir>", "Output directory", "./export/pages")
  .action(async (opts: { locale: string; includeUnpublished: string; out: string }) => {
    const config = loadExportConfig(opts);

    console.log("\n📤 Page Builder — Export");
    console.log("─".repeat(40));
    console.log(`  Source             : ${config.sourceAdminGqlUrl}`);
    console.log(`  Locale             : ${config.locale}`);
    console.log(`  Include Unpublished: ${config.includeUnpublished}`);
    console.log(`  Out dir            : ${config.outDir}`);
    console.log("─".repeat(40) + "\n");

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const sourceClient = createClient(resolveEnvironment("source"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    const { pageCount, categoryCount, filePath } = await exportPages(sourceClient, config);

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
  .action(async (opts: { in: string; locale: string; concurrency: string; dryRun: boolean; select: string; allowFolderMismatch: boolean; result: string }) => {
    const config = loadImportConfig({ dir: opts.in, locale: opts.locale, concurrency: opts.concurrency, dryRun: opts.dryRun, allowFolderMismatch: opts.allowFolderMismatch });
    const selection = opts.select ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"))) : null;

    console.log("\n📥 Page Builder — Import");
    console.log("─".repeat(40));
    console.log(`  Target      : ${config.targetAdminGqlUrl}`);
    console.log(`  Source dir  : ${config.dir}`);
    console.log(`  Concurrency : ${config.concurrency}`);
    console.log(`  Dry Run     : ${config.dryRun}`);
    if (config.sourceCdnDomain && config.targetCdnDomain) {
      console.log(`  CDN Rewrite : ${config.sourceCdnDomain} → ${config.targetCdnDomain}`);
    }
    console.log("─".repeat(40));

    const exportFile = readExportFile(config.dir);
    if (selection) {
      const before = exportFile.pages.length;
      exportFile.pages = exportFile.pages.filter((p) => selection.has(String((p as { entryId?: string }).entryId ?? "")));
      console.log(`\n  Selection: ${selection.size} id(s) → ${exportFile.pages.length} of ${before} page(s)`);
      if (exportFile.pages.length === 0 && selection.size > 0) {
        console.warn(`  ⚠  None of the ${selection.size} selected id(s) are in this export — the export dir is stale or from another tenant. Re-export before importing.`);
      }
    }
    console.log(
      `\n  Loaded ${exportFile.pages.length} pages, ${exportFile.categories.length} categories from ${config.dir}/pages.json`
    );

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const targetClient = createClient(resolveEnvironment("target"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    process.stdout.write("\n  Verifying target endpoint...");
    await targetClient.ping();
    console.log(" ✓\n");

    const result = await importPages(targetClient, exportFile, config);

    printSummary(result);

    if (opts.result) {
      // Map every error key (slug + id) to its message, then match a page by any
      // of its identifiers (id / entryId / slug) and carry the real error text.
      const errMsg = new Map<string, string>();
      for (const e of result.errors) { if (e.slug) errMsg.set(e.slug, e.error); if (e.id) errMsg.set(e.id, e.error); }
      const items = exportFile.pages.map((p) => {
        const rec = p as { entryId?: string; id?: string; slug?: string };
        const eid = String(rec.entryId ?? rec.id ?? "");
        const msg = errMsg.get(String(rec.id ?? "")) ?? errMsg.get(eid) ?? (rec.slug ? errMsg.get(rec.slug) : undefined);
        return { type: "page" as const, id: eid, status: msg ? "error" : "done", error: msg };
      });
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
  .action(async (opts: { confirm: boolean; force: boolean; permanent: boolean; allowSameTenant: boolean; select: string; locale: string; concurrency: string }) => {
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
    console.log(`  Mode        : all pages → trash`);
    console.log(`  Concurrency : ${concurrency}`);
    console.log(`  Dry Run     : ${dryRun}`);
    if (dryRun) {
      console.log("\n  ⚠  DRY RUN — pass --force to execute (or --confirm to see the warning)");
    }
    console.log("─".repeat(40));

    if (!dryRun && !opts.force) {
      console.error(purgeWarning(
        opts.permanent
          ? "ALL pages on the target — PERMANENT hard delete (skips Trash, unrecoverable)"
          : "ALL pages on the target — soft delete to Trash (recoverable)",
        config.targetTenant,
        "Soft-deleted pages can be restored from Trash in the CMS admin; --permanent cannot."
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

    const errorFile = writePurgeErrorReport(result);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
    } else if (!dryRun) {
      console.log("✅ Purge complete — pages moved to trash. Empty Trash in the CMS admin to remove them permanently.\n");
    }
  });

// ─── catalog subcommand ───────────────────────────────────────────────────────

program
  .command("catalog")
  .description("List pages in an environment (read-only) as a selectable catalog")
  .option("--env <role>", "Environment to read: source | target", "source")
  .option("--out <file>", "Write catalog JSON to this file (omit to print summary only)", "")
  .action(async (opts: { env: string; out: string }) => {
    const role: EnvRole = opts.env === "target" ? "target" : "source";
    const env = resolveEnvironment(role);
    const client = createClient(env);

    console.log("\n📚 Page Builder — Catalog");
    console.log("─".repeat(40));
    console.log(`  Environment  : ${role} (tenant ${env.tenant})`);
    console.log(`  Admin GQL    : ${env.adminGqlUrl}`);
    console.log("─".repeat(40));

    process.stdout.write("\n  Verifying endpoint...");
    await client.ping();
    console.log(" ✓");

    const section = await catalogPages(client);
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

program.parse(process.argv);
