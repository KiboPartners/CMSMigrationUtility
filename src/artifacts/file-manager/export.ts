/**
 * Export step: enumerate all file metadata from source File Manager,
 * write to a single JSON file on disk.
 *
 * Output format:
 * {
 *   "exportedAt": "...",
 *   "sourceCdnDomain": "xxx.cloudfront.net",
 *   "folders": [ ...folder records (empty on older Kibo CMS without folder API) ],
 *   "files": [ ...file records... ]
 * }
 */

import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import {
  GraphQLClient,
  logger,
  isWithinSizeLimit,
  formatBytes,
  safeKeyPath,
  buildWhereForArtifact,
  formatFilterPlanLog,
  matchCatalogItem,
  expandFileSelectionIds,
  filterFoldersForIds,
  normalizeFolderId,
  type CatalogItem,
} from "@kibo-cms-clone-tool/shared";
import { ExportConfig } from "./config";
import { FileRecord, FolderRecord } from "./files";

export interface BinaryManifestEntry {
  id: string;
  key: string;
  status: "downloaded" | "skipped-large" | "error";
  bytes?: number;
  error?: string;
}

export interface BinaryManifest {
  downloadedAt: string;
  maxFileBytes: number;
  entries: BinaryManifestEntry[];
}

export function planBinaryDownloads(
  files: FileRecord[],
  manifest: BinaryManifest | null,
  maxFileBytes: number
): { toDownload: FileRecord[]; skippedLarge: FileRecord[]; alreadyDone: string[] } {
  const done = new Set(
    (manifest?.entries ?? []).filter((e) => e.status === "downloaded").map((e) => e.id)
  );
  const toDownload: FileRecord[] = [];
  const skippedLarge: FileRecord[] = [];
  for (const f of files) {
    if (!isWithinSizeLimit(f.size, maxFileBytes)) {
      skippedLarge.push(f);
      continue;
    }
    if (done.has(f.id)) continue;
    toDownload.push(f);
  }
  return { toDownload, skippedLarge, alreadyDone: [...done] };
}

export interface ExportFile {
  exportedAt: string;
  sourceCdnDomain: string;
  folders: FolderRecord[];
  files: FileRecord[];
}

