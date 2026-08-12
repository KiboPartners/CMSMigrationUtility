/**
 * Export step: stream all pages from source to a `pages.entries.ndjson` sidecar
 * (one page object per line) plus a `pages.json` metadata file (namespace, ops,
 * categories, folders, count — no pages). Pages are never held fully in memory:
 * each fetched page is written straight to the ndjson stream.
 *
 * Page fields and operation names are discovered via schema introspection so the
 * export works regardless of which Kibo CMS version renames or restructures the API.
 */

import fs from "fs";
import path from "path";
import {
  GraphQLClient,
  logger,
  FolderNode,
  filterFoldersForIds,
  createNdjsonWriter,
  buildWhereForArtifact,
  formatFilterPlanLog,
  matchCatalogItem,
  type FrozenFilterSpec,
  type CatalogItem,
} from "@kibo-cms-clone-tool/shared";
import { listCategories, PbCategory, wrap } from "./categories";
import { discoverPageBuilderOps, PageBuilderOps } from "./ops";
import { fetchPageFolders, normalizeFolderId } from "./folders";
import { ExportConfig } from "./config";
import { pageKeys, selectedFilter } from "./page-ids";

/** A page as returned by the API — kept as a plain object to stay version-agnostic. */
export type PbPage = Record<string, unknown>;

export interface ExportFile {
  locale: string;
  exportedAt: string;
  /** Namespace used at export time — saved so import can use the same. */
  namespace: string | null;
  mutNamespace: string | null;
  /** Discovered operation names — saved for use at import time. */
  ops: {
    listPages: string;
    createPage: string | null;
    updatePage: string | null;
    publishPage: string | null;
    listCategories: string | null;
    createCategory: string | null;
  };
  categories: PbCategory[];
  /** ACO folder `type` discriminator the source uses for page folders. */
  pageFolderType: string | null;
  /** Source page-folder tree (ACO) — synced to target so pages keep their folder. */
  folders: FolderNode[];
  pages: PbPage[];
}

function buildListPagesQuery(ops: PageBuilderOps, withWhere: boolean): string {
  const whereArg = withWhere && ops.listPagesWhereType ? `, where: $where` : "";
  const whereVar =
    withWhere && ops.listPagesWhereType ? `, $where: ${ops.listPagesWhereType}` : "";
  const inner = `
    ${ops.listPages}(limit: 50, after: $after${whereArg}) {
      data { ${ops.pageSelection} }
      meta { cursor hasMoreItems totalCount }
      error { message }
    }`;
  return `query ListPages($after: String${whereVar}) { ${wrap(ops.namespace, inner)} }`;
}

type ListPagesResult = {
  data: PbPage[];
  meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
  error: { message: string } | null;
};

function pageProp(page: PbPage, key: string): string | null {
  const props = page["properties"] as Record<string, unknown> | null | undefined;
  const v = (props && typeof props === "object" ? props[key] : undefined) ?? page[key];
  return typeof v === "string" && v ? v : null;
}

/** @deprecated import from `@kibo-cms-clone-tool/shared` — re-export for tests. */
export { filterFoldersForIds };

