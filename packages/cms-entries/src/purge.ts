/**
 * Purge step: delete CMS entries from the target environment.
 *
 * Two modes:
 *   export-based  Uses an export JSON directory as the manifest — deletes
 *                 exactly the entries that were cloned. Safe: no risk of
 *                 removing pre-existing content.
 *
 *   --all         Lists every entry for the given models and deletes all of
 *                 them. Use with caution.
 *
 * Always dry-runs unless --confirm is passed.
 */

import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import { GraphQLClient, logger } from "@kibo-cms-clone-tool/shared";
import {
  ModelDefinition,
  buildListQuery,
  buildDeleteMutation,
  capitalize,
} from "./introspect";
import { ExportFile } from "./export";
import { ImportConfig } from "./config";

export interface PurgeModelResult {
  modelName: string;
  total: number;
  deleted: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
}

// ─── Selection filter (narrowing) ──────────────────────────────────────────────

/**
 * Narrowing filter for --select. Returns true when an item should be KEPT
 * (i.e. deleted). When `onlyIds` is null/undefined/empty, everything is kept
 * (current behavior). Otherwise only items whose key is in the set are kept.
 *
 * `key` may be one identifier or several (e.g. id / path / slug for a page);
 * the item is kept if ANY supplied key is in the selection.
 */
export function selectedFilter(
  onlyIds: Set<string> | null | undefined,
  ...keys: Array<string | null | undefined>
): boolean {
  if (!onlyIds || onlyIds.size === 0) return true;
  return keys.some((k) => k != null && k !== "" && onlyIds.has(k));
}

/** Normalize a CMS entry id to its bare entryId (strip any #revision suffix). */
function bareEntryId(value: string | null | undefined): string {
  return String(value ?? "").split("#")[0];
}

// ─── Delete single entry ──────────────────────────────────────────────────────

/** Messages that Kibo CMS emits after a successful delete but before it can return the result. */
function isPostDeleteNoise(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes("tried to get value from a failed result") ||
         lower.includes("cannot return null for non-nullable field");
}

async function deleteEntry(
  client: GraphQLClient,
  model: ModelDefinition,
  entryId: string,
  permanently = false
): Promise<"deleted" | "not_found" | "error" | { error: string }> {
  type MutResp = {
    [key: string]: { data: boolean | null; error: { message: string } | null };
  };

  try {
    const resp = await client.request<MutResp>(
      buildDeleteMutation(model, permanently),
      { revision: entryId }
    );
    const result = resp[model.deleteOperation];
    if (!result) return "error";
    if (result.error) {
      const msg = result.error.message.toLowerCase();
      if (msg.includes("not found") || msg.includes("does not exist") || msg.includes("404")) {
        return "not_found";
      }
      // Kibo CMS's Result monad throws this after a successful delete when it tries
      // to read back the (now-deleted) record — treat it as a successful deletion.
      if (isPostDeleteNoise(result.error.message)) return "deleted";
      return { error: result.error.message };
    }
    return "deleted";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("does not exist")) {
      return "not_found";
    }
    if (isPostDeleteNoise(msg)) return "deleted";
    return { error: msg };
  }
}

// ─── Export-based purge ───────────────────────────────────────────────────────

/**
 * Delete only the entries present in the export JSON files.
 * Safe to run multiple times (missing entries are skipped).
 */
export async function purgeFromExportFiles(
  client: GraphQLClient,
  exportFiles: ExportFile[],
  models: Map<string, ModelDefinition>,
  dryRun: boolean,
  concurrency = 5,
  permanently = false,
  onlyIds?: Set<string> | null
): Promise<PurgeModelResult[]> {
  const results: PurgeModelResult[] = [];

  for (const file of exportFiles) {
    const model = models.get(file.modelName);
    if (!model) {
      logger.warn(`  ⚠  No model definition for "${file.modelName}" — skipping`);
      continue;
    }

    // Narrow to the selected entryIds (match the bare id, ignoring #revision).
    const selectedEntries = file.entries.filter((entry) => {
      const entryId = (entry["entryId"] as string | undefined) ??
        bareEntryId(entry["id"] as string | undefined);
      return selectedFilter(onlyIds, entryId);
    });

    const result: PurgeModelResult = {
      modelName: model.name,
      total: selectedEntries.length,
      deleted: 0,
      skipped: 0,
      errors: [],
    };

    if (selectedEntries.length === 0) {
      results.push(result);
      continue;
    }

    logger.log(`\n  🗑  Purging ${selectedEntries.length} ${model.name} entries...`);

    if (dryRun) {
      logger.log(`  [dry-run] Would delete ${selectedEntries.length} entries`);
      result.skipped = selectedEntries.length;
      results.push(result);
      continue;
    }

    const limit = pLimit(concurrency);
    let processed = 0;

    const tasks = selectedEntries.map((entry) =>
      limit(async () => {
        const entryId = (entry["entryId"] as string | undefined) ??
          bareEntryId(entry["id"] as string | undefined);

        const outcome = await deleteEntry(client, model, entryId, permanently);

        if (outcome === "deleted") result.deleted++;
        else if (outcome === "not_found") result.skipped++;
        else if (outcome === "error") result.errors.push({ id: entryId, error: "unknown" });
        else result.errors.push({ id: entryId, error: outcome.error });

        processed++;
        if (processed % 50 === 0 || processed === selectedEntries.length) {
          logger.write(`\r  Progress: ${processed}/${selectedEntries.length}`);
        }
      })
    );

    await Promise.all(tasks);
    logger.write("\n");
    results.push(result);
  }

  return results;
}

