/**
 * Resolve a single file catalog row by dependency id (CDN URL or S3 key).
 * Used by migrate hydration when the file was outside the catalog filter window.
 */

import {
  GraphQLClient,
  CatalogItem,
  normalizeFileDepId,
  fileKeyFromDepId,
  fileDepAliases,
} from "@kibo-cms-clone-tool/shared";

const LIST_Q = /* GraphQL */ `
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
  location?: { folderId?: string | null };
}

function toItem(f: FileRec): CatalogItem {
  const id = (f.src ? normalizeFileDepId(f.src) : f.key) || f.key;
  return {
    type: "file",
    id,
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
}

function matchesDep(f: FileRec, depId: string): boolean {
  const want = new Set(fileDepAliases(depId));
  if (f.src && want.has(normalizeFileDepId(f.src))) return true;
  if (f.key && (want.has(f.key) || want.has(normalizeFileDepId(f.key)))) return true;
  if (f.id && want.has(f.id)) return true;
  return false;
}

/**
 * Look up one file by CDN URL / key. Tries key_contains pushdown, then a short
 * unfiltered scan capped for safety.
 */
export async function fetchFileByDepId(
  client: GraphQLClient,
  depId: string
): Promise<CatalogItem | null> {
  const key = fileKeyFromDepId(depId);
  const needles: Array<Record<string, unknown> | null> = [];
  if (key) {
    needles.push({ key_contains: key.split("/").pop() || key });
    if (key.includes("/")) needles.push({ key_contains: key.slice(0, Math.min(key.length, 40)) });
  }
  needles.push(null); // fallback: scan

  for (const where of needles) {
    let cursor: string | null = null;
    let pages = 0;
    const maxPages = where ? 5 : 20;
    while (pages < maxPages) {
      pages++;
      const resp = await client.request<{
        fileManager: {
          listFiles: {
            data: FileRec[];
            meta: { cursor: string | null; hasMoreItems: boolean };
            error: { message: string } | null;
          };
        };
      }>(LIST_Q, { after: cursor, limit: 100, where: where ?? undefined });
      const r = resp.fileManager.listFiles;
      if (r.error) throw new Error(r.error.message);
      for (const f of r.data) {
        if (matchesDep(f, depId)) return toItem(f);
      }
      if (!r.meta.hasMoreItems) break;
      cursor = r.meta.cursor;
      // Unfiltered scan: stop early — hydration should not walk the whole library.
      if (!where) break;
    }
  }
  return null;
}
