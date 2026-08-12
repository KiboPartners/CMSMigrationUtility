/**
 * Redirects Cloner — Entry Point
 *
 * Two-step workflow:
 *
 *   Step 1 — Export all redirects from source to a local JSON file:
 *     npx ts-node index.ts export --out ./export/redirects
 *
 *   Step 2 — Review/edit redirects.json, then import:
 *     npx ts-node index.ts import --in ./export/redirects --dry-run
 *     npx ts-node index.ts import --in ./export/redirects
 *
 * Upsert behaviour on import:
 *   - Redirect with same "from" path already in target → update if different
 *   - Not found → create
 *   - Same "from" and "to" and type → skip (unchanged)
 */

import fs from "fs";
import { Command } from "commander";
import { createClient, resolveEnvironment, loadRootEnv, buildCatalog, catalogSize, getLocale, EnvRole, parseSelection, assertPurgeTargetSafe, purgeWarning, parseFilterCliOption } from "@kibo-cms-clone-tool/shared";
import { catalogRedirects } from "./catalog";
import { loadExportConfig, loadImportConfig } from "./config";
import { exportRedirects } from "./export";
import { importRedirects, readRedirectsManifest, collectSourceRedirects } from "./clone";
import { printSummary, writeErrorReport } from "./report";
import {
  purgeFromExportFile,
  purgeAllRedirects,
  printPurgeSummary,
  writePurgeErrorReport,
} from "./purge";

loadRootEnv();

const program = new Command();

program
  .name("redirects")
  .description("Redirects Clone Tool — export from source, clone to target");

// ─── export subcommand ────────────────────────────────────────────────────────

