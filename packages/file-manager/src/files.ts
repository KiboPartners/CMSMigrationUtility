/**
 * File Manager GraphQL operations for the import step.
 */

import { GraphQLClient } from "@kibo-cms-clone-tool/shared";

export interface FolderRecord {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

export interface FileRecord {
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
  src: string;
  tags: string[];
  location?: { folderId: string } | null;
}

// ─── File queries / mutations ─────────────────────────────────────────────────

const LIST_FILES_BY_KEY_QUERY = /* GraphQL */ `
  query ListFilesByKey($where: FmFileListWhereInput) {
    fileManager {
      listFiles(limit: 1, where: $where) {
        data {
          id
          key
          src
          location { folderId }
        }
        error {
          message
        }
      }
    }
  }
`;

function buildCreateFileMutation(inputType: string): string {
  return /* GraphQL */ `
    mutation CreateFile($data: ${inputType}!) {
      fileManager {
        createFile(data: $data) {
          data { id key src }
          error { message }
        }
      }
    }
  `;
}

function buildUpdateFileMutation(inputType: string): string {
  return /* GraphQL */ `
    mutation UpdateFile($id: ID!, $data: ${inputType}!) {
      fileManager {
        updateFile(id: $id, data: $data) {
          data { id key src }
          error { message }
        }
      }
    }
  `;
}

/**
 * Traverse __schema to find the real input type name for fileManager.createFile(data: ...).
 * Avoids hardcoding "FmFileInput" which varies across Kibo CMS versions.
 */
const INTROSPECT_FM_MUTATION_QUERY = /* GraphQL */ `
  query IntrospectFmMutation {
    __schema {
      mutationType {
        fields {
          name
          type {
            name
            kind
            fields {
              name
              args {
                name
                type {
                  name
                  kind
                  ofType { name kind ofType { name kind } }
                }
              }
            }
            ofType {
              name
              kind
              fields {
                name
                args {
                  name
                  type {
                    name
                    kind
                    ofType { name kind ofType { name kind } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

type FmArgType = {
  name: string | null;
  kind: string;
  ofType: { name: string | null; kind: string; ofType: { name: string | null; kind: string } | null } | null;
};

function resolveFmTypeName(t: FmArgType | null | undefined): string {
  if (!t) return "";
  if (t.name) return t.name;
  if (t.ofType?.name) return t.ofType.name;
  if (t.ofType?.ofType?.name) return t.ofType.ofType.name;
  return "";
}

let _cachedInputTypes: { create: string; update: string } | null = null;

async function discoverFileInputTypes(client: GraphQLClient): Promise<{ create: string; update: string }> {
  if (_cachedInputTypes) return _cachedInputTypes;

  const fallback = { create: "FmFileInput", update: "FmFileInput" };
  try {
    type FmOpField = { name: string; args: Array<{ name: string; type: FmArgType }> };
    type SchemaResp = {
      __schema: {
        mutationType: {
          fields: Array<{
            name: string;
            type: {
              name: string | null;
              kind: string;
              fields: Array<FmOpField> | null;
              ofType: { name: string | null; kind: string; fields: Array<FmOpField> | null } | null;
            };
          }>;
        } | null;
      };
    };

    const resp = await client.request<SchemaResp>(INTROSPECT_FM_MUTATION_QUERY, undefined, { maxAttempts: 1 });
    const mutationType = resp.__schema?.mutationType;
    if (!mutationType) return fallback;

    const fmField = mutationType.fields.find((f) => f.name === "fileManager");
    if (!fmField) return fallback;

    const fmFields = fmField.type.fields ?? fmField.type.ofType?.fields ?? null;
    if (!fmFields) return fallback;

    const findType = (opName: string): string => {
      const op = fmFields.find((f) => f.name === opName);
      return resolveFmTypeName(op?.args.find((a) => a.name === "data")?.type ?? null);
    };

    _cachedInputTypes = {
      create: findType("createFile") || fallback.create,
      update: findType("updateFile") || fallback.update,
    };
    return _cachedInputTypes;
  } catch {
    return fallback;
  }
}

// ─── Folder queries / mutations ───────────────────────────────────────────────

const LIST_ALL_FOLDERS_QUERY = /* GraphQL */ `
  query ListAllFolders($after: String, $limit: Int) {
    fileManager {
      listFolders(after: $after, limit: $limit) {
        data {
          id
          name
          slug
          parentId
        }
        meta {
          cursor
          hasMoreItems
          totalCount
        }
        error {
          message
        }
      }
    }
  }
`;

function buildCreateFolderFmMutation(inputType: string): string {
  return /* GraphQL */ `
    mutation CreateFolderFm($data: ${inputType}!) {
      fileManager {
        createFolder(data: $data) {
          data { id name slug parentId }
          error { message }
        }
      }
    }
  `;
}

function buildCreateFolderAcoMutation(inputType: string): string {
  return /* GraphQL */ `
    mutation CreateFolderAco($data: ${inputType}!) {
      aco {
        createFolder(data: $data) {
          data { id title slug parentId }
          error { message }
        }
      }
    }
  `;
}

/**
 * Introspect the ACO mutation type to find the real input type name for
 * aco.createFolder(data: ...).
 */
const INTROSPECT_ACO_MUTATION_QUERY = /* GraphQL */ `
  query IntrospectAcoMutation {
    __schema {
      mutationType {
        fields {
          name
          type {
            name
            kind
            fields {
              name
              args {
                name
                type {
                  name
                  kind
                  ofType { name kind ofType { name kind } }
                }
              }
            }
            ofType {
              name
              kind
              fields {
                name
                args {
                  name
                  type {
                    name
                    kind
                    ofType { name kind ofType { name kind } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

let _cachedFolderInputTypes: { fm: string; aco: string } | null = null;

async function discoverFolderInputTypes(client: GraphQLClient): Promise<{ fm: string; aco: string }> {
  if (_cachedFolderInputTypes) return _cachedFolderInputTypes;

  const fallback = { fm: "FmFolderCreateInput", aco: "AcoFolderCreateInput" };

  try {
    type OpField = { name: string; args: Array<{ name: string; type: FmArgType }> };
    type SchemaResp = {
      __schema: {
        mutationType: {
          fields: Array<{
            name: string;
            type: {
              name: string | null;
              kind: string;
              fields: Array<OpField> | null;
              ofType: { name: string | null; kind: string; fields: Array<OpField> | null } | null;
            };
          }>;
        } | null;
      };
    };

    const resp = await client.request<SchemaResp>(INTROSPECT_ACO_MUTATION_QUERY, undefined, { maxAttempts: 1 });
    const mutationType = resp.__schema?.mutationType;
    if (!mutationType) return fallback;

    const getServiceFields = (serviceName: string): Array<OpField> | null => {
      const f = mutationType.fields.find((x) => x.name === serviceName);
      if (!f) return null;
      return f.type.fields ?? f.type.ofType?.fields ?? null;
    };

    const findDataArgType = (fields: Array<OpField> | null, opName: string): string => {
      if (!fields) return "";
      const op = fields.find((f) => f.name === opName);
      return resolveFmTypeName(op?.args.find((a) => a.name === "data")?.type ?? null);
    };

    const fmFields = getServiceFields("fileManager");
    const acoFields = getServiceFields("aco");

    _cachedFolderInputTypes = {
      fm:  findDataArgType(fmFields,  "createFolder") || fallback.fm,
      aco: findDataArgType(acoFields, "createFolder") || fallback.aco,
    };

    return _cachedFolderInputTypes;
  } catch {
    return fallback;
  }
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface ListFilesByKeyResponse {
  fileManager: {
    listFiles: {
      data: Array<{ id: string; key: string; src: string; location?: { folderId: string } | null }>;
      error: { message: string } | null;
    };
  };
}

interface CreateFileResponse {
  fileManager: {
    createFile: {
      data: { id: string; key: string; src: string } | null;
      error: { message: string } | null;
    };
  };
}

interface UpdateFileResponse {
  fileManager: {
    updateFile: {
      data: { id: string; key: string; src: string } | null;
      error: { message: string } | null;
    };
  };
}

interface ListFoldersResponse {
  fileManager: {
    listFolders: {
      data: FolderRecord[];
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

interface CreateFolderFmResponse {
  fileManager: {
    createFolder: {
      data: FolderRecord | null;
      error: { message: string } | null;
    };
  };
}

interface CreateFolderAcoResponse {
  aco: {
    createFolder: {
      data: { id: string; title: string; slug: string; parentId: string | null } | null;
      error: { message: string } | null;
    };
  };
}

// ─── File operations ──────────────────────────────────────────────────────────

/** Returns the existing file record (including current location) or null if not found. */
export async function getExistingFile(
  client: GraphQLClient,
  key: string
): Promise<{ id: string; key: string; location?: { folderId: string } | null } | null> {
  const resp = await client.request<ListFilesByKeyResponse>(LIST_FILES_BY_KEY_QUERY, {
    where: { key },
  });
  const result = resp.fileManager.listFiles;
  if (result.error) return null;
  return result.data.find((f) => f.key === key) ?? null;
}

/** Update only the location (folder) of an existing file. */
export async function updateFileLocationInTarget(
  client: GraphQLClient,
  fileId: string,
  targetFolderId: string
): Promise<void> {
  const { update: inputType } = await discoverFileInputTypes(client);
  const mutation = buildUpdateFileMutation(inputType);
  const resp = await client.request<UpdateFileResponse>(mutation, {
    id: fileId,
    data: { location: { folderId: targetFolderId } },
  });
  const result = resp.fileManager.updateFile;
  if (result.error || !result.data) {
    throw new Error(result.error?.message ?? "updateFile returned no data");
  }
}

export async function createFileInTarget(
  client: GraphQLClient,
  file: FileRecord,
  sourceCdnDomain: string,
  targetCdnDomain: string,
  targetFolderId?: string
): Promise<{ id: string; key: string }> {
  const data: Record<string, unknown> = {
    // id is required by newer Kibo CMS versions and preserves the file ID
    // so that CMS entries referencing this file by ID continue to work.
    id: file.id,
    key: file.key,
    name: file.name,
    size: file.size,
    type: file.type,
    // src is computed by Kibo CMS from the key — omit it to avoid "not defined" errors
    // on newer versions and the double-protocol bug when CDN domains include https://.
    tags: file.tags,
  };

  if (targetFolderId) {
    data["location"] = { folderId: targetFolderId };
  }

  const { create: inputType } = await discoverFileInputTypes(client);
  const mutation = buildCreateFileMutation(inputType);

  const resp = await client.request<CreateFileResponse>(mutation, { data });

  const result = resp.fileManager.createFile;
  if (result.error || !result.data) {
    throw new Error(result.error?.message ?? "createFile returned no data");
  }

  return result.data;
}

// ─── Folder operations ────────────────────────────────────────────────────────

// ACO list query reused on the target side
const LIST_ALL_FOLDERS_ACO_QUERY = /* GraphQL */ `
  query ListAllAcoFolders($where: FoldersListWhereInput!, $after: String, $limit: Int) {
    aco {
      listFolders(where: $where, after: $after, limit: $limit) {
        data {
          id
          title
          slug
          parentId
        }
        meta {
          cursor
          hasMoreItems
          totalCount
        }
        error {
          message
        }
      }
    }
  }
`;

interface ListFoldersAcoResponse {
  aco: {
    listFolders: {
      data: Array<{ id: string; title: string; slug: string; parentId: string | null }>;
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

export async function fetchAllTargetFolders(client: GraphQLClient): Promise<FolderRecord[]> {
  // Try fileManager.listFolders first (Kibo CMS 5.34+).
  // Fall through to ACO on ANY error — including HTML responses from endpoints
  // that don't support this API, not just GraphQL schema errors.
  try {
    const all: FolderRecord[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const resp: ListFoldersResponse = await client.request<ListFoldersResponse>(
        LIST_ALL_FOLDERS_QUERY,
        { after: cursor, limit: 100 }
      );
      const result = resp.fileManager.listFolders;
      if (result.error) throw new Error(`FM listFolders error: ${result.error.message}`);
      all.push(...result.data);
      cursor = result.meta.cursor;
      hasMore = result.meta.hasMoreItems;
    }

    return all;
  } catch {
    // Any failure (schema mismatch, HTML response, network error) → try ACO
  }

  // Fall back to ACO service
  const all: FolderRecord[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListFoldersAcoResponse = await client.request<ListFoldersAcoResponse>(
      LIST_ALL_FOLDERS_ACO_QUERY,
      { where: { type: "FmFile" }, after: cursor, limit: 100 }
    );
    const result = resp.aco.listFolders;
    if (result.error) throw new Error(`Failed to list ACO folders: ${result.error.message}`);
    all.push(
      ...result.data.map((f) => ({ id: f.id, name: f.title, slug: f.slug, parentId: f.parentId }))
    );
    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }

  return all;
}

export async function createFolderInTarget(
  client: GraphQLClient,
  name: string,
  slug: string,
  parentId: string | null
): Promise<FolderRecord> {
  // Discover actual input type names at runtime — they vary across Kibo CMS versions
  const folderTypes = await discoverFolderInputTypes(client);

  const fmData: Record<string, unknown> = { name, slug };
  if (parentId) fmData["parentId"] = parentId;

  // Try fileManager.createFolder first (Kibo CMS 5.34+).
  // Fall through to ACO on ANY error — including wrong type names or HTML responses.
  let fmError: string | null = null;
  try {
    const mutation = buildCreateFolderFmMutation(folderTypes.fm);
    const resp = await client.request<CreateFolderFmResponse>(mutation, { data: fmData });
    const result = resp.fileManager.createFolder;
    if (result.error || !result.data) {
      throw new Error(result.error?.message ?? "createFolder returned no data");
    }
    return result.data;
  } catch (err) {
    fmError = err instanceof Error ? err.message : String(err);
    // fall through to ACO
  }

  // Fall back to ACO service
  const acoData: Record<string, unknown> = { title: name, slug, type: "FmFile", parentId: parentId ?? null };

  try {
    const mutation = buildCreateFolderAcoMutation(folderTypes.aco);
    const acoResp = await client.request<CreateFolderAcoResponse>(mutation, { data: acoData });
    const acoResult = acoResp.aco.createFolder;
    if (acoResult.error || !acoResult.data) {
      throw new Error(acoResult.error?.message ?? "ACO createFolder returned no data");
    }
    return {
      id: acoResult.data.id,
      name: acoResult.data.title,
      slug: acoResult.data.slug,
      parentId: acoResult.data.parentId,
    };
  } catch (acoErr) {
    // Both strategies failed — surface both error messages for diagnosis
    const acoMsg = acoErr instanceof Error ? acoErr.message : String(acoErr);
    throw new Error(`createFolder failed on both FM and ACO APIs:\n  FM : ${fmError}\n  ACO: ${acoMsg}`);
  }
}
