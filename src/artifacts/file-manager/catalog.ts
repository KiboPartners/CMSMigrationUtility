/**
 * Catalog builder for files. Lists file metadata from an environment (read-only).
 *
 * Item id is the file's `src` (CDN URL) so it matches the dependency edges CMS
 * entries record for their file fields — enabling resolveDependencies() to pull
 * the right files into a selection.
 */

import {
  GraphQLClient,
  CatalogItem,
  CatalogSection,
  buildWhereForArtifact,
  formatFilterPlanLog,
  matchCatalogItem,
  normalizeFileDepId,
  logger,
  type FrozenFilterSpec,
} from "@kibo-cms-clone-tool/shared";

const LIST_WITH_LOCATION = /* GraphQL */ `
  query ListFiles($after: String, $limit: Int, $where: FmFileListWhereInput) {
    fileManager {
      listFiles(after: $after, limit: $limit, where: $where) {
        data { id key name size type src tags createdOn savedOn location { folderId } }
        meta { cursor hasMoreItems totalCount }
        error { message }
      }
    }
  }
`;

const LIST_NO_LOCATION = /* GraphQL */ `
  query ListFiles($after: String, $limit: Int, $where: FmFileListWhereInput) {
    fileManager {
      listFiles(after: $after, limit: $limit, where: $where) {
        data { id key name size type src tags createdOn savedOn }
        meta { cursor hasMoreItems totalCount }
        error { message }
      }
    }
  }
`;

/** Fallback when tags/createdOn/savedOn are not selectable. */
const LIST_MINIMAL = /* GraphQL */ `
  query ListFiles($after: String, $limit: Int, $where: FmFileListWhereInput) {
    fileManager {
      listFiles(after: $after, limit: $limit, where: $where) {
        data { id key name size type src location { folderId } }
        meta { cursor hasMoreItems totalCount }
        error { message }
      }
    }
  }
`;

interface FileRec {
  id: string;
  key: string;
  name: string;
  size?: number;
  type?: string;
  src?: string;
  tags?: string[];
  createdOn?: string;
  savedOn?: string;
  location?: { folderId: string } | null;
}

interface ListResp {
  fileManager: {
    listFiles: {
      data: FileRec[];
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

async function list(
  client: GraphQLClient,
  query: string,
  where: Record<string, unknown> | null,
  residualKeys: Set<string> | undefined,
  filterSpec: FrozenFilterSpec | null
): Promise<CatalogItem[]> {
  const items: CatalogItem[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListResp = await client.request<ListResp>(query, {
      after: cursor,
      limit: 100,
      where: where ?? undefined,
    });
    const r = resp.fileManager.listFiles;
    if (r.error) throw new Error(r.error.message);
    for (const f of r.data) {
      const rawId = f.src || f.key; // src (CDN URL) matches entry file-field deps
      const item: CatalogItem = {
        type: "file",
        id: (f.src ? normalizeFileDepId(f.src) : f.key) || rawId,
        label: f.name || f.key,
        metadata: {
          key: f.key,
          fmId: f.id,
          size: f.size ?? null,
          mimeType: f.type ?? null,
          folderId: f.location?.folderId ?? null,
          tags: f.tags ?? [],
          createdOn: f.createdOn ?? null,
          modifiedOn: f.savedOn ?? null,
        },
      };
      if (filterSpec && residualKeys?.size && !matchCatalogItem(item, filterSpec, { residualKeys })) {
        continue;
      }
      items.push(item);
    }
    cursor = r.meta.cursor;
    hasMore = r.meta.hasMoreItems;
  }
  return items;
}

export async function catalogFiles(
  client: GraphQLClient,
  filterSpec: FrozenFilterSpec | null = null
): Promise<CatalogSection> {
  let where: Record<string, unknown> | null = null;
  let residualKeys: Set<string> | undefined;
  if (filterSpec) {
    const plan = buildWhereForArtifact("file", filterSpec);
    logger.log(formatFilterPlanLog(plan));
    for (const w of plan.warnings) logger.warn(`  ⚠  ${w}`);
    where = plan.where;
    residualKeys = new Set(plan.residual.map((c) => c.key));
  }

  let items: CatalogItem[];
  try {
    items = await list(client, LIST_WITH_LOCATION, where, residualKeys, filterSpec);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/location|tags|createdOn|savedOn/i.test(msg)) {
      try {
        items = await list(client, LIST_NO_LOCATION, where, residualKeys, filterSpec);
      } catch {
        items = await list(client, LIST_MINIMAL, where, residualKeys, filterSpec);
      }
    } else {
      return { type: "file", total: 0, items: [], note: msg };
    }
  }
  return { type: "file", total: items.length, items };
}
