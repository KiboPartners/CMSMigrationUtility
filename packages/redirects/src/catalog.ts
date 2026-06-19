/**
 * Catalog builder for redirects. Lists redirects from an environment (read-only)
 * and maps each to a CatalogItem keyed by redirectFrom (the import match key).
 */

import { GraphQLClient, CatalogItem, CatalogSection } from "@kibo-cms-clone-tool/shared";

const LIST_QUERY = /* GraphQL */ `
  query ListRedirects($after: String, $limit: Int) {
    websiteBuilder {
      listRedirects(after: $after, limit: $limit) {
        data { id redirectFrom redirectTo redirectType isEnabled location { folderId } }
        meta { cursor hasMoreItems totalCount }
        error { message }
      }
    }
  }
`;

const LIST_NO_CURSOR_QUERY = /* GraphQL */ `
  query ListRedirects($limit: Int) {
    websiteBuilder {
      listRedirects(limit: $limit) {
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

export async function catalogRedirects(client: GraphQLClient): Promise<CatalogSection> {
  const items: CatalogItem[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let supportsCursor = true;

  try {
    while (hasMore) {
      const resp: ListResp = supportsCursor
        ? await client.request<ListResp>(LIST_QUERY, { after: cursor, limit: 100 })
        : await client.request<ListResp>(LIST_NO_CURSOR_QUERY, { limit: 10000 });
      const r = resp.websiteBuilder.listRedirects;
      if (r.error) throw new Error(r.error.message);

      for (const rd of r.data) {
        items.push({
          type: "redirect",
          id: rd.redirectFrom,
          label: `${rd.redirectFrom} → ${rd.redirectTo}`,
          metadata: { to: rd.redirectTo, redirectType: rd.redirectType, enabled: rd.isEnabled, folderId: rd.location?.folderId ?? null },
        });
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
    return { type: "redirect", total: items.length, items, note: e instanceof Error ? e.message : String(e) };
  }

  return { type: "redirect", total: items.length, items };
}
