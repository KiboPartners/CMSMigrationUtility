/**
 * Purge step: delete redirects from the target Website Builder.
 *
 * Two modes:
 *   export-based  Uses redirects.json as the manifest — pre-fetches all
 *                 target redirects, then deletes matching ones by redirectFrom.
 *                 Safe: only removes what was cloned.
 *
 *   --all         Lists and deletes every redirect on the target. Destructive.
 *
 * Always dry-runs unless --confirm is passed.
 */

import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import { GraphQLClient, logger } from "@kibo-cms-clone-tool/shared";
import { ExportFile } from "./export";

export interface PurgeStats {
  total: number;
  deleted: number;
  skipped: number;
  errors: Array<{ from: string; error: string }>;
}

/**
 * Narrowing filter for --select. Keeps an item when `onlyIds` is empty/absent
 * (current behavior), or when any of its keys is in the selection set.
 */
function selectedFilter(
  onlyIds: Set<string> | null | undefined,
  ...keys: Array<string | null | undefined>
): boolean {
  if (!onlyIds || onlyIds.size === 0) return true;
  return keys.some((k) => k != null && k !== "" && onlyIds.has(k));
}

// ─── GraphQL operations ───────────────────────────────────────────────────────

const DELETE_REDIRECT_MUTATION = /* GraphQL */ `
  mutation DeleteRedirect($id: ID!) {
    websiteBuilder {
      deleteRedirect(id: $id) {
        data
        error { message }
      }
    }
  }
`;

const LIST_ALL_REDIRECTS_QUERY = /* GraphQL */ `
  query ListAllRedirects($after: String, $limit: Int) {
    websiteBuilder {
      listRedirects(after: $after, limit: $limit) {
        data {
          id
          redirectFrom
        }
        meta {
          cursor
          hasMoreItems
          totalCount
        }
        error {
          message
        }
      }
    }
  }
`;