// ─── All-entries purge ────────────────────────────────────────────────────────

/**
 * List all entries for the given models on the target and delete them.
 * This is a destructive operation — use with caution.
 */
export async function purgeAllEntries(
  client: GraphQLClient,
  models: Map<string, ModelDefinition>,
  dryRun: boolean,
  concurrency = 5,
  permanently = false,
  onlyIds?: Set<string> | null
): Promise<PurgeModelResult[]> {
  const results: PurgeModelResult[] = [];

  for (const model of models.values()) {
    logger.log(`\n  🔍 Listing all ${model.name} entries on target...`);

    const entries: Array<{ id: string; entryId: string }> = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      type ListResp = {
        [key: string]: {
          data: Array<{ id: string; entryId: string }>;
          meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
          error: { message: string } | null;
        };
      };

      const query = buildListQuery(model, undefined, cursor ?? undefined);
      const vars: Record<string, unknown> = {};
      if (cursor) vars.after = cursor;

      const resp = await client.request<ListResp>(query, vars);
      const page = resp[model.listOperation];
      if (!page) throw new Error(`Unexpected response for ${model.listOperation}`);
      if (page.error) throw new Error(page.error.message);

      entries.push(...(page.data as Array<{ id: string; entryId: string }>));
      cursor = page.meta.cursor ?? null;
      hasMore = page.meta.hasMoreItems ?? false;
    }

    // Narrow to the selected entryIds (match the bare id, ignoring #revision).
    const selectedEntries = entries.filter((entry) =>
      selectedFilter(onlyIds, entry.entryId || bareEntryId(entry.id))
    );

    const result: PurgeModelResult = {
      modelName: model.name,
      total: selectedEntries.length,
      deleted: 0,
      skipped: 0,
      errors: [],
    };

    logger.log(`  Found ${selectedEntries.length} ${model.name} entries`);

    if (selectedEntries.length === 0) {
      results.push(result);
      continue;
    }

    if (dryRun) {
      logger.log(`  [dry-run] Would delete ${selectedEntries.length} entries`);
      result.skipped = selectedEntries.length;
      results.push(result);
      continue;
    }

    logger.log(`  🗑  Deleting...`);
    const limit = pLimit(concurrency);
    let processed = 0;

    const tasks = selectedEntries.map((entry) =>
      limit(async () => {
        const entryId = entry.entryId || bareEntryId(entry.id);
        const outcome = await deleteEntry(client, model, entryId, permanently);

        if (outcome === "deleted") result.deleted++;
        else if (outcome === "not_found") result.skipped++;
        else if (outcome === "error") result.errors.push({ id: entryId, error: "unknown" });
        else result.errors.push({ id: entryId, error: outcome.error });

        processed++;
        if (processed % 50 === 0 || processed === selectedEntries.length) {
          logger.write(`\r  Progress: ${processed}/${selectedEntries.length}`);
        }
      })
    );

    await Promise.all(tasks);
    logger.write("\n");
    results.push(result);
  }

  return results;
}

// ─── Summary + error report ───────────────────────────────────────────────────

export function printPurgeSummary(results: PurgeModelResult[]): void {
  logger.log("\n" + "═".repeat(65));
  logger.log("  PURGE SUMMARY");
  logger.log("═".repeat(65));

  const header = [
    "Model".padEnd(20),
    "Total".padStart(7),
    "Deleted".padStart(9),
    "Skipped".padStart(9),
    "Errors".padStart(8),
  ].join(" │ ");

  logger.log("  " + header);
  logger.log("─".repeat(65));

  let totalDeleted = 0, totalSkipped = 0, totalErrors = 0;

  for (const r of results) {
    const row = [
      r.modelName.padEnd(20),
      String(r.total).padStart(7),
      String(r.deleted).padStart(9),
      String(r.skipped).padStart(9),
      String(r.errors.length).padStart(8),
    ].join(" │ ");
    logger.log("  " + row);
    totalDeleted += r.deleted;
    totalSkipped += r.skipped;
    totalErrors += r.errors.length;
  }

  logger.log("─".repeat(65));
  const totals = [
    "TOTAL".padEnd(20),
    String(results.reduce((s, r) => s + r.total, 0)).padStart(7),
    String(totalDeleted).padStart(9),
    String(totalSkipped).padStart(9),
    String(totalErrors).padStart(8),
  ].join(" │ ");
  logger.log("  " + totals);
  logger.log("═".repeat(65) + "\n");
}

export function writePurgeErrorReport(results: PurgeModelResult[]): string | null {
  const allErrors = results.flatMap((r) =>
    r.errors.map((e) => ({ model: r.modelName, ...e }))
  );
  if (allErrors.length === 0) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `purge-errors-${timestamp}.json`;
  const filepath = path.resolve(process.cwd(), filename);
  fs.writeFileSync(filepath, JSON.stringify(allErrors, null, 2), "utf-8");
  return filepath;
}
