/**
 * Purge step: delete Page Builder pages from the target environment.
 *
 * Two modes:
 *   export-based  Uses pages.json as the manifest — looks up each page by
 *                 path/slug on the target and deletes it. Safe.
 *
 *   --all         Lists and deletes every page on the target. Destructive.
 *
 * Always dry-runs unless --confirm is passed.
 */

import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import { GraphQLClient, logger } from "@kibo-cms-clone-tool/shared";
import { PageBuilderOps } from "./ops";
import { wrap } from "./categories";
import { ExportFile, PbPage } from "./export";
import { ImportConfig } from "./config";
export { selectedFilter, barePageId, pageKeys, pagePathOf } from "./page-ids";
import { selectedFilter, pageKeys } from "./page-ids";

export interface PurgeResult {
  total: number;
  deleted: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
}

// ─── GQL helpers ─────────────────────────────────────────────────────────────

/**
 * Build deletePage mutation.
 * Kibo: permanently must be sent — omit ⇒ hard delete; false ⇒ soft (Trash); true ⇒ hard.
 */
export function buildDeletePageMutation(ops: PageBuilderOps, permanently = false): string {
  if (ops.deletePagePermanentArg === "options") {
    const inner = `
    ${ops.deletePage!}(id: $id, options: { permanently: ${permanently} }) {
      data
      error { code message }
    }`;
    return `mutation DeletePage($id: ID!) { ${wrap(ops.mutNamespace, inner)} }`;
  }
  // Top-level permanently (Kibo WbMutation) — always bind the variable so soft delete sends false.
  const inner = `
    ${ops.deletePage!}(id: $id, permanently: $permanently) {
      data
      error { code message }
    }`;
  return `mutation DeletePage($id: ID!, $permanently: Boolean) { ${wrap(ops.mutNamespace, inner)} }`;
}

function buildListAllPagesQuery(ops: PageBuilderOps, cursor: string | null): string {
  const hasCursor = !!cursor;
  const vars = hasCursor ? "($after: String)" : "";
  const args = ["limit: 50", ...(hasCursor ? ["after: $after"] : [])].join(", ");
  // Identifier fields that exist on the page type.
  // entryId = catalog selection id (must be requested or --select never matches).
  // pid / path / slug = only if the type has them.
  const extras = [
    ops.pageKeyFields.hasEntryId ? "entryId" : "",
    ops.pageKeyFields.hasPid ? "pid" : "",
    ops.pageKeyFields.hasPath ? "path" : "",
    ops.pageKeyFields.hasSlug ? "slug" : "",
    // On Kibo, properties is JSON (no subfields) — request the scalar, not properties { path }.
    ops.pageKeyFields.hasProperties ? "properties" : "",
  ].filter(Boolean).join(" ");
  const inner = `
    ${ops.listPages}(${args}) {
      data { id${extras ? " " + extras : ""} }
      meta { cursor hasMoreItems }
      error { message }
    }`;
  return `query ListAllPages${vars} { ${wrap(ops.namespace, inner)} }`;
}

// ─── Pre-fetch all target pages into a lookup map ────────────────────────────

/**
 * Fetch every page on the target and index it by path and slug.
 * This avoids per-item `where` lookups which silently fail when the
 * `where` input type name doesn't match what the target API expects.
 */
async function fetchTargetPageIndex(
  client: GraphQLClient,
  ops: PageBuilderOps
): Promise<Map<string, string>> {
  const index = new Map<string, string>(); // path-or-slug → target page id
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    type Resp = Record<string, unknown>;
    type ListResult = {
      data: Array<{ id: string; path?: string; slug?: string }>;
      meta: { cursor: string | null; hasMoreItems: boolean };
      error: { message: string } | null;
    };

    const resp: Resp = await client.request<Resp>(
      buildListAllPagesQuery(ops, cursor),
      cursor ? { after: cursor } : {}
    );
    const nsResp = ops.namespace ? (resp[ops.namespace] as Record<string, unknown>) : resp;
    const page = nsResp[ops.listPages] as ListResult | undefined;

    if (!page) throw new Error("Unexpected response from listPages while building index");
    if (page.error) throw new Error(page.error.message);

    for (const p of page.data) {
      const row = p as Record<string, unknown>;
      const id = typeof row["id"] === "string" ? row["id"] : "";
      if (!id) continue;
      // Index every identifier the list exposed (id/entryId/pid/path/slug + bare forms).
      for (const key of pageKeys(row)) {
        if (key) index.set(key, id);
      }
    }

    cursor = page.meta.cursor ?? null;
    hasMore = page.meta.hasMoreItems ?? false;
  }

  return index;
}

