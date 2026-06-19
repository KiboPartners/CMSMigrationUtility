/**
 * Export step: fetch ALL pages (and categories) from source to a single JSON file.
 *
 * Page fields and operation names are discovered via schema introspection so the
 * export works regardless of which Kibo CMS version renames or restructures the API.
 */

import fs from "fs";
import path from "path";
import { GraphQLClient, logger, FolderNode } from "@kibo-cms-clone-tool/shared";
import { listCategories, PbCategory, wrap } from "./categories";
import { discoverPageBuilderOps, PageBuilderOps } from "./ops";
import { fetchPageFolders } from "./folders";
import { ExportConfig } from "./config";

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

function buildListPagesQuery(ops: PageBuilderOps): string {
  const inner = `
    ${ops.listPages}(limit: 50, after: $after) {
      data { ${ops.pageSelection} }
      meta { cursor hasMoreItems totalCount }
      error { message }
    }`;
  return `query ListPages($after: String) { ${wrap(ops.namespace, inner)} }`;
}

type ListPagesResult = {
  data: PbPage[];
  meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
  error: { message: string } | null;
};

async function fetchAllPages(client: GraphQLClient, ops: PageBuilderOps): Promise<PbPage[]> {
  const query = buildListPagesQuery(ops);
  const pages: PbPage[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let firstPage = true;

  while (hasMore) {
    const variables: Record<string, unknown> = {};
    if (cursor) variables.after = cursor;

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

    pages.push(...result.data);
    cursor = result.meta.cursor ?? null;
    hasMore = result.meta.hasMoreItems ?? false;
  }

  return pages;
}

export async function exportPages(
  client: GraphQLClient,
  config: ExportConfig
): Promise<{ pageCount: number; categoryCount: number; filePath: string }> {
  logger.log("  Discovering Page Builder operations...");
  const ops = await discoverPageBuilderOps(client);

  logger.write("\n  Fetching categories...");
  const categories = await listCategories(client, ops);
  logger.write(` ${categories.length} found\n`);

  logger.write("  Fetching page folders...");
  const { folderType, folders } = await fetchPageFolders(client);
  logger.write(` ${folders.length} found${folders.length ? ` (type ${folderType})` : ""}\n`);

  logger.write("  Fetching pages...");
  const pages = await fetchAllPages(client, ops);
  logger.write(` ${pages.length} found\n`);

  const payload: ExportFile = {
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
    pages,
  };

  fs.mkdirSync(config.outDir, { recursive: true });
  const filePath = path.join(config.outDir, "pages.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");

  return { pageCount: pages.length, categoryCount: categories.length, filePath };
}