async function streamAllPages(
  client: GraphQLClient,
  ops: PageBuilderOps,
  onPage: (p: PbPage) => void,
  filterSpec: FrozenFilterSpec | null = null,
  selection: Set<string> | null = null
): Promise<number> {
  let where: Record<string, unknown> | null = null;
  let residualKeys: Set<string> | undefined;
  if (filterSpec) {
    const plan = buildWhereForArtifact("page", filterSpec);
    logger.log(formatFilterPlanLog(plan));
    for (const w of plan.warnings) logger.warn(`  ⚠  ${w}`);
    where = plan.where;
    residualKeys = new Set(plan.residual.map((c) => c.key));
  }
  const withWhere = !!(where && ops.listPagesWhereType);
  const query = buildListPagesQuery(ops, withWhere);
  let cursor: string | null = null;
  let hasMore = true;
  let firstPage = true;
  let count = 0;
  let listed = 0;

  while (hasMore) {
    const variables: Record<string, unknown> = {};
    if (cursor) variables.after = cursor;
    if (withWhere && where) variables.where = where;

    const resp = await client.request<Record<string, unknown>>(query, variables);

    // Navigate namespace wrapper if present
    const nsResp = ops.namespace ? (resp[ops.namespace] as Record<string, unknown>) : resp;
    const result = nsResp[ops.listPages] as ListPagesResult | undefined;

    if (!result) throw new Error(`Unexpected response — "${ops.listPages}" not in response`);
    if (result.error) throw new Error(`Error listing pages: ${result.error.message}`);

    if (firstPage) {
      logger.write(` (${result.meta.totalCount} total)`);
      firstPage = false;
    }

    for (const p of result.data) {
      listed++;
      if (filterSpec && residualKeys?.size) {
        const pseudo: CatalogItem = {
          type: "page",
          id: String(p["entryId"] ?? p["id"] ?? ""),
          label: pageProp(p, "title") || pageProp(p, "path") || String(p["id"] ?? ""),
          metadata: {
            path: pageProp(p, "path"),
            name: pageProp(p, "title"),
            status: p["status"],
            createdOn: p["createdOn"],
            modifiedOn: p["savedOn"],
          },
        };
        if (!matchCatalogItem(pseudo, filterSpec, { residualKeys })) continue;
      }
      if (selection && !selectedFilter(selection, ...pageKeys(p))) continue;
      onPage(p);
      count++;
    }
    cursor = result.meta.cursor ?? null;
    hasMore = result.meta.hasMoreItems ?? false;
  }

  if (selection) {
    logger.write(` — ${count} matched --select of ${listed} listed`);
  }

  return count;
}

export async function exportPages(
  client: GraphQLClient,
  config: ExportConfig,
  selection: Set<string> | null = null
): Promise<{ pageCount: number; categoryCount: number; filePath: string }> {
  logger.log("  Discovering Page Builder operations...");
  const ops = await discoverPageBuilderOps(client);

  logger.write("\n  Fetching categories...");
  const categories = await listCategories(client, ops);
  logger.write(` ${categories.length} found\n`);

  logger.write("  Fetching page folders...");
  const { folderType, folders: allFolders } = await fetchPageFolders(client);
  logger.write(` ${allFolders.length} found${allFolders.length ? ` (type ${folderType})` : ""}\n`);

  fs.mkdirSync(config.outDir, { recursive: true });
  const ndjsonPath = path.join(config.outDir, "pages.entries.ndjson");
  const writer = createNdjsonWriter(ndjsonPath);
  logger.write("  Fetching pages...");
  const folderIds = new Set<string>();
  let pageCount: number;
  try {
    pageCount = await streamAllPages(
      client,
      ops,
      (p) => {
        const fid = normalizeFolderId((p["location"] as { folderId?: unknown } | undefined)?.folderId);
        if (fid) folderIds.add(fid);
        writer.write(p);
      },
      config.filterSpec,
      selection
    );
  } finally {
    await writer.close();
  }
  logger.write(` ${pageCount} exported\n`);

  const folders = selection ? filterFoldersForIds(allFolders, folderIds) : allFolders;
  if (selection) {
    logger.log(`  Folders kept for selection: ${folders.length}/${allFolders.length}`);
  }

  const meta = {
    locale: config.locale,
    exportedAt: new Date().toISOString(),
    namespace: ops.namespace,
    mutNamespace: ops.mutNamespace,
    ops: {
      listPages:      ops.listPages,
      createPage:     ops.createPage,
      updatePage:     ops.updatePage,
      publishPage:    ops.publishPage,
      listCategories: ops.listCategories,
      createCategory: ops.createCategory,
    },
    categories,
    pageFolderType: folderType,
    folders,
    count: pageCount,
  };

  const filePath = path.join(config.outDir, "pages.json");
  fs.writeFileSync(filePath, JSON.stringify(meta, null, 2), "utf-8");

  return { pageCount, categoryCount: categories.length, filePath };
}
