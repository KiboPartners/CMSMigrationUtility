/**
 * Export step: fetch all redirect folders + redirects from source Website Builder,
 * write to a single JSON file on disk.
 *
 * Output format:
 * {
 *   "exportedAt": "...",
 *   "folders":   [ { id, name, slug, parentId } ... ],
 *   "redirects": [ { id, redirectFrom, redirectTo, redirectType, isEnabled, location } ... ]
 * }
 */

import fs from "fs";
import path from "path";
import { GraphQLClient, logger } from "@kibo-cms-clone-tool/shared";
import { ExportConfig } from "./config";

export interface FolderRecord {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

export interface RedirectRecord {
  id: string;
  redirectFrom: string;
  redirectTo: string;
  redirectType: string | null;
  isEnabled: boolean;
  location?: { folderId: string } | null;
}

export interface ExportFile {
  exportedAt: string;
  folders: FolderRecord[];
  redirects: RedirectRecord[];
}

// ─── Redirect queries ─────────────────────────────────────────────────────────

const LIST_REDIRECTS_QUERY = /* GraphQL */ `
  query ListRedirects($after: String, $limit: Int) {
    websiteBuilder {
      listRedirects(after: $after, limit: $limit) {
        data {
          id
          redirectFrom
          redirectTo
          redirectType
          isEnabled
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

const LIST_REDIRECTS_NO_CURSOR_QUERY = /* GraphQL */ `
  query ListRedirects($limit: Int) {
    websiteBuilder {
      listRedirects(limit: $limit) {
        data {
          id
          redirectFrom
          redirectTo
          redirectType
          isEnabled
          location {
            folderId
          }
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
      data: RedirectRecord[];
      meta?: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

// ─── Folder queries (ACO) ─────────────────────────────────────────────────────

const LIST_FOLDERS_ACO_QUERY = /* GraphQL */ `
  query ListRedirectFolders($where: FoldersListWhereInput!, $after: String, $limit: Int) {
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

interface ListFoldersAcoResponse {
  aco: {
    listFolders: {
      data: Array<{ id: string; title: string; slug: string; parentId: string | null }>;
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

// Candidate ACO type strings for redirect folders — tried in order
const REDIRECT_FOLDER_TYPE_CANDIDATES = [
  "WbRedirect",
  "WebsiteBuilderRedirect",
  "Redirect",
  "PbRedirect",
];

async function fetchFoldersWithType(
  client: GraphQLClient,
  type: string
): Promise<FolderRecord[]> {
  const all: FolderRecord[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListFoldersAcoResponse = await client.request<ListFoldersAcoResponse>(
      LIST_FOLDERS_ACO_QUERY,
      { where: { type }, after: cursor, limit: 100 }
    );
    const result = resp.aco.listFolders;
    if (result.error) throw new Error(`ACO listFolders error: ${result.error.message}`);
    all.push(
      ...result.data.map((f) => ({ id: f.id, name: f.title, slug: f.slug, parentId: f.parentId }))
    );
    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }

  return all;
}

/**
 * Try each candidate type string until one returns results or a non-"empty" response.
 * Falls back to introspection if none work.
 */
async function fetchAllFolders(client: GraphQLClient): Promise<FolderRecord[]> {
  for (const type of REDIRECT_FOLDER_TYPE_CANDIDATES) {
    try {
      const folders = await fetchFoldersWithType(client, type);
      if (folders.length > 0) {
        logger.log(`  Folder type "${type}" matched — ${folders.length} folder(s) found`);
        return folders;
      }
      // Zero results: could be correct (no folders) or wrong type — keep trying
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Hard schema error → try next; other errors → rethrow
      if (!msg.includes("Cannot query field") && !msg.includes("Unknown") && !msg.includes("aco")) {
        throw err;
      }
    }
  }

  // All candidates returned 0 — run with the first type and accept empty
  // (either no folders exist or the type is genuinely unknown)
  try {
    return await fetchFoldersWithType(client, REDIRECT_FOLDER_TYPE_CANDIDATES[0]);
  } catch {
    return [];
  }
}

// ─── Introspection (fallback diagnostics) ────────────────────────────────────

async function introspectWebsiteBuilderApi(client: GraphQLClient): Promise<void> {
  const INTROSPECT_QUERY = /* GraphQL */ `
    query IntrospectWB {
      wbType: __type(name: "WebsiteBuilderQuery") {
        fields {
          name
          args {
            name
            type { name kind ofType { name kind ofType { name kind } } }
          }
        }
      }
      queryRoot: __schema {
        queryType { fields { name } }
      }
    }
  `;

  try {
    type ArgType = {
      name: string | null; kind: string;
      ofType?: { name: string | null; kind: string; ofType?: { name: string | null; kind: string } | null } | null
    };
    const resp = await client.request<{
      wbType: { fields: Array<{ name: string; args: Array<{ name: string; type: ArgType }> }> } | null;
      queryRoot: { queryType: { fields: Array<{ name: string }> } };
    }>(INTROSPECT_QUERY);

    if (resp.wbType) {
      const typeName = (t: ArgType): string =>
        t.kind === "NON_NULL" ? `${typeName(t.ofType!)}!` :
        t.kind === "LIST" ? `[${typeName(t.ofType!)}]` :
        t.name ?? t.kind;
      logger.log("  WebsiteBuilderQuery fields:");
      for (const f of resp.wbType.fields) {
        const argStr = f.args.map((a) => `${a.name}: ${typeName(a.type)}`).join(", ");
        logger.log(`    ${f.name}(${argStr})`);
      }
    } else {
      logger.log("  WebsiteBuilderQuery type not found.");
      logger.log("  Top-level fields:", resp.queryRoot.queryType.fields.map((f) => f.name).join(", "));
    }
    logger.log("  ⚠  Report the output above so the query can be corrected.");
  } catch {
    logger.log("  ⚠  Schema introspection failed.");
  }
}

// ─── Redirect fetching ────────────────────────────────────────────────────────

async function fetchAllRedirects(client: GraphQLClient): Promise<RedirectRecord[]> {
  const all: RedirectRecord[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let supportsCursor = true;

  while (hasMore) {
    let resp: ListRedirectsResponse;

    if (supportsCursor) {
      resp = await client.request<ListRedirectsResponse>(LIST_REDIRECTS_QUERY, {
        after: cursor,
        limit: 100,
      });
    } else {
      resp = await client.request<ListRedirectsResponse>(LIST_REDIRECTS_NO_CURSOR_QUERY, {
        limit: 10000,
      });
    }

    const result = resp.websiteBuilder.listRedirects;
    if (result.error) throw new Error(`Failed to list redirects: ${result.error.message}`);

    all.push(...result.data);
    logger.write(".");

    if (supportsCursor && result.meta) {
      cursor = result.meta.cursor;
      hasMore = result.meta.hasMoreItems;
    } else {
      supportsCursor = false;
      hasMore = false;
    }
  }

  return all;
}

// ─── Main export function ─────────────────────────────────────────────────────

export async function exportRedirects(
  client: GraphQLClient,
  config: ExportConfig
): Promise<{ redirectCount: number; folderCount: number; filePath: string }> {

  // Step 1: folders
  let folders: FolderRecord[] = [];
  logger.write("\n  Enumerating redirect folders");
  try {
    folders = await fetchAllFolders(client);
    if (folders.length === 0) {
      logger.write("\n  No folders found (or folder API not available)\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.write(`\n  Folder fetch skipped: ${msg}\n`);
  }

  // Step 2: redirects
  logger.write("  Enumerating redirects");
  let redirects: RedirectRecord[];
  try {
    redirects = await fetchAllRedirects(client);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("websiteBuilder") ||
      msg.includes("listRedirects") ||
      msg.includes("Cannot query field")
    ) {
      logger.write("\n  Redirect query failed. Introspecting schema...\n");
      await introspectWebsiteBuilderApi(client);
      throw new Error("Redirect API shape mismatch — see introspection output above.");
    }
    throw err;
  }

  logger.write(`\n  ${redirects.length} redirect(s) found\n`);

  const payload: ExportFile = {
    exportedAt: new Date().toISOString(),
    folders,
    redirects,
  };

  fs.mkdirSync(config.outDir, { recursive: true });
  const filePath = path.join(config.outDir, "redirects.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");

  return { redirectCount: redirects.length, folderCount: folders.length, filePath };
}
