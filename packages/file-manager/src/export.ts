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
import { GraphQLClient, logger } from "@kibo-cms-clone-tool/shared";
import { ExportConfig } from "./config";
import { FileRecord, FolderRecord } from "./files";

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
  withLocation: boolean
): Promise<FileRecord[]> {
  const allFiles: FileRecord[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  const query = withLocation ? LIST_FILES_WITH_LOCATION_QUERY : LIST_FILES_QUERY;

  while (hasMore) {
    const where: Record<string, unknown> = {};
    if (tagsFilter.length > 0) {
      where["tags_in"] = tagsFilter;
    }

    const resp: ListFilesResponse = await client.request<ListFilesResponse>(query, {
      after: cursor,
      limit: 100,
      where: Object.keys(where).length ? where : undefined,
    });

    const result: ListFilesResponse["fileManager"]["listFiles"] = resp.fileManager.listFiles;
    if (result.error) throw new Error(`Failed to list files: ${result.error.message}`);

    allFiles.push(...result.data);
    logger.write(".");

    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }

  return allFiles;
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
    files = await fetchAllFiles(client, config.tagsFilter, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("location")) {
      logger.write("\n  (location field not supported — retrying without it)");
      files = await fetchAllFiles(client, config.tagsFilter, false);
    } else {
      throw err;
    }
  }
  logger.write(`\n  ${files.length} file(s) found\n`);

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
