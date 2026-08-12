/**
 * Catalog builder for redirects. Lists redirects from an environment (read-only)
 * and maps each to a CatalogItem keyed by redirectFrom (the import match key).
 */

import {
  GraphQLClient,
  CatalogItem,
  CatalogSection,
  buildWhereForArtifact,
  formatFilterPlanLog,
  matchCatalogItem,
  logger,
  type FrozenFilterSpec,
} from "@kibo-cms-clone-tool/shared";

const LIST_QUERY = /* GraphQL */ `
  query ListRedirects($after: String, $limit: Int, $where: WbRedirectsListWhereInput) {
    websiteBuilder {
      listRedirects(after: $after, limit: $limit, where: $where) {
        data { id redirectFrom redirectTo redirectType isEnabled location { folderId } }
        meta { cursor hasMoreItems totalCount }
        error { message }
      }
    }
  }
`;

const LIST_NO_CURSOR_QUERY = /* GraphQL */ `
  query ListRedirects($limit: Int, $where: WbRedirectsListWhereInput) {
    websiteBuilder {
      listRedirects(limit: $limit, where: $where) {
        data { id redirectFrom redirectTo redirectType isEnabled location { folderId } }
        error { message }
      }
    }
  }
`;

interface Redirect {
  id: string;
  redirectFrom: string;
  redirectTo: string;
  redirectType: string | null;
  isEnabled: boolean;
  location?: { folderId: string } | null;
}

interface ListResp {
  websiteBuilder: {
    listRedirects: {
      data: Redirect[];
      meta?: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

export async function catalogRedirects(
  client: GraphQLClient,
  filterSpec: FrozenFilterSpec | null = null
): Promise<CatalogSection> {
  const items: CatalogItem[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let supportsCursor = true;

  let where: Record<string, unknown> | undefined;
  let residualKeys: Set<string> | undefined;
  if (filterSpec) {
    const plan = buildWhereForArtifact("redirect", filterSpec);
    logger.log(formatFilterPlanLog(plan));
    for (const w of plan.warnings) logger.warn(`  ⚠  ${w}`);
    where = plan.where ?? undefined;
    residualKeys = new Set(plan.residual.map((c) => c.key));
  }

  try {
    while (hasMore) {
      const resp: ListResp = supportsCursor
        ? await client.request<ListResp>(LIST_QUERY, { after: cursor, limit: 100, where })
        : await client.request<ListResp>(LIST_NO_CURSOR_QUERY, { limit: 10000, where });
      const r = resp.websiteBuilder.listRedirects;
      if (r.error) throw new Error(r.error.message);

      for (const rd of r.data) {
        const item: CatalogItem = {
          type: "redirect",
          id: rd.redirectFrom,
          label: `${rd.redirectFrom} → ${rd.redirectTo}`,
          metadata: {
            to: rd.redirectTo,
            redirectType: rd.redirectType,
            enabled: rd.isEnabled,
            folderId: rd.location?.folderId ?? null,
          },
        };
        if (filterSpec && residualKeys?.size && !matchCatalogItem(item, filterSpec, { residualKeys })) {
          continue;
        }
        items.push(item);
      }

      if (supportsCursor && r.meta) {
        cursor = r.meta.cursor;
        hasMore = r.meta.hasMoreItems;
      } else {
        supportsCursor = false;
        hasMore = false;
      }
    }
  } catch (e) {
    return {
      type: "redirect",
      total: items.length,
      items,
      note: e instanceof Error ? e.message : String(e),
    };
  }

  return { type: "redirect", total: items.length, items };
}
