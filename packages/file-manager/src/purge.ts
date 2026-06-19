/**
 * Purge step: delete file metadata from the target File Manager.
 *
 * NOTE: Only file metadata (registration) is deleted. Binary files in S3
 * are NOT removed — that requires AWS CLI access (separate operation).
 *
 * Two modes:
 *   export-based  Uses files.json as the manifest — looks up each file by
 *                 key on the target and deletes its registration. Safe.
 *
 *   --all         Lists and deletes all file registrations from the target.
 *
 * Always dry-runs unless --confirm is passed.
 */

import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import { GraphQLClient, logger } from "@kibo-cms-clone-tool/shared";
import { FileRecord, FolderRecord } from "./files";
import { ExportFile } from "./export";
import { getExistingFile } from "./files";

interface FolderPage<T> {
  data: T[];
  meta: { cursor: string | null; hasMoreItems: boolean };
  error: { message: string } | null;
}
interface ListFoldersFmResp {
  fileManager: { listFolders: FolderPage<FolderRecord> };
}
interface AcoFolder {
  id: string;
  title: string;
  slug: string;
  parentId: string | null;
}
interface ListFoldersAcoResp {
  aco: { listFolders: FolderPage<AcoFolder> };
}

export interface PurgeStats {
  total: number;
  deleted: number;
  skipped: number;
  errors: Array<{ key: string; error: string }>;
  foldersTotal: number;
  foldersDeleted: number;
  foldersSkipped: number;
  folderErrors: Array<{ id: string; name: string; error: string }>;
}

/**
 * Narrowing filter for --select. Keeps an item when `onlyIds` is empty/absent
 * (current behavior), or when ANY of its keys is in the selection set.
 * Files are matched by src / key / id — any one matching keeps it.
 */
function selectedFilter(
  onlyIds: Set<string> | null | undefined,
  ...keys: Array<string | null | undefined>
): boolean {
  if (!onlyIds || onlyIds.size === 0) return true;
  return keys.some((k) => k != null && k !== "" && onlyIds.has(k));
}

// ─── GQL operations ───────────────────────────────────────────────────────────

const DELETE_FILE_MUTATION = /* GraphQL */ `
  mutation DeleteFile($id: ID!) {
    fileManager {
      deleteFile(id: $id) {
        data
        error { message }
      }
    }
  }
`;

const LIST_ALL_FILES_QUERY = /* GraphQL */ `
  query ListAllFiles($after: String, $limit: Int) {
    fileManager {
      listFiles(after: $after, limit: $limit) {
        data { id key name }
        meta { cursor hasMoreItems totalCount }
        error { message }
      }
    }
  }
`;

interface DeleteFileResponse {
  fileManager: {
    deleteFile: { data: boolean | null; error: { message: string } | null };
  };
}

