/**
 * Catalog builder for files. Lists file metadata from an environment (read-only).
 *
 * Item id is the file's `src` (CDN URL) so it matches the dependency edges CMS
 * entries record for their file fields — enabling resolveDependencies() to pull
 * the right files into a selection.
 */

import { GraphQLClient, CatalogItem, CatalogSection } from "@kibo-cms-clone-tool/shared";

const LIST_WITH_LOCATION = /* GraphQL */ `
  query ListFiles($after: String, $limit: Int) {
    fileManager {
      listFiles(after: $after, limit: $limit) {
        data { id key name size type src location { folderId } }
        meta { cursor hasMoreItems totalCount }
        error { message }
      }
    }
  }
`;

const LIST_NO_LOCATION = /* GraphQL */ `
  query ListFiles($after: String, $limit: Int) {
    fileManager {
      listFiles(after: $after, limit: $limit) {
        data { id key name size type src }
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

async function list(client: GraphQLClient, withLocation: boolean): Promise<CatalogItem[]> {
  const query = withLocation ? LIST_WITH_LOCATION : LIST_NO_LOCATION;
  const items: CatalogItem[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListResp = await client.request<ListResp>(query, { after: cursor, limit: 100 });
    const r = resp.fileManager.listFiles;
    if (r.error) throw new Error(r.error.message);
    for (const f of r.data) {
      items.push({
        type: "file",
        id: f.src || f.key, // src (CDN URL) matches entry file-field deps
        label: f.name || f.key,
        metadata: { key: f.key, fmId: f.id, size: f.size ?? null, mimeType: f.type ?? null, folderId: f.location?.folderId ?? null },
      });
    }
    cursor = r.meta.cursor;
    hasMore = r.meta.hasMoreItems;
  }
  return items;
}

export async function catalogFiles(client: GraphQLClient): Promise<CatalogSection> {
  let items: CatalogItem[];
  try {
    items = await list(client, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("location")) {
      // Older Kibo without the location field — retry without it.
      try {
        items = await list(client, false);
      } catch (e2) {
        return { type: "file", total: 0, items: [], note: e2 instanceof Error ? e2.message : String(e2) };
      }
    } else {
      return { type: "file", total: 0, items: [], note: msg };
    }
  }
  return { type: "file", total: items.length, items };
}