/**
 * Resolve the target page ID from the pre-fetched index.
 * Tries pid (Kibo CMS stable page ID), then path, then slug.
 * pid is the best match key because it is preserved when a page is imported
 * from one environment to another (unlike the full `id` which has a revision suffix).
 */
function resolveTargetPageId(
  index: Map<string, string>,
  page: PbPage
): string | null {
  for (const key of pageKeys(page as Record<string, unknown>)) {
    if (key && index.has(key)) return index.get(key)!;
  }
  return null;
}

/** Messages that Kibo CMS emits after a successful delete but before it can return the result. */
function isPostDeleteNoise(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes("tried to get value from a failed result") ||
         lower.includes("cannot return null for non-nullable field");
}

async function deletePage(
  client: GraphQLClient,
  ops: PageBuilderOps,
  pageId: string,
  permanently = false
): Promise<"deleted" | "not_found" | { error: string }> {
  if (!ops.deletePage) return { error: "deletePage operation not available on target" };

  type Resp = Record<string, unknown>;
  type DelResult = { data: boolean | null; error: { message: string } | null };

  try {
    const vars: Record<string, unknown> = { id: pageId };
    if (ops.deletePagePermanentArg === "permanently") {
      // Must send false for soft delete — omitting the arg hard-deletes on Kibo.
      vars["permanently"] = permanently;
    }
    const resp = await client.request<Resp>(buildDeletePageMutation(ops, permanently), vars);
    const nsResp = ops.mutNamespace ? (resp[ops.mutNamespace] as Record<string, unknown>) : resp;
    const result = nsResp[ops.deletePage] as DelResult | undefined;

    if (!result) return { error: "no result returned" };
    if (result.error) {
      const msg = result.error.message.toLowerCase();
      if (msg.includes("not found") || msg.includes("does not exist")) return "not_found";
      // Kibo CMS's Result monad throws this after a successful delete when it tries
      // to read back the (now-deleted) record — treat it as a successful deletion.
      if (isPostDeleteNoise(result.error.message)) return "deleted";
      return { error: result.error.message };
    }
    return "deleted";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("does not exist")) return "not_found";
    if (isPostDeleteNoise(msg)) return "deleted";
    return { error: msg };
  }
}

// ─── Export-based purge ───────────────────────────────────────────────────────

export async function purgeFromExportFile(
  client: GraphQLClient,
  ops: PageBuilderOps,
  exportFile: ExportFile,
  dryRun: boolean,
  concurrency = 5,
  permanently = false,
  onlyIds?: Set<string> | null
): Promise<PurgeResult> {
  // Narrow to selected pages (match by any of id/pid/entryId/path/slug).
  const selectedPages = exportFile.pages.filter((page) =>
    selectedFilter(onlyIds, ...pageKeys(page as Record<string, unknown>))
  );

  const result: PurgeResult = {
    total: selectedPages.length,
    deleted: 0,
    skipped: 0,
    errors: [],
  };

  if (selectedPages.length === 0) return result;

  logger.log(`\n  🗑  Purging ${selectedPages.length} pages (looking up by path/slug)...`);

  if (dryRun) {
    logger.log(`  [dry-run] Would look up and delete ${selectedPages.length} pages`);
    result.skipped = selectedPages.length;
    return result;
  }

  // Pre-fetch all target pages once — avoids per-item `where` queries that
  // silently fail when the `where` input type name doesn't match the target API.
  logger.log("  🔍 Pre-fetching target page index...");
  const targetIndex = await fetchTargetPageIndex(client, ops);
  logger.log(`  Indexed ${targetIndex.size} target page entries (by path/slug)`);

  const limit = pLimit(concurrency);
  let processed = 0;

  const tasks = selectedPages.map((page) =>
    limit(async () => {
      const label = (page["path"] as string | undefined) ?? (page["slug"] as string | undefined) ?? (page["id"] as string | undefined) ?? "?";

      // Resolve the target page ID from the pre-fetched index.
      // The index is keyed by id, pid, path, and slug — whichever fields WbPage exposes.
      // Using the export's `id` directly works when the export was taken from the target.
      // Using pid/path/slug works when the export came from the source environment.
      const targetId = resolveTargetPageId(targetIndex, page);
      if (!targetId) {
        result.skipped++;
      } else {
        const outcome = await deletePage(client, ops, targetId, permanently);
        if (outcome === "deleted") result.deleted++;
        else if (outcome === "not_found") result.skipped++;
        else result.errors.push({ id: label, error: outcome.error });
      }

      processed++;
      if (processed % 25 === 0 || processed === selectedPages.length) {
        logger.write(`\r  Progress: ${processed}/${selectedPages.length}`);
      }
    })
  );

  await Promise.all(tasks);
  logger.write("\n");
  return result;
}