interface ListFilesResponse {
  fileManager: {
    listFiles: {
      data: Array<{ id: string; key: string; name: string }>;
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

// ─── Folder GQL ───────────────────────────────────────────────────────────────

const DELETE_FOLDER_FM_MUTATION = /* GraphQL */ `
  mutation DeleteFolderFm($id: ID!) {
    fileManager {
      deleteFolder(id: $id) {
        data
        error { message }
      }
    }
  }
`;

const DELETE_FOLDER_ACO_MUTATION = /* GraphQL */ `
  mutation DeleteFolderAco($id: ID!) {
    aco {
      deleteFolder(id: $id) {
        data
        error { message }
      }
    }
  }
`;

const LIST_ALL_FOLDERS_FM_QUERY = /* GraphQL */ `
  query ListAllFoldersFm($after: String, $limit: Int) {
    fileManager {
      listFolders(after: $after, limit: $limit) {
        data { id name slug parentId }
        meta { cursor hasMoreItems }
        error { message }
      }
    }
  }
`;

const LIST_ALL_FOLDERS_ACO_QUERY = /* GraphQL */ `
  query ListAllFoldersAco($after: String, $limit: Int) {
    aco {
      listFolders(where: { type: "FmFile" }, after: $after, limit: $limit) {
        data { id title slug parentId }
        meta { cursor hasMoreItems }
        error { message }
      }
    }
  }
`;

/** Sort folders deepest-first so children are deleted before their parents. */
function sortLeafFirst(folders: FolderRecord[]): FolderRecord[] {
  const childCount = new Map<string, number>();
  for (const f of folders) childCount.set(f.id, 0);
  for (const f of folders) {
    if (f.parentId && childCount.has(f.parentId)) {
      childCount.set(f.parentId, (childCount.get(f.parentId) ?? 0) + 1);
    }
  }
  // Stable sort: folders with no children come first, then their parents, etc.
  // Simple approach: sort by depth descending using a depth map.
  const depth = new Map<string, number>();
  function getDepth(id: string): number {
    if (depth.has(id)) return depth.get(id)!;
    const folder = folders.find((f) => f.id === id);
    if (!folder || !folder.parentId) { depth.set(id, 0); return 0; }
    const d = 1 + getDepth(folder.parentId);
    depth.set(id, d);
    return d;
  }
  for (const f of folders) getDepth(f.id);
  return [...folders].sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0));
}

async function listTargetFolders(client: GraphQLClient): Promise<FolderRecord[]> {
  const folders: FolderRecord[] = [];

  // Try fileManager.listFolders first, fall back to aco.listFolders
  const tryFm = async () => {
    let cursor: string | null = null;
    let hasMore = true;
    while (hasMore) {
      const resp: ListFoldersFmResp = await client.request<ListFoldersFmResp>(LIST_ALL_FOLDERS_FM_QUERY, { after: cursor, limit: 100 });
      const r = resp.fileManager.listFolders;
      if (r.error) throw new Error(r.error.message);
      folders.push(...r.data);
      cursor = r.meta.cursor ?? null;
      hasMore = r.meta.hasMoreItems;
    }
  };

  const tryAco = async () => {
    let cursor: string | null = null;
    let hasMore = true;
    while (hasMore) {
      const resp: ListFoldersAcoResp = await client.request<ListFoldersAcoResp>(LIST_ALL_FOLDERS_ACO_QUERY, { after: cursor, limit: 100 });
      const r = resp.aco.listFolders;
      if (r.error) throw new Error(r.error.message);
      folders.push(...r.data.map((f) => ({ id: f.id, name: f.title, slug: f.slug, parentId: f.parentId })));
      cursor = r.meta.cursor ?? null;
      hasMore = r.meta.hasMoreItems;
    }
  };

  try {
    await tryFm();
  } catch (fmErr) {
    const msg = fmErr instanceof Error ? fmErr.message : String(fmErr);
    if (msg.includes("listFolders") || msg.includes("Cannot query field") || msg.includes("fileManager")) {
      try { await tryAco(); } catch { /* no folder API available */ }
    } else {
      throw fmErr;
    }
  }

  return folders;
}

async function deleteFolderById(
  client: GraphQLClient,
  id: string
): Promise<"deleted" | "not_found" | { error: string }> {
  const tryDelete = async (mutation: string, ns: "fileManager" | "aco") => {
    const resp = await client.request<Record<string, { deleteFolder: { data: boolean | null; error: { message: string } | null } }>>(
      mutation, { id }
    );
    return resp[ns].deleteFolder;
  };

  for (const [mutation, ns] of [
    [DELETE_FOLDER_FM_MUTATION, "fileManager"],
    [DELETE_FOLDER_ACO_MUTATION, "aco"],
  ] as const) {
    try {
      const result = await tryDelete(mutation, ns);
      if (result.error) {
        const msg = result.error.message.toLowerCase();
        if (msg.includes("not found") || msg.includes("does not exist")) return "not_found";
        if (msg.includes("cannot query field") || msg.includes("unknown") || msg.includes("deleteFolder")) continue; // wrong API, try next
        return { error: result.error.message };
      }
      return "deleted";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("does not exist")) return "not_found";
      if (msg.includes("Cannot query field") || msg.includes("deleteFolder") || msg.includes("fileManager") || msg.includes("aco")) continue;
      return { error: msg };
    }
  }
  return { error: "deleteFolder not available on this API" };
}

