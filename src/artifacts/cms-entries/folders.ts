/**
 * CMS-entry folder support (Kibo CMS ACO).
 *
 * Content entries carry a system field `wbyAco_location { folderId }` (Manage
 * API) referencing an ACO folder. The folder tree itself lives on the **Admin
 * GraphQL** `aco` namespace (the Manage API does not expose `aco`), keyed by a
 * per-model `type` discriminator equal to the model's `modelId`.
 *
 * So foldering an entry spans both APIs: read/write `wbyAco_location` on the
 * Manage entry, but create/list the folders themselves on the Admin endpoint.
 */

import { GraphQLClient, FolderAdapter, FolderNode, resolveAcoFolderInputType } from "@kibo-cms-clone-tool/shared";

/** Kibo CMS's literal "no folder" sentinel — treat as root, never a real folder id. */
export const ROOT_FOLDER_ID = "root";

/** Normalize an entry's folderId: null/"root"/empty all mean "intentionally at root". */
export function normalizeFolderId(v: unknown): string | null {
  return typeof v === "string" && v && v !== ROOT_FOLDER_ID ? v : null;
}

/** Read an entry's source folderId from its (hoisted) wbyAco_location. */
export function entryFolderId(entry: Record<string, unknown>): string | null {
  const loc = entry["wbyAco_location"] as { folderId?: unknown } | undefined;
  return normalizeFolderId(loc?.folderId);
}

const LIST_FOLDERS_QUERY = /* GraphQL */ `
  query ListEntryFolders($where: FoldersListWhereInput!, $after: String, $limit: Int) {
    aco {
      listFolders(where: $where, after: $after, limit: $limit) {
        data { id title slug parentId }
        meta { cursor hasMoreItems totalCount }
        error { message }
      }
    }
  }
`;

const createFolderMutation = (inputType: string) => /* GraphQL */ `
  mutation CreateEntryFolder($data: ${inputType}!) {
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

/**
 * ACO `type` discriminator for a content model's entry folders. Kibo CMS keys
 * these under `cms:<modelId>` (NOT the bare modelId — that returns no folders).
 */
function acoType(modelId: string): string {
  return modelId.startsWith("cms:") ? modelId : `cms:${modelId}`;
}

/**
 * Export-side: fetch the ACO folder tree for one model (type = `cms:<modelId>`)
 * from the Admin endpoint. Returns [] if the endpoint has no folders for it.
 */
export async function fetchEntryFolders(
  adminClient: GraphQLClient,
  modelId: string
): Promise<FolderNode[]> {
  const out: FolderNode[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListFoldersResponse = await adminClient.request<ListFoldersResponse>(
      LIST_FOLDERS_QUERY,
      { where: { type: acoType(modelId) }, after: cursor, limit: 100 }
    );
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

/** Import-side: folder adapter for one model, bound to the Admin endpoint. */
export function entryFolderAdapter(adminClient: GraphQLClient, modelId: string): FolderAdapter {
  return {
    listTargetFolders: () => fetchEntryFolders(adminClient, modelId).catch(() => []),
    createFolder: async ({ name, slug, parentId }) => {
      const inputType = await resolveAcoFolderInputType(adminClient);
      const resp = await adminClient.request<CreateFolderResponse>(createFolderMutation(inputType), {
        data: { title: name, slug, type: acoType(modelId), parentId: parentId ?? null },
      });
      const result = resp.aco.createFolder;
      if (result.error || !result.data) {
        throw new Error(result.error?.message ?? "createFolder returned no data");
      }
      return result.data.id;
    },
  };
}
