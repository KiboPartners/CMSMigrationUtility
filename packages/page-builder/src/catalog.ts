/**
 * Catalog builder for pages. Discovers the websiteBuilder ops, lists pages
 * (read-only), and records file dependency edges by scanning each page's JSON
 * for file CDN URLs (page content is opaque, so a URL scan is the pragmatic way
 * to find referenced files).
 */

import { GraphQLClient, CatalogItem, CatalogSection, buildFolderPathMap } from "@kibo-cms-clone-tool/shared";
import { discoverPageBuilderOps, PageBuilderOps } from "./ops";
import { fetchPageFolders, normalizeFolderId } from "./folders";
import { wrap } from "./categories";

type Page = Record<string, unknown>;

interface ListPagesResult {
  data: Page[];
  meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
  error: { message: string } | null;
}

const FILE_URL_RE = /https?:\/\/[^"'\s]+\/files\/[^"'\s\\]+/g;

/** Page name/path live under `properties` on this Kibo version; fall back to root. */
function pageProp(page: Page, key: string): string | null {
  const props = page["properties"] as Record<string, unknown> | null | undefined;
  const v = (props && typeof props === "object" ? props[key] : undefined) ?? page[key];
  return typeof v === "string" && v ? v : null;
}

function deriveLabel(page: Page): string {
  return (
    pageProp(page, "title") ||
    pageProp(page, "name") ||
    pageProp(page, "path") ||
    pageProp(page, "url") ||
    pageProp(page, "slug") ||
    String(page["entryId"] ?? page["id"] ?? "(page)")
  );
}

function extractFileDeps(page: Page): string[] {
  const matches = JSON.stringify(page).match(FILE_URL_RE);
  return matches ? [...new Set(matches)] : [];
}

export async function catalogPages(client: GraphQLClient): Promise<CatalogSection> {
  let ops: PageBuilderOps;
  try {
    ops = await discoverPageBuilderOps(client);
  } catch (e) {
    return { type: "page", total: 0, items: [], note: `op discovery failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const query = `query ListPages($after: String) { ${wrap(
    ops.namespace,
    `${ops.listPages}(limit: 50, after: $after) { data { ${ops.pageSelection} } meta { cursor hasMoreItems totalCount } error { message } }`
  )} }`;

  // Folder tree (for folder-path display), best-effort.
  const { folders } = await fetchPageFolders(client).catch(() => ({ folders: [] }));
  const folderPaths = buildFolderPathMap(folders);

  const items: CatalogItem[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  try {
    while (hasMore) {
      const variables: Record<string, unknown> = {};
      if (cursor) variables.after = cursor;
      const resp: Record<string, unknown> = await client.request<Record<string, unknown>>(query, variables);
      const nsResp = ops.namespace ? (resp[ops.namespace] as Record<string, unknown>) : resp;
      const result = nsResp[ops.listPages] as ListPagesResult | undefined;
      if (!result) throw new Error(`"${ops.listPages}" not in response`);
      if (result.error) throw new Error(result.error.message);

      for (const page of result.data) {
        const id = String(page["entryId"] ?? page["id"] ?? "");
        const status = (page["status"] as string) ?? null;
        const live = status === "published";
        const folderId = normalizeFolderId((page["location"] as { folderId?: string } | null)?.folderId);
        const createdBy = page["createdBy"] as { displayName?: string } | null | undefined;
        items.push({
          type: "page",
          id,
          label: deriveLabel(page),
          metadata: {
            name: deriveLabel(page),
            path: pageProp(page, "path"),
            folderPath: folderId ? (folderPaths.get(folderId) ?? "(unknown)") : "/",
            author: createdBy?.displayName ?? null,
            createdOn: page["createdOn"] ?? null,
            modifiedOn: page["savedOn"] ?? null,
            status,
            live,
            version: live ? (page["version"] ?? null) : null,
          },
          dependsOn: extractFileDeps(page),
        });
      }

      cursor = result.meta.cursor ?? null;
      hasMore = result.meta.hasMoreItems ?? false;
    }
  } catch (e) {
    return { type: "page", total: items.length, items, note: e instanceof Error ? e.message : String(e) };
  }

  return { type: "page", total: items.length, items };
}
