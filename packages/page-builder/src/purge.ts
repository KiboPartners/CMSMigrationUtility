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

export interface PurgeResult {
  total: number;
  deleted: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
}

/**
 * Narrowing filter for --select. Keeps an item when `onlyIds` is empty/absent
 * (current behavior), or when ANY of its keys is in the selection set.
 * Pages are matched by id / pid / entryId / path / slug — any one matching keeps it.
 */
function selectedFilter(
  onlyIds: Set<string> | null | undefined,
  ...keys: Array<string | null | undefined>
): boolean {
  if (!onlyIds || onlyIds.size === 0) return true;
  return keys.some((k) => k != null && k !== "" && onlyIds.has(k));
}

/** Collect a page's identifier keys (id/pid/entryId/path/slug) for selection matching. */
function pageKeys(page: Record<string, unknown>): Array<string | undefined> {
  return ["id", "pid", "entryId", "path", "slug"].map((f) =>
    typeof page[f] === "string" ? (page[f] as string) : undefined
  );
}

// ─── GQL helpers ─────────────────────────────────────────────────────────────

function buildDeletePageMutation(ops: PageBuilderOps, permanently = false): string {
  // `options: { permanently: false }` is REQUIRED for a soft delete (page → Trash,
  // recoverable). Without it the API hard-deletes. Pass permanently=true to skip
  // the Trash and delete unrecoverably.
  const inner = `
    ${ops.deletePage!}(id: $id, options: { permanently: ${permanently} }) {
      data
      error { message }
    }`;
  return `mutation DeletePage($id: ID!) { ${wrap(ops.mutNamespace, inner)} }`;
}

function buildListAllPagesQuery(ops: PageBuilderOps, cursor: string | null): string {
  const hasCursor = !!cursor;
  const vars = hasCursor ? "($after: String)" : "";
  const args = ["limit: 50", ...(hasCursor ? ["after: $after"] : [])].join(", ");
  // Only request identifier fields that actually exist on the page type.
  // pid  = Kibo CMS stable page ID (preserved when a page is cloned to another env)
  // path / slug = only if the type has them (they don't exist on WbPage)
  const extraFields = [
    ops.pageKeyFields.hasPid  ? "pid"  : "",
    ops.pageKeyFields.hasPath ? "path" : "",
    ops.pageKeyFields.hasSlug ? "slug" : "",
  ].filter(Boolean).join(" ");
  const inner = `
    ${ops.listPages}(${args}) {
      data { id${extraFields ? " " + extraFields : ""} }
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
      const row = p as Record<string, string>;
      // Always index by the page's own id (works when purging with a target export).
      if (row["id"])   index.set(row["id"],   row["id"]);
      // Also index by stable identifiers present on some Kibo CMS versions.
      if (row["pid"])  index.set(row["pid"],  row["id"]);
      if (row["path"]) index.set(row["path"], row["id"]);
      if (row["slug"]) index.set(row["slug"], row["id"]);
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
  // Try every identifier field — id works for target exports, pid/path/slug for source exports.
  for (const field of ["id", "pid", "path", "slug"]) {
    const v = typeof page[field] === "string" ? (page[field] as string) : "";
    if (v && index.has(v)) return index.get(v)!;
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
    const resp = await client.request<Resp>(buildDeletePageMutation(ops, permanently), { id: pageId });
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
  const selectedPages = pages.filter((page) =>
    selectedFilter(onlyIds, ...pageKeys(page as Record<string, unknown>))
  );

  const result: PurgeResult = { total: selectedPages.length, deleted: 0, skipped: 0, errors: [] };
  logger.log(`  Found ${selectedPages.length} pages`);

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