// Query WITH location field (Kibo CMS 5.34+ folder support)
const LIST_FILES_WITH_LOCATION_QUERY = /* GraphQL */ `
  query ListFiles($after: String, $limit: Int, $where: FmFileListWhereInput) {
    fileManager {
      listFiles(after: $after, limit: $limit, where: $where) {
        data {
          id
          key
          name
          size
          type
          src
          tags
          createdOn
          savedOn
          location {
            folderId
          }
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

// Fallback query WITHOUT location (older Kibo CMS)
const LIST_FILES_QUERY = /* GraphQL */ `
  query ListFiles($after: String, $limit: Int, $where: FmFileListWhereInput) {
    fileManager {
      listFiles(after: $after, limit: $limit, where: $where) {
        data {
          id
          key
          name
          size
          type
          src
          tags
          createdOn
          savedOn
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

// Kibo CMS 5.34+ — folders under fileManager
const LIST_FOLDERS_FM_QUERY = /* GraphQL */ `
  query ListFolders($after: String, $limit: Int) {
    fileManager {
      listFolders(after: $after, limit: $limit) {
        data {
          id
          name
          slug
          parentId
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

// Kibo CMS ACO (Advanced Content Organization) — folders under aco service
// where.type "FmFile" scopes to File Manager folders
const LIST_FOLDERS_ACO_QUERY = /* GraphQL */ `
  query ListAcoFolders($where: FoldersListWhereInput!, $after: String, $limit: Int) {
    aco {
      listFolders(where: $where, after: $after, limit: $limit) {
        data {
          id
          title
          slug
          parentId
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

interface ListFoldersFmResponse {
  fileManager: {
    listFolders: {
      data: FolderRecord[];
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

interface AcoFolderItem {
  id: string;
  title: string;
  slug: string;
  parentId: string | null;
}

interface ListFoldersAcoResponse {
  aco: {
    listFolders: {
      data: AcoFolderItem[];
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

interface ListFilesResponse {
  fileManager: {
    listFiles: {
      data: FileRecord[];
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

async function fetchAllFoldersFm(client: GraphQLClient): Promise<FolderRecord[]> {
  const all: FolderRecord[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListFoldersFmResponse = await client.request<ListFoldersFmResponse>(
      LIST_FOLDERS_FM_QUERY,
      { after: cursor, limit: 100 }
    );
    const result = resp.fileManager.listFolders;
    if (result.error) throw new Error(`Failed to list folders: ${result.error.message}`);
    all.push(...result.data);
    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }

  return all;
}

async function fetchAllFoldersAco(client: GraphQLClient): Promise<FolderRecord[]> {
  const all: FolderRecord[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListFoldersAcoResponse = await client.request<ListFoldersAcoResponse>(
      LIST_FOLDERS_ACO_QUERY,
      { where: { type: "FmFile" }, after: cursor, limit: 100 }
    );
    const result = resp.aco.listFolders;
    if (result.error) throw new Error(`Failed to list ACO folders: ${result.error.message}`);
    // Normalise ACO shape (title → name) to FolderRecord
    all.push(
      ...result.data.map((f) => ({
        id: f.id,
        name: f.title,
        slug: f.slug,
        parentId: f.parentId,
      }))
    );
    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }

  return all;
}

/**
 * Introspect the schema to find folder-related fields.
 * Called when neither known folder API path works, so we can report
 * exactly what IS available and fix the query.
 */
async function introspectFolderApis(client: GraphQLClient): Promise<void> {
  const INTROSPECT_QUERY = /* GraphQL */ `
    query IntrospectFolderApis {
      fmType: __type(name: "FmQuery") { fields { name } }
      acoType: __type(name: "AcoQuery") {
        fields {
          name
          args {
            name
            type {
              name
              kind
              ofType { name kind ofType { name kind } }
            }
          }
        }
      }
      queryType: __schema { queryType { fields { name } } }
    }
  `;

  try {
    type ArgType = { name: string | null; kind: string; ofType?: { name: string | null; kind: string; ofType?: { name: string | null; kind: string } | null } | null };
    type FieldWithArgs = { name: string; args: Array<{ name: string; type: ArgType }> };
    const resp = await client.request<{
      fmType: { fields: Array<{ name: string }> } | null;
      acoType: { fields: Array<FieldWithArgs> } | null;
      queryType: { queryType: { fields: Array<{ name: string }> } };
    }>(INTROSPECT_QUERY);

    if (resp.fmType) {
      const folderFields = resp.fmType.fields.filter((f) => f.name.toLowerCase().includes("folder"));
      logger.log(`  FmQuery folder-related fields: ${folderFields.length ? folderFields.map((f) => f.name).join(", ") : "(none)"}`);
    }

    if (resp.acoType) {
      const folderFields = resp.acoType.fields.filter((f) => f.name.toLowerCase().includes("folder"));
      logger.log(`  AcoQuery folder-related fields: ${folderFields.map((f) => f.name).join(", ")}`);

      // Print args for listFolders specifically
      const listFolders = resp.acoType.fields.find((f) => f.name === "listFolders");
      if (listFolders) {
        const argStr = listFolders.args.map((a) => {
          const typeName = (t: ArgType): string =>
            t.kind === "NON_NULL" ? `${typeName(t.ofType!)}!` :
            t.kind === "LIST" ? `[${typeName(t.ofType!)}]` :
            t.name ?? t.kind;
          return `${a.name}: ${typeName(a.type)}`;
        }).join(", ");
        logger.log(`  listFolders args: (${argStr})`);
      }
    } else {
      logger.log("  AcoQuery type not found in schema");
    }

    logger.log("  ⚠  Could not auto-detect folder API. Report the output above so the query can be fixed.");
  } catch {
    logger.log("  ⚠  Schema introspection failed — folder export skipped.");
  }
}

async function fetchAllFiles(
  client: GraphQLClient,
  tagsFilter: string[],
  withLocation: boolean,
  filterSpec: ExportConfig["filterSpec"] = null
): Promise<FileRecord[]> {
  const allFiles: FileRecord[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  const query = withLocation ? LIST_FILES_WITH_LOCATION_QUERY : LIST_FILES_QUERY;

  let where: Record<string, unknown> = {};
  let residualKeys: Set<string> | undefined;
  if (filterSpec) {
    const plan = buildWhereForArtifact("file", filterSpec);
    logger.log(formatFilterPlanLog(plan));
    for (const w of plan.warnings) logger.warn(`  ⚠  ${w}`);
    where = { ...(plan.where ?? {}) };
    residualKeys = new Set(plan.residual.map((c) => c.key));
  } else if (tagsFilter.length > 0) {
    where["tags_in"] = tagsFilter;
  }

  while (hasMore) {
    const resp: ListFilesResponse = await client.request<ListFilesResponse>(query, {
      after: cursor,
      limit: 100,
      where: Object.keys(where).length ? where : undefined,
    });

    const result: ListFilesResponse["fileManager"]["listFiles"] = resp.fileManager.listFiles;
    if (result.error) throw new Error(`Failed to list files: ${result.error.message}`);

    for (const f of result.data) {
      if (filterSpec && residualKeys?.size) {
        const pseudo: CatalogItem = {
          type: "file",
          id: f.src || f.key,
          label: f.name || f.key,
          metadata: {
            key: f.key,
            tags: (f as { tags?: string[] }).tags,
            createdOn: (f as { createdOn?: string }).createdOn,
            modifiedOn: (f as { savedOn?: string }).savedOn,
          },
        };
        if (!matchCatalogItem(pseudo, filterSpec, { residualKeys })) continue;
      }
      allFiles.push(f);
    }
    logger.write(".");

    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }

  return allFiles;
}

function binaryManifestPath(outDir: string): string {
  return path.join(outDir, "binaries", "manifest.json");
}

export function readBinaryManifest(outDir: string): BinaryManifest | null {
  const p = binaryManifestPath(outDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as BinaryManifest;
  } catch {
    return null;
  }
}

function writeBinaryManifest(outDir: string, m: BinaryManifest): void {
  const p = binaryManifestPath(outDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

export async function exportBinaries(
  files: FileRecord[],
  outDir: string,
  maxFileBytes: number,
  concurrency: number,
  fetchFn: typeof fetch = fetch
): Promise<BinaryManifest> {
  const existing = readBinaryManifest(outDir);
  const { toDownload, skippedLarge, alreadyDone } = planBinaryDownloads(files, existing, maxFileBytes);

  const entries: BinaryManifestEntry[] = existing ? [...existing.entries] : [];
  const upsert = (e: BinaryManifestEntry) => {
    const i = entries.findIndex((x) => x.id === e.id);
    if (i >= 0) entries[i] = e;
    else entries.push(e);
  };
  for (const f of skippedLarge) {
    upsert({ id: f.id, key: f.key, status: "skipped-large", bytes: f.size });
  }

  const manifest: BinaryManifest = { downloadedAt: new Date().toISOString(), maxFileBytes, entries };
  writeBinaryManifest(outDir, manifest);

  logger.log(
    `\n  Binaries: ${toDownload.length} to download, ${alreadyDone.length} already done, ` +
      `${skippedLarge.length} skipped (over ${formatBytes(maxFileBytes)})`
  );

  const limit = pLimit(concurrency);
  let done = 0;
  await Promise.all(
    toDownload.map((f) =>
      limit(async () => {
        const dest = safeKeyPath(path.join(outDir, "binaries"), f.key);
        if (!dest) {
          upsert({ id: f.id, key: f.key, status: "error", error: "unsafe key (path traversal)" });
          manifest.downloadedAt = new Date().toISOString();
          writeBinaryManifest(outDir, manifest);
          return;
        }
        try {
          const res = await fetchFn(f.src);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
          upsert({ id: f.id, key: f.key, status: "downloaded", bytes: f.size });
        } catch (err) {
          upsert({ id: f.id, key: f.key, status: "error", error: err instanceof Error ? err.message : String(err) });
        }
        manifest.downloadedAt = new Date().toISOString();
        writeBinaryManifest(outDir, manifest); // checkpoint after every file → resumable
        done++;
        if (done % 25 === 0 || done === toDownload.length) {
          logger.write(`\r  Downloaded ${done}/${toDownload.length}`);
        }
      })
    )
  );
  logger.write("\n");
  return manifest;
}

/**
 * Narrow files + folders to a --select set (src/key/id aliases) and the folder
 * ancestors those files reference. Pure — used by export and unit tests.
 */
export function scopeFilesExportForSelection(
  files: FileRecord[],
  folders: FolderRecord[],
  selectIds: Iterable<string>
): { files: FileRecord[]; folders: FolderRecord[] } {
  const selection = expandFileSelectionIds(selectIds);
  if (!selection.size) return { files: [], folders: [] };
  const scopedFiles = files.filter((f) =>
    [f.src, f.key, f.id].some((k) => !!k && selection.has(k))
  );
  const folderIds = new Set<string>();
  for (const f of scopedFiles) {
    const fid = normalizeFolderId(f.location?.folderId);
    if (fid) folderIds.add(fid);
  }
  return {
    files: scopedFiles,
    folders: filterFoldersForIds(folders, folderIds),
  };
}

export async function exportFiles(
  client: GraphQLClient,
  config: ExportConfig
): Promise<{ fileCount: number; filePath: string }> {
  const sourceCdnDomain = process.env["SOURCE_CDN_DOMAIN"] ?? "";

  // Try folder APIs in order: fileManager.listFolders → aco.listFolders → introspect + skip
  let folders: FolderRecord[] = [];
  let folderApiUsed: string | null = null;
  logger.write("\n  Enumerating source folders");
  try {
    folders = await fetchAllFoldersFm(client);
    folderApiUsed = "fileManager";
    // File Manager may return no folders while ACO still has FmFile folders.
    if (folders.length === 0) {
      folders = await fetchAllFoldersAco(client);
      folderApiUsed = "aco";
    }
  } catch (fmErr) {
    const fmMsg = fmErr instanceof Error ? fmErr.message : String(fmErr);
    if (fmMsg.includes("listFolders") || fmMsg.includes("Cannot query field")) {
      try {
        folders = await fetchAllFoldersAco(client);
        folderApiUsed = "aco";
      } catch (acoErr) {
        const acoMsg = acoErr instanceof Error ? acoErr.message : String(acoErr);
        if (acoMsg.includes("listFolders") || acoMsg.includes("Cannot query field") || acoMsg.includes("aco")) {
          // Neither standard path worked — introspect to find what's actually available
          logger.write("\n  Standard folder APIs not found. Introspecting schema...\n");
          await introspectFolderApis(client);
        } else {
          throw acoErr;
        }
      }
    } else {
      throw fmErr;
    }
  }

  if (folderApiUsed) {
    logger.write(`\n  ${folders.length} folder(s) found (via ${folderApiUsed} API)\n`);
  }

  // Try files query with location field first; fall back if field not supported
  logger.write("  Enumerating source files");
  let files: FileRecord[];
  try {
    files = await fetchAllFiles(client, config.tagsFilter, true, config.filterSpec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("location")) {
      logger.write("\n  (location field not supported — retrying without it)");
      files = await fetchAllFiles(client, config.tagsFilter, false, config.filterSpec);
    } else {
      throw err;
    }
  }
  logger.write(`\n  ${files.length} file(s) found\n`);

  // Selective export: keep only selected files + their folder ancestors (not the whole FM tree).
  if (config.selectIds?.size) {
    const beforeFiles = files.length;
    const beforeFolders = folders.length;
    const scoped = scopeFilesExportForSelection(files, folders, config.selectIds);
    files = scoped.files;
    folders = scoped.folders;
    logger.log(`  Selection: ${beforeFiles} → ${files.length} file(s)`);
    logger.log(`  Folders kept for selection: ${folders.length}/${beforeFolders}`);
  }

  const payload: ExportFile = {
    exportedAt: new Date().toISOString(),
    sourceCdnDomain,
    folders,
    files,
  };

  fs.mkdirSync(config.outDir, { recursive: true });
  const filePath = path.join(config.outDir, "files.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");

  return { fileCount: files.length, filePath };
}