// ─── Folder purge ────────────────────────────────────────────────────────────

async function purgeFolders(
  client: GraphQLClient,
  folders: FolderRecord[],
  stats: PurgeStats,
  dryRun: boolean
): Promise<void> {
  stats.foldersTotal = folders.length;
  if (folders.length === 0) return;

  const sorted = sortLeafFirst(folders);
  logger.log(`\n  🗂  Purging ${folders.length} folder(s) (leaf-first)...`);

  if (dryRun) {
    logger.log(`  [dry-run] Would delete ${folders.length} folders`);
    stats.foldersSkipped = folders.length;
    return;
  }

  // Folders must be deleted serially (leaf → root) to avoid FK errors
  for (const folder of sorted) {
    const outcome = await deleteFolderById(client, folder.id);
    if (outcome === "deleted") stats.foldersDeleted++;
    else if (outcome === "not_found") stats.foldersSkipped++;
    else stats.folderErrors.push({ id: folder.id, name: folder.name, error: outcome.error });
  }
}

// ─── Single file delete ───────────────────────────────────────────────────────

async function deleteFileById(
  client: GraphQLClient,
  id: string
): Promise<"deleted" | "not_found" | { error: string }> {
  try {
    const resp = await client.request<DeleteFileResponse>(DELETE_FILE_MUTATION, { id });
    const result = resp.fileManager.deleteFile;
    if (result.error) {
      const msg = result.error.message.toLowerCase();
      if (msg.includes("not found") || msg.includes("does not exist")) return "not_found";
      return { error: result.error.message };
    }
    return "deleted";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("does not exist")) return "not_found";
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
  // Narrow to selected files (match by src/key/id). Folders are not selectable;
  // when a selection is active, skip the folder purge so it only REDUCES deletions.
  const selectedFiles = exportFile.files.filter((file) =>
    selectedFilter(onlyIds, file.src, file.key, file.id)
  );
  const folders = (onlyIds && onlyIds.size > 0) ? [] : exportFile.folders;

  const stats: PurgeStats = {
    total: selectedFiles.length,
    deleted: 0,
    skipped: 0,
    errors: [],
    foldersTotal: 0,
    foldersDeleted: 0,
    foldersSkipped: 0,
    folderErrors: [],
  };

  if (selectedFiles.length === 0 && folders.length === 0) return stats;

  logger.log(`\n  🗑  Purging ${selectedFiles.length} file registrations (looking up by key)...`);
  logger.log("  Note: S3 binary files are NOT deleted — metadata only.\n");

  if (dryRun) {
    logger.log(`  [dry-run] Would look up and delete ${selectedFiles.length} file registrations`);
    stats.skipped = selectedFiles.length;
    await purgeFolders(client, folders, stats, true);
    return stats;
  }

  if (selectedFiles.length > 0) {
    const limit = pLimit(concurrency);
    let processed = 0;

    const tasks = selectedFiles.map((file) =>
      limit(async () => {
        // Look up by key to get the target's file ID
        const existing = await getExistingFile(client, file.key);
        if (!existing) {
          stats.skipped++;
        } else {
          const outcome = await deleteFileById(client, existing.id);
          if (outcome === "deleted") stats.deleted++;
          else if (outcome === "not_found") stats.skipped++;
          else stats.errors.push({ key: file.key, error: outcome.error });
        }

        processed++;
        if (processed % 50 === 0 || processed === selectedFiles.length) {
          logger.write(`\r  Progress: ${processed}/${selectedFiles.length}`);
        }
      })
    );

    await Promise.all(tasks);
    logger.write("\n");
  }

  // Delete folders after all files are gone (leaf-first to avoid FK errors)
  await purgeFolders(client, folders, stats, false);
  return stats;
}

// ─── All-files purge ──────────────────────────────────────────────────────────