interface ListRedirectsResponse {
  websiteBuilder: {
    listRedirects: {
      data: Array<{ id: string; redirectFrom: string }>;
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

interface DeleteRedirectResponse {
  websiteBuilder: {
    deleteRedirect: { data: boolean | null; error: { message: string } | null };
  };
}

// ─── Fetch all target redirects into a map ────────────────────────────────────

/**
 * Returns a map of redirectFrom → id for every redirect currently on the target.
 * Uses the same paginated LIST_ALL_REDIRECTS_QUERY — no `where` input type needed,
 * so it works regardless of the Kibo CMS version's exact input type name.
 */
async function fetchTargetRedirectIndex(
  client: GraphQLClient
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListRedirectsResponse = await client.request<ListRedirectsResponse>(
      LIST_ALL_REDIRECTS_QUERY,
      { after: cursor, limit: 100 }
    );
    const result: ListRedirectsResponse["websiteBuilder"]["listRedirects"] =
      resp.websiteBuilder.listRedirects;
    if (result.error) throw new Error(result.error.message);
    for (const r of result.data) {
      index.set(r.redirectFrom, r.id);
    }
    cursor = result.meta.cursor ?? null;
    hasMore = result.meta.hasMoreItems ?? false;
  }

  return index;
}

// ─── Single redirect delete ───────────────────────────────────────────────────

/** Messages that Kibo CMS emits after a successful delete but before it can return the result. */
function isPostDeleteNoise(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes("tried to get value from a failed result") ||
         lower.includes("cannot return null for non-nullable field");
}

async function deleteRedirectById(
  client: GraphQLClient,
  id: string
): Promise<"deleted" | "not_found" | { error: string }> {
  try {
    const resp = await client.request<DeleteRedirectResponse>(DELETE_REDIRECT_MUTATION, { id });
    const result = resp.websiteBuilder.deleteRedirect;
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
  exportFile: ExportFile,
  dryRun: boolean,
  concurrency = 5,
  onlyIds?: Set<string> | null
): Promise<PurgeStats> {
  // Narrow to the selected redirects (match by redirectFrom).
  const selected = exportFile.redirects.filter((r) => selectedFilter(onlyIds, r.redirectFrom));

  const stats: PurgeStats = {
    total: selected.length,
    deleted: 0,
    skipped: 0,
    errors: [],
  };

  if (selected.length === 0) return stats;

  logger.log(`\n  🗑  Purging ${selected.length} redirect(s) (looking up by redirectFrom)...`);

  if (dryRun) {
    logger.log(`  [dry-run] Would look up and delete ${selected.length} redirect(s)`);
    stats.skipped = selected.length;
    return stats;
  }

  // Pre-fetch all target redirects once — avoids per-item queries and
  // doesn't depend on the `where` input type name being correct.
  logger.log("  Fetching existing redirects from target...");
  const targetIndex = await fetchTargetRedirectIndex(client);
  logger.log(`  ${targetIndex.size} redirect(s) found on target\n`);

  const limit = pLimit(concurrency);
  let processed = 0;

  const tasks = selected.map((redirect) =>
    limit(async () => {
      const targetId = targetIndex.get(redirect.redirectFrom);
      if (!targetId) {
        stats.skipped++;
      } else {
        const outcome = await deleteRedirectById(client, targetId);
        if (outcome === "deleted") stats.deleted++;
        else if (outcome === "not_found") stats.skipped++;
        else stats.errors.push({ from: redirect.redirectFrom, error: outcome.error });
      }

      processed++;
      if (processed % 50 === 0 || processed === selected.length) {
        logger.write(`\r  Progress: ${processed}/${selected.length}`);
      }
    })
  );

  await Promise.all(tasks);
  logger.write("\n");
  return stats;
}

// ─── All-redirects purge ──────────────────────────────────────────────────────

export async function purgeAllRedirects(
  client: GraphQLClient,
  dryRun: boolean,
  concurrency = 5,
  onlyIds?: Set<string> | null
): Promise<PurgeStats> {
  logger.log("\n  🔍 Listing all redirects on target...");

  const redirects: Array<{ id: string; redirectFrom: string }> = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListRedirectsResponse = await client.request<ListRedirectsResponse>(
      LIST_ALL_REDIRECTS_QUERY,
      { after: cursor, limit: 100 }
    );
    const result: ListRedirectsResponse["websiteBuilder"]["listRedirects"] =
      resp.websiteBuilder.listRedirects;
    if (result.error) throw new Error(result.error.message);
    redirects.push(...result.data);
    cursor = result.meta.cursor ?? null;
    hasMore = result.meta.hasMoreItems ?? false;
  }

  // Narrow to the selected redirects (match by redirectFrom).
  const selected = redirects.filter((r) => selectedFilter(onlyIds, r.redirectFrom));

  const stats: PurgeStats = { total: selected.length, deleted: 0, skipped: 0, errors: [] };
  logger.log(`  Found ${selected.length} redirect(s)`);

  if (selected.length === 0) return stats;

  if (dryRun) {
    logger.log(`  [dry-run] Would delete ${selected.length} redirect(s)`);
    stats.skipped = selected.length;
    return stats;
  }

  logger.log("  🗑  Deleting...");
  const limit = pLimit(concurrency);
  let processed = 0;

  const tasks = selected.map((redirect) =>
    limit(async () => {
      const outcome = await deleteRedirectById(client, redirect.id);
      if (outcome === "deleted") stats.deleted++;
      else if (outcome === "not_found") stats.skipped++;
      else stats.errors.push({ from: redirect.redirectFrom, error: outcome.error });

      processed++;
      if (processed % 50 === 0 || processed === selected.length) {
        logger.write(`\r  Progress: ${processed}/${selected.length}`);
      }
    })
  );

  await Promise.all(tasks);
  logger.write("\n");
  return stats;
}

// ─── Summary + error report ───────────────────────────────────────────────────

export function printPurgeSummary(stats: PurgeStats): void {
  logger.log("\n" + "═".repeat(55));
  logger.log("  REDIRECT PURGE SUMMARY");
  logger.log("═".repeat(55));
  logger.log(`  Total   : ${stats.total}`);
  logger.log(`  Deleted : ${stats.deleted}`);
  logger.log(`  Skipped : ${stats.skipped}  (not found on target)`);
  logger.log(`  Errors  : ${stats.errors.length}`);
  logger.log("═".repeat(55) + "\n");
}

export function writePurgeErrorReport(stats: PurgeStats): string | null {
  if (stats.errors.length === 0) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `redirect-purge-errors-${timestamp}.json`;
  const filepath = path.resolve(process.cwd(), filename);
  fs.writeFileSync(filepath, JSON.stringify(stats.errors, null, 2), "utf-8");
  return filepath;
}