// ─── All-pages purge ──────────────────────────────────────────────────────────

export async function purgeAllPages(
  client: GraphQLClient,
  ops: PageBuilderOps,
  dryRun: boolean,
  concurrency = 5,
  permanently = false,
  onlyIds?: Set<string> | null
): Promise<PurgeResult> {
  logger.log("\n  🔍 Listing all pages on target...");

  const pages: Array<{ id: string }> = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    type Resp = Record<string, unknown>;
    type ListResult = {
      data: Array<{ id: string }>;
      meta: { cursor: string | null; hasMoreItems: boolean };
      error: { message: string } | null;
    };

    const resp = await client.request<Resp>(buildListAllPagesQuery(ops, cursor), cursor ? { after: cursor } : {});
    const nsResp = ops.namespace ? (resp[ops.namespace] as Record<string, unknown>) : resp;
    const page = nsResp[ops.listPages] as ListResult | undefined;

    if (!page) throw new Error("Unexpected response from listPages");
    if (page.error) throw new Error(page.error.message);

    pages.push(...page.data);
    cursor = page.meta.cursor ?? null;
    hasMore = page.meta.hasMoreItems ?? false;
  }

  // Narrow to selected pages (match by any of id/pid/entryId/path/slug the list exposed).
  const hasSelection = !!onlyIds && onlyIds.size > 0;
  const selectedPages = pages.filter((page) =>
    selectedFilter(onlyIds, ...pageKeys(page as Record<string, unknown>))
  );

  const result: PurgeResult = { total: selectedPages.length, deleted: 0, skipped: 0, errors: [] };
  if (hasSelection) {
    logger.log(`  Found ${pages.length} page(s) on target; ${selectedPages.length} match --select`);
    if (pages.length > 0 && selectedPages.length === 0) {
      logger.warn(
        `  ⚠  None of the ${onlyIds!.size} selected id(s) matched a target page (entryId/id/path). ` +
          `Re-catalog the target and try again.`
      );
    }
  } else {
    logger.log(`  Found ${selectedPages.length} pages`);
  }

  if (selectedPages.length === 0) return result;

  if (dryRun) {
    logger.log(`  [dry-run] Would delete ${selectedPages.length} pages`);
    result.skipped = selectedPages.length;
    return result;
  }

  logger.log("  🗑  Deleting...");
  const limit = pLimit(concurrency);
  let processed = 0;

  const tasks = selectedPages.map((page) =>
    limit(async () => {
      const outcome = await deletePage(client, ops, page.id, permanently);
      if (outcome === "deleted") result.deleted++;
      else if (outcome === "not_found") result.skipped++;
      else result.errors.push({ id: page.id, error: outcome.error });

      processed++;
      if (processed % 25 === 0 || processed === selectedPages.length) {
        logger.write(`\r  Progress: ${processed}/${selectedPages.length}`);
      }
    })
  );

  await Promise.all(tasks);
  logger.write("\n");
  return result;
}

// ─── Summary + error report ───────────────────────────────────────────────────

export function printPurgeSummary(result: PurgeResult): void {
  logger.log("\n" + "═".repeat(55));
  logger.log("  PAGE PURGE SUMMARY");
  logger.log("═".repeat(55));
  logger.log(`  Total   : ${result.total}`);
  logger.log(`  Deleted : ${result.deleted}`);
  logger.log(`  Skipped : ${result.skipped}`);
  logger.log(`  Errors  : ${result.errors.length}`);
  logger.log("═".repeat(55) + "\n");
}

export function writePurgeErrorReport(result: PurgeResult): string | null {
  if (result.errors.length === 0) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `page-purge-errors-${timestamp}.json`;
  const filepath = path.resolve(process.cwd(), filename);
  fs.writeFileSync(filepath, JSON.stringify(result.errors, null, 2), "utf-8");
  return filepath;
}