export async function purgeAllFiles(
  client: GraphQLClient,
  dryRun: boolean,
  concurrency = 5,
  onlyIds?: Set<string> | null
): Promise<PurgeStats> {
  logger.log("\n  🔍 Listing all file registrations on target...");
  logger.log("  Note: S3 binary files are NOT deleted — metadata only.\n");

  const files: Array<{ id: string; key: string }> = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListFilesResponse = await client.request<ListFilesResponse>(
      LIST_ALL_FILES_QUERY,
      { after: cursor, limit: 100 }
    );
    const result: ListFilesResponse["fileManager"]["listFiles"] = resp.fileManager.listFiles;
    if (result.error) throw new Error(result.error.message);
    files.push(...result.data);
    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }

  // Narrow to selected files (match by key/id — the list does not expose src).
  const hasSelection = !!onlyIds && onlyIds.size > 0;
  const selectedFiles = files.filter((file) => selectedFilter(onlyIds, file.key, file.id));

  const stats: PurgeStats = { total: selectedFiles.length, deleted: 0, skipped: 0, errors: [], foldersTotal: 0, foldersDeleted: 0, foldersSkipped: 0, folderErrors: [] };
  logger.log(`  Found ${selectedFiles.length} file registrations`);

  if (selectedFiles.length === 0) return stats;

  if (dryRun) {
    logger.log(`  [dry-run] Would delete ${selectedFiles.length} file registrations`);
    stats.skipped = selectedFiles.length;
    // Folders are not selectable; only preview/delete them on an unfiltered purge.
    if (!hasSelection) {
      logger.log("\n  🔍 Listing all folders on target for dry-run...");
      const folders = await listTargetFolders(client);
      await purgeFolders(client, folders, stats, true);
    }
    return stats;
  }

  logger.log("  🗑  Deleting files...");
  const limit = pLimit(concurrency);
  let processed = 0;

  const tasks = selectedFiles.map((file) =>
    limit(async () => {
      const outcome = await deleteFileById(client, file.id);
      if (outcome === "deleted") stats.deleted++;
      else if (outcome === "not_found") stats.skipped++;
      else stats.errors.push({ key: file.key, error: outcome.error });

      processed++;
      if (processed % 50 === 0 || processed === selectedFiles.length) {
        logger.write(`\r  Progress: ${processed}/${selectedFiles.length}`);
      }
    })
  );

  await Promise.all(tasks);
  logger.write("\n");

  // Folders are not selectable; only delete them on an unfiltered purge.
  if (!hasSelection) {
    logger.log("\n  🔍 Listing all folders on target...");
    const folders = await listTargetFolders(client);
    await purgeFolders(client, folders, stats, false);
  }

  return stats;
}

// ─── Summary + error report ───────────────────────────────────────────────────

export function printPurgeSummary(stats: PurgeStats): void {
  logger.log("\n" + "═".repeat(55));
  logger.log("  FILE MANAGER PURGE SUMMARY");
  logger.log("═".repeat(55));
  logger.log("  Files:");
  logger.log(`    Total   : ${stats.total}`);
  logger.log(`    Deleted : ${stats.deleted}  (metadata only — S3 untouched)`);
  logger.log(`    Skipped : ${stats.skipped}`);
  logger.log(`    Errors  : ${stats.errors.length}`);
  logger.log("  Folders:");
  logger.log(`    Total   : ${stats.foldersTotal}`);
  logger.log(`    Deleted : ${stats.foldersDeleted}`);
  logger.log(`    Skipped : ${stats.foldersSkipped}`);
  logger.log(`    Errors  : ${stats.folderErrors.length}`);
  logger.log("═".repeat(55) + "\n");
}

export function writePurgeErrorReport(stats: PurgeStats): string | null {
  const allErrors = [
    ...stats.errors.map((e) => ({ type: "file", ...e })),
    ...stats.folderErrors.map((e) => ({ type: "folder", key: e.id, name: e.name, error: e.error })),
  ];
  if (allErrors.length === 0) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `file-purge-errors-${timestamp}.json`;
  const filepath = path.resolve(process.cwd(), filename);
  fs.writeFileSync(filepath, JSON.stringify(allErrors, null, 2), "utf-8");
  return filepath;
}
