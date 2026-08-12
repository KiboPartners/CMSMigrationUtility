/**
 * Page folder support (Kibo CMS ACO).
 *
 * Website-Builder pages carry a `location { folderId }` referencing an ACO
 * folder (the tree shown in the CMS admin sidebar). That folder tree is served
 * by the Admin GraphQL `aco` namespace — the same service files and redirects
 * use — keyed by a per-app `type` discriminator (canonically "WbPage").
 *
 * The folder `type` string varies across Kibo CMS versions, so export probes the
 * candidates and records the one that actually has folders; import reuses it.
 */

import { GraphQLClient, FolderAdapter, FolderNode, resolveAcoFolderInputType } from "@kibo-cms-clone-tool/shared";

export const PAGE_FOLDER_TYPE_CANDIDATES = [
  "wb:page", // namespaced ACO type used on current Kibo CMS installs
  "WbPage",
  "PbPage",
  "Page",
  "WebsiteBuilderPage",
  "WbPageBuilderPage",
];

/** Kibo CMS's literal "no folder" sentinel — treat as root, never as a real folder id. */
export const ROOT_FOLDER_ID = "root";

/** Normalize a page's folderId: null/"root"/empty all mean "intentionally at root". */
export function normalizeFolderId(v: unknown): string | null {
  return typeof v === "string" && v && v !== ROOT_FOLDER_ID ? v : null;
}

const LIST_FOLDERS_QUERY = /* GraphQL */ `
  query ListPageFolders($where: FoldersListWhereInput!, $after: String, $limit: Int) {
    aco {
      listFolders(where: $where, after: $after, limit: $limit) {
        data { id title slug parentId }
        meta { cursor hasMoreItems totalCount }
        error { message }
      }
    }
  }
`;

// aco createFolder input type varies by version — resolved at runtime (shared).
const createFolderMutation = (inputType: string) => /* GraphQL */ `
  mutation CreatePageFolder($data: ${inputType}!) {
    aco {
      createFolder(data: $data) {
        data { id title slug parentId }
        error { message }
      }
    }
  }
`;

interface ListFoldersResponse {
  aco: {
    listFolders: {
      data: Array<{ id: string; title: string; slug: string; parentId: string | null }>;
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

interface CreateFolderResponse {
  aco: {
    createFolder: {
      data: { id: string; title: string; slug: string; parentId: string | null } | null;
      error: { message: string } | null;
    };
  };
}

/** Page through every ACO folder of one `type`, normalized to FolderNode. */
async function fetchFoldersOfType(client: GraphQLClient, type: string): Promise<FolderNode[]> {
  const out: FolderNode[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListFoldersResponse = await client.request<ListFoldersResponse>(LIST_FOLDERS_QUERY, {
      where: { type },
      after: cursor,
      limit: 100,
    });
    const result = resp.aco.listFolders;
    if (result.error) throw new Error(result.error.message);
    for (const f of result.data) {
      out.push({ id: f.id, name: f.title, slug: f.slug, parentId: f.parentId });
    }
    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }

  return out;
}

/**
 * Export-side: find the page-folder `type` that actually has folders on this
 * source and return its tree. If none of the candidates hold folders, returns an
 * empty tree under the default type.
 */
export async function fetchPageFolders(
  client: GraphQLClient
): Promise<{ folderType: string; folders: FolderNode[] }> {
  for (const type of PAGE_FOLDER_TYPE_CANDIDATES) {
    try {
      const folders = await fetchFoldersOfType(client, type);
      if (folders.length > 0) return { folderType: type, folders };
    } catch {
      // try the next candidate type
    }
  }
  return { folderType: PAGE_FOLDER_TYPE_CANDIDATES[0], folders: [] };
}

/** Import-side: folder adapter bound to the `type` chosen at export time. */
export function pageFolderAdapter(client: GraphQLClient, folderType: string): FolderAdapter {
  return {
    listTargetFolders: () => fetchFoldersOfType(client, folderType).catch(() => []),
    createFolder: async ({ name, slug, parentId }) => {
      const inputType = await resolveAcoFolderInputType(client);
      const resp = await client.request<CreateFolderResponse>(createFolderMutation(inputType), {
        data: { title: name, slug, type: folderType, parentId: parentId ?? null },
      });
      const result = resp.aco.createFolder;
      if (result.error || !result.data) {
        throw new Error(result.error?.message ?? "createFolder returned no data");
      }
      return result.data.id;
    },
  };
}