program
  .command("export")
  .description("Export all redirects from source Website Builder to a local JSON file")
  .option("--filter <file>", "Advanced filter JSON (or @file); dates/from/to pushdown", "")
  .option("--select <ids>", "Export only these redirectFrom paths (comma-separated, or @file). Default: all", "")
  .option("--out <dir>", "Directory to write exported JSON", "./export/redirects")
  .action(async (opts: { filter: string; select: string; out: string }) => {
    const filterSpec = parseFilterCliOption(opts.filter);
    const selection = opts.select
      ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8")))
      : null;
    if (opts.select && selection && selection.size === 0) {
      console.error("\n❌ --select resolved to 0 ids — refusing to export. Check the ids file / selection.");
      process.exit(1);
    }
    const config = loadExportConfig({ ...opts, filterSpec });

    console.log("\n📤 Redirects — Export");
    console.log("─".repeat(40));
    console.log(`  Source  : ${config.sourceAdminGqlUrl}`);
    console.log(`  Tenant  : ${config.sourceTenant}`);
    console.log(`  Out dir : ${config.outDir}`);
    if (selection) console.log(`  Selection: ${selection.size} redirectFrom value(s)`);
    if (filterSpec) console.log(`  Filter  : frozen at ${filterSpec.frozenAt}`);
    console.log("─".repeat(40));

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const sourceClient = createClient(resolveEnvironment("source"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    const { redirectCount, folderCount, filePath } = await exportRedirects(sourceClient, config, selection);

    console.log(`\n✅ Export complete: ${redirectCount} redirect(s), ${folderCount} folder(s) → ${filePath}`);
    console.log("\n   Review / edit redirects.json, then run:");
    console.log(`   npx ts-node index.ts import --in ${config.outDir}\n`);
  });

// ─── import subcommand ────────────────────────────────────────────────────────

program
  .command("import")
  .description("Import redirects from local JSON file into target environment")
  .option("--in <dir>", "Directory containing exported redirects.json", "./export/redirects")
  .option("--concurrency <n>", "Parallel writes to target", process.env["CONCURRENCY"] ?? "5")
  .option("--dry-run", "Preview without writing to target", process.env["DRY_RUN"] === "true")
  .option("--select <ids>", "Import only these redirectFrom paths (comma-separated, or @file). Default: all", "")
  .option("--allow-folder-mismatch", "Import even if some folders failed to sync (items fall back to root)", false)
  .option("--result <file>", "Write per-item results JSON (for the run ledger)", "")
  .action(async (opts: { in: string; concurrency: string; dryRun: boolean; select: string; allowFolderMismatch: boolean; result: string }) => {
    const config = loadImportConfig({ dir: opts.in, concurrency: opts.concurrency, dryRun: opts.dryRun, allowFolderMismatch: opts.allowFolderMismatch });
    const selection = opts.select ? new Set(parseSelection(opts.select, (p) => fs.readFileSync(p, "utf-8"))) : null;

    console.log("\n📥 Redirects — Import");
    console.log("─".repeat(40));
    console.log(`  Target      : ${config.targetAdminGqlUrl}`);
    console.log(`  Tenant      : ${config.targetTenant}`);
    console.log(`  In dir      : ${config.dir}`);
    console.log(`  Concurrency : ${config.concurrency}`);
    console.log(`  Dry Run     : ${config.dryRun}`);
    console.log("─".repeat(40));

    // Read the (small) metadata sidecar — redirects themselves are streamed
    // later, never buffered as one big array here (unless legacy export).
    const source = readRedirectsManifest(config.dir);
    if (selection) {
      console.log(`\n  Selection: ${selection.size} id(s) — filtered per redirect while streaming`);
    }
    console.log(
      `\n  Loaded redirects source${source.ndjsonPath ? " (streaming)" : ` (${source.legacyRedirects?.length ?? 0} redirects)`}` +
        ` from ${config.dir}/redirects.json`
    );

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const targetClient = createClient(resolveEnvironment("target"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    process.stdout.write("\n  Verifying target endpoint...");
    await targetClient.ping();
    console.log(" ✓\n");

    const stats = await importRedirects(targetClient, source, config, selection);

    printSummary(stats);

    if (stats.total === 0 && selection && selection.size > 0) {
      console.warn(`  ⚠  None of the ${selection.size} selected id(s) matched a redirect in this export — the export dir is stale or from another tenant. Re-export before importing.`);
    }

    if (opts.result) {
      // Per-item results for the run ledger (mapped from the streaming outcomes).
      const items = stats.items.map((it) => ({
        type: "redirect" as const,
        id: it.id,
        status: it.action === "error" ? "error" : "done",
        error: it.error,
      }));
      fs.writeFileSync(opts.result, JSON.stringify({ items }, null, 2), "utf-8");
    }

    const errorFile = writeErrorReport(stats);
    if (errorFile) {
      console.log(`⚠  Errors written to: ${errorFile}`);
    } else {
      console.log("✅ Import complete — no errors.\n");
    }
  });

// ─── purge subcommand ─────────────────────────────────────────────────────────

program
  .command("purge")
  .description("Delete redirects from the target environment (dry-run by default)")
  .option("--in <dir>", "Export dir to use as deletion manifest (export-based mode)", "./export/redirects")
  .option("--all", "Delete ALL redirects on target (ignores --in)", false)
  .option("--confirm", "Preview the purge warning (omit for dry-run)", false)
  .option("--force", "Skip the warning and actually delete (required for a real purge)", false)
  .option("--allow-same-tenant", "Permit purging when TARGET_TENANT equals SOURCE_TENANT", false)
  .option("--select <ids>", "Narrow the purge to these redirectFrom values (comma-separated or @file)", "")
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

    const config = loadImportConfig({ dir: opts.in, concurrency: opts.concurrency, dryRun });

    console.log("\n🗑  Redirects — Purge");
    console.log("─".repeat(40));
    console.log(`  Target      : ${config.targetAdminGqlUrl}`);
    console.log(`  Tenant      : ${config.targetTenant}`);
    const modeLabel = opts.all
      ? (onlyIds && onlyIds.size
          ? `--all narrowed by --select (${onlyIds.size} id(s))`
          : "--all (every redirect on target)")
      : `export-based (${opts.in})`;
    console.log(`  Mode        : ${modeLabel}`);
    console.log(`  Concurrency : ${concurrency}`);
    console.log(`  Dry Run     : ${dryRun}`);
    if (dryRun) {
      console.log("\n  ⚠  DRY RUN — pass --force to execute (omit flags to preview)");
    }
    if (!dryRun && !opts.force) {
      console.error(purgeWarning(
        "redirects on the target",
        config.targetTenant,
        "Redirects are permanently deleted; re-import to restore them."
      ));
      process.exit(1);
    }
    console.log("─".repeat(40));

    if (config.rateLimitDelay > 0) console.log(`  Rate limit   : ${config.rateLimitDelay}ms between requests`);
    if (config.debug)              console.log("  Debug        : on");

    const targetClient = createClient(resolveEnvironment("target"), { locale: config.locale, rateLimit: config.rateLimitDelay, debug: config.debug });

    process.stdout.write("\n  Verifying target endpoint...");
    await targetClient.ping();
    console.log(" ✓");

    let stats;

    if (opts.all) {
      stats = await purgeAllRedirects(targetClient, dryRun, concurrency, onlyIds);
    } else {
      const source = readRedirectsManifest(config.dir);
      const redirects = await collectSourceRedirects(source);
      console.log(`\n  Loaded ${redirects.length} redirect(s) from ${config.dir}/redirects.json`);
      stats = await purgeFromExportFile(
        targetClient,
        { redirects } as unknown as Parameters<typeof purgeFromExportFile>[1],
        dryRun,
        concurrency,
        onlyIds
      );
    }

    printPurgeSummary(stats);

    if (opts.result && onlyIds && onlyIds.size) {
      const errByFrom = new Map(stats.errors.map((e) => [e.from, e.error] as const));
      const items = [...onlyIds].map((id) => {
        const err = errByFrom.get(id);
        return {
          type: "redirect" as const,
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
  .description("List redirects in an environment (read-only) as a selectable catalog")
  .option("--env <role>", "Environment to read: source | target", "source")
  .option("--filter <file>", "Advanced filter JSON (or @file); applied at catalog list time", "")
  .option("--out <file>", "Write catalog JSON to this file (omit to print summary only)", "")
  .action(async (opts: { env: string; filter: string; out: string }) => {
    const role: EnvRole = opts.env === "target" ? "target" : "source";
    const env = resolveEnvironment(role);
    const client = createClient(env);
    const filterSpec = parseFilterCliOption(opts.filter);

    console.log("\n📚 Redirects — Catalog");
    console.log("─".repeat(40));
    console.log(`  Environment  : ${role} (tenant ${env.tenant})`);
    console.log(`  Admin GQL    : ${env.adminGqlUrl}`);
    if (filterSpec) console.log(`  Filter       : frozen at ${filterSpec.frozenAt}`);
    console.log("─".repeat(40));

    process.stdout.write("\n  Verifying endpoint...");
    await client.ping();
    console.log(" ✓");

    const section = await catalogRedirects(client, filterSpec);
    const catalog = buildCatalog({ role, tenant: env.tenant, locale: getLocale() }, [section], new Date().toISOString());

    console.log(`\n  ${section.total} redirect item(s)${section.note ? ` — note: ${section.note}` : ""}`);
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
