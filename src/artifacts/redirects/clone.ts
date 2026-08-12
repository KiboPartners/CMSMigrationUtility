/**
 * Import step: read exported redirects.json from disk,
 * upsert each redirect in the target Website Builder.
 *
 * Upsert logic:
 *   - Fetch all existing redirects from target (keyed by redirectFrom)
 *   - Same redirectFrom + same redirectTo → skip (unchanged)
 *   - Same redirectFrom, different redirectTo/type/enabled → update
 *   - Not found → create
 */

import fs from "fs";
import path from "path";
import {
  GraphQLClient,
  logger,
  syncFolders,
  FolderAdapter,
  FolderNode,
  resolveAcoFolderInputType,
  readNdjsonLines,
} from "@kibo-cms-clone-tool/shared";
import { ExportFile, RedirectRecord, FolderRecord } from "./export";
import { ImportConfig } from "./config";

export interface RedirectResult {
  /** redirectFrom — used for `--select` matching and the run ledger. */
  id: string;
  action: "created" | "updated" | "skipped" | "error";
  error?: string;
}

export interface ImportStats {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ from: string; error: string }>;
  /** Per-redirect outcomes, for the run ledger / audit — populated during streaming. */
  items: RedirectResult[];
}

// ─── GraphQL operations ───────────────────────────────────────────────────────

const LIST_ALL_REDIRECTS_QUERY = /* GraphQL */ `
  query ListAllRedirects($after: String, $limit: Int) {
    websiteBuilder {
      listRedirects(after: $after, limit: $limit) {
        data {
          id
          redirectFrom
          redirectTo
          redirectType
          isEnabled
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

// Mutations are built dynamically once input type names are discovered via introspection
function buildCreateMutation(inputType: string): string {
  return /* GraphQL */ `
    mutation CreateRedirect($data: ${inputType}!) {
      websiteBuilder {
        createRedirect(data: $data) {
          data { id redirectFrom redirectTo redirectType isEnabled }
          error { message }
        }
      }
    }
  `;
}

function buildUpdateMutation(inputType: string): string {
  return /* GraphQL */ `
    mutation UpdateRedirect($id: ID!, $data: ${inputType}!) {
      websiteBuilder {
        updateRedirect(id: $id, data: $data) {
          data { id redirectFrom redirectTo redirectType isEnabled }
          error { message }
        }
      }
    }
  `;
}

/**
 * Traverse the schema starting from the root mutation type to find the
 * exact input type names for createRedirect / updateRedirect.
 *
 * Strategy (does NOT rely on knowing the mutation type name in advance):
 *   __schema.mutationType → find "websiteBuilder" field → unwrap its return
 *   type → find "createRedirect" / "updateRedirect" fields → unwrap their
 *   "data" arg type.
 *
 * Unwrapping handles NON_NULL and LIST wrappers up to two levels deep, which
 * covers every real-world case (the input type itself is always a named type).
 */
const INTROSPECT_MUTATION_SCHEMA_QUERY = /* GraphQL */ `
  query IntrospectWbMutationSchema {
    __schema {
      mutationType {
        fields {
          name
          type {
            name
            kind
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
`;

type ArgType = {
  name: string | null;
  kind: string;
  ofType: { name: string | null; kind: string; ofType: { name: string | null; kind: string } | null } | null;
};

type MutationTypeMap = { create: string; update: string };

/** Unwrap NON_NULL / LIST wrappers and return the first named type encountered. */
function resolveTypeName(t: ArgType | null | undefined): string {
  if (!t) return "";
  if (t.name) return t.name;
  if (t.ofType?.name) return t.ofType.name;
  if (t.ofType?.ofType?.name) return t.ofType.ofType.name;
  return "";
}

async function discoverMutationTypes(client: GraphQLClient): Promise<MutationTypeMap> {
  const fallback: MutationTypeMap = {
    create: "WebsiteBuilderCreateRedirectInput",
    update: "WebsiteBuilderUpdateRedirectInput",
  };

  try {
    type SchemaResp = {
      __schema: {
        mutationType: {
          fields: Array<{
            name: string;
            type: {
              name: string | null;
              kind: string;
              fields: Array<WbField> | null;
              ofType: {
                name: string | null;
                kind: string;
                fields: Array<WbField> | null;
              } | null;
            };
          }>;
        } | null;
      };
    };

    type WbField = {
      name: string;
      args: Array<{ name: string; type: ArgType }>;
    };

    const resp = await client.request<SchemaResp>(INTROSPECT_MUTATION_SCHEMA_QUERY);

    const mutationType = resp.__schema?.mutationType;
    if (!mutationType) return fallback;

    // Find the "websiteBuilder" field on the root mutation
    const wbField = mutationType.fields.find((f) => f.name === "websiteBuilder");
    if (!wbField) return fallback;

    // The return type may be wrapped in NON_NULL — unwrap one level
    const wbTypeDef = wbField.type;
    const wbFields: WbField[] | null =
      wbTypeDef.fields ??
      wbTypeDef.ofType?.fields ??
      null;

    if (!wbFields) return fallback;

    const findInputType = (opName: string): string => {
      const op = wbFields.find((f) => f.name === opName);
      const dataArg = op?.args.find((a) => a.name === "data");
      return resolveTypeName(dataArg?.type ?? null) || "";
    };

    const createType = findInputType("createRedirect");
    const updateType = findInputType("updateRedirect");

    if (!createType && !updateType) {
      logger.log("  ⚠  Could not discover mutation types via schema traversal — using fallback names");
      return fallback;
    }

    return {
      create: createType || fallback.create,
      update: updateType || fallback.update,
    };
  } catch {
    return fallback;
  }
}

interface ListRedirectsResponse {
  websiteBuilder: {
    listRedirects: {
      data: RedirectRecord[];
      meta?: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };
}

interface MutateRedirectResponse {
  websiteBuilder: {
    createRedirect?: { data: RedirectRecord | null; error: { message: string } | null };
    updateRedirect?: { data: RedirectRecord | null; error: { message: string } | null };
  };
}

// ─── Folder operations (ACO) ──────────────────────────────────────────────────

const LIST_TARGET_FOLDERS_QUERY = /* GraphQL */ `
  query ListTargetRedirectFolders($where: FoldersListWhereInput!, $after: String, $limit: Int) {
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

// aco createFolder input type varies by version — resolved at runtime (shared).
const createFolderAcoMutation = (inputType: string) => /* GraphQL */ `
  mutation CreateRedirectFolder($data: ${inputType}!) {
    aco {
      createFolder(data: $data) {
        data {
          id
          title
          slug
          parentId
        }
        error {
          message
        }
      }
    }
  }
`;

interface ListTargetFoldersResponse {
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

const REDIRECT_FOLDER_TYPE_CANDIDATES = [
  "wb:redirect", // namespaced ACO type used on current Kibo CMS installs
  "WbRedirect",
  "WebsiteBuilderRedirect",
  "Redirect",
  "PbRedirect",
];

/** Page through every ACO folder of one `type`, normalized to FolderNode. */
async function fetchFoldersOfType(client: GraphQLClient, type: string): Promise<FolderNode[]> {
  const out: FolderNode[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListTargetFoldersResponse = await client.request<ListTargetFoldersResponse>(
      LIST_TARGET_FOLDERS_QUERY,
      { where: { type }, after: cursor, limit: 100 }
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

/**
 * Folder adapter for redirects. The ACO folder `type` discriminator varies by
 * Kibo CMS version, so the first list probes the candidates and locks onto the
 * one that responds; that same type is reused for creates. If none respond, we
 * proceed with an empty target index (creates will surface any real failure).
 */
function redirectFolderAdapter(client: GraphQLClient): FolderAdapter {
  let activeType = REDIRECT_FOLDER_TYPE_CANDIDATES[0];
  return {
    listTargetFolders: async () => {
      for (const type of REDIRECT_FOLDER_TYPE_CANDIDATES) {
        try {
          const folders = await fetchFoldersOfType(client, type);
          activeType = type;
          return folders;
        } catch {
          // try the next candidate type
        }
      }
      return [];
    },
    createFolder: async ({ name, slug, parentId }) => {
      const inputType = await resolveAcoFolderInputType(client);
      const resp = await client.request<CreateFolderResponse>(createFolderAcoMutation(inputType), {
        data: { title: name, slug, type: activeType, parentId: parentId ?? null },
      });
      const result = resp.aco.createFolder;
      if (result.error || !result.data) {
        throw new Error(result.error?.message ?? "createFolder returned no data");
      }
      return result.data.id;
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function readExportFile(dir: string): ExportFile {
  const filePath = path.join(dir, "redirects.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Export file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ExportFile;
}

// ─── Read export manifest (streaming sidecar or legacy inline array) ─────────

export interface RedirectsSource {
  folders: FolderRecord[];
  /** Set when a streaming sidecar exists; import streams this file. */
  ndjsonPath: string | null;
  /** Set for a legacy single-JSON export; the inline redirects array. */
  legacyRedirects: RedirectRecord[] | null;
}

export function readRedirectsManifest(dir: string): RedirectsSource {
  const filePath = path.join(dir, "redirects.json");
  if (!fs.existsSync(filePath)) throw new Error(`Export file not found: ${filePath}`);
  const meta = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ExportFile & { count?: number };
  const ndjsonPath = path.join(dir, "redirects.entries.ndjson");
  const hasSidecar = fs.existsSync(ndjsonPath);
  return {
    folders: meta.folders ?? [],
    ndjsonPath: hasSidecar ? ndjsonPath : null,
    legacyRedirects: hasSidecar ? null : (meta.redirects ?? []),
  };
}

/**
 * Load all redirects for one export — streams the ndjson sidecar, or returns
 * the legacy inline array. Holds the full array in memory (callers that need
 * the full set: export-based purge, UI subset picker).
 */
export async function collectSourceRedirects(source: RedirectsSource): Promise<RedirectRecord[]> {
  if (source.ndjsonPath) {
    const out: RedirectRecord[] = [];
    await readNdjsonLines(source.ndjsonPath, (r) => { out.push(r as unknown as RedirectRecord); });
    return out;
  }
  return source.legacyRedirects ?? [];
}

async function fetchAllTargetRedirects(
  client: GraphQLClient
): Promise<Map<string, RedirectRecord>> {
  const byFrom = new Map<string, RedirectRecord>();
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const resp: ListRedirectsResponse = await client.request<ListRedirectsResponse>(LIST_ALL_REDIRECTS_QUERY, {
      after: cursor,
      limit: 100,
    });
    const result: ListRedirectsResponse["websiteBuilder"]["listRedirects"] = resp.websiteBuilder.listRedirects;
    if (result.error) throw new Error(`Failed to list target redirects: ${result.error.message}`);

    for (const r of result.data) {
      byFrom.set(r.redirectFrom, r);
    }

    if (result.meta) {
      cursor = result.meta.cursor;
      hasMore = result.meta.hasMoreItems;
    } else {
      hasMore = false;
    }
  }

  return byFrom;
}

function buildRedirectInput(
  r: RedirectRecord,
  targetFolderId?: string
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    redirectFrom: r.redirectFrom,
    redirectTo: r.redirectTo,
    isEnabled: r.isEnabled,
    // location is required (WbLocationInput!) — fall back to "root" when no folder
    location: { folderId: targetFolderId ?? "root" },
  };
  if (r.redirectType) input["redirectType"] = r.redirectType;
  return input;
}

async function upsertRedirect(
  client: GraphQLClient,
  redirect: RedirectRecord,
  existing: Map<string, RedirectRecord>,
  folderIdMap: Map<string, string>,
  mutations: { create: string; update: string }
): Promise<"created" | "updated" | "unchanged"> {
  const target = existing.get(redirect.redirectFrom);
  const sourceFolderId = redirect.location?.folderId ?? null;
  const targetFolderId = sourceFolderId ? folderIdMap.get(sourceFolderId) : undefined;

  if (target) {
    // Already exists — skip if nothing changed
    if (
      target.redirectTo === redirect.redirectTo &&
      target.redirectType === redirect.redirectType &&
      target.isEnabled === redirect.isEnabled
    ) {
      return "unchanged";
    }

    const resp = await client.request<MutateRedirectResponse>(mutations.update, {
      id: target.id,
      data: buildRedirectInput(redirect, targetFolderId),
    });
    const result = resp.websiteBuilder.updateRedirect!;
    if (result.error || !result.data) {
      throw new Error(result.error?.message ?? "updateRedirect returned no data");
    }
    return "updated";
  }

  // Not found — create
  const resp = await client.request<MutateRedirectResponse>(mutations.create, {
    data: buildRedirectInput(redirect, targetFolderId),
  });
  const result = resp.websiteBuilder.createRedirect!;
  if (result.error || !result.data) {
    // Input type name may differ — fall back with a helpful message
    throw new Error(result.error?.message ?? "createRedirect returned no data");
  }
  return "created";
}

// ─── Main import function (streaming) ────────────────────────────────────────

/**
 * Stream-import redirects. Reads `source.ndjsonPath` line-by-line when a
 * sidecar exists, else iterates the legacy inline `redirects` array — never
 * buffering the whole file. Uses a bounded in-flight window (`config.concurrency`).
 *
 * Redirects have no per-item folder gate: unmapped folders fall back to the
 * "root" sentinel in `buildRedirectInput` after the up-front folder sync.
 */
export async function importRedirects(
  targetClient: GraphQLClient,
  source: RedirectsSource,
  config: ImportConfig,
  selection: Set<string> | null
): Promise<ImportStats> {
  const stats: ImportStats = {
    total: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    items: [],
  };

  // Step 1: sync folder tree (metadata sidecar — always small, never streamed).
  const sync = await syncFolders(redirectFolderAdapter(targetClient), source.folders, {
    dryRun: config.dryRun,
    label: "redirect folder",
    logger,
  });
  const folderIdMap = sync.idMap;

  logger.log(`\n  Importing redirects${source.ndjsonPath ? " (streaming)" : ""}...`);

  // Step 2: discover mutation types + prefetch existing target redirects.
  // Skipped in dry-run — no writes happen, so no need to hit the target.
  let mutations: { create: string; update: string } | null = null;
  let existing: Map<string, RedirectRecord> = new Map();
  if (!config.dryRun) {
    logger.log(`\n  Discovering mutation types...`);
    const mutationTypeMap = await discoverMutationTypes(targetClient);
    mutations = {
      create: buildCreateMutation(mutationTypeMap.create),
      update: buildUpdateMutation(mutationTypeMap.update),
    };
    logger.log(`  createRedirect input: ${mutationTypeMap.create}`);
    logger.log(`  updateRedirect input: ${mutationTypeMap.update}`);

    logger.log(`\n  Fetching existing redirects from target...`);
    existing = await fetchAllTargetRedirects(targetClient);
    logger.log(`  ${existing.size} existing redirect(s) in target`);
  }

  // Bounded in-flight window — keeps only ~config.concurrency redirects
  // resident in memory at once, so readNdjsonLines' per-line `await onItem`
  // actually applies backpressure on the file reader for large exports.
  const inFlight = new Set<Promise<void>>();
  let previewShown = 0;

  const run = async (redirect: RedirectRecord): Promise<void> => {
    if (config.dryRun) {
      if (previewShown < 20) {
        const status = redirect.isEnabled ? "✓" : "✗";
        logger.log(`    [${status}] ${redirect.redirectFrom}  →  ${redirect.redirectTo}  (${redirect.redirectType ?? "default"})`);
        previewShown++;
      }
      stats.skipped++;
      stats.items.push({ id: redirect.redirectFrom, action: "skipped" });
      return;
    }

    // Isolate request failures as per-item errors so streaming import continues.
    try {
      const outcome = await upsertRedirect(targetClient, redirect, existing, folderIdMap, mutations!);
      const action = outcome === "unchanged" ? "skipped" : outcome;
      if (outcome === "created") stats.created++;
      else if (outcome === "updated") stats.updated++;
      else stats.skipped++;
      stats.items.push({ id: redirect.redirectFrom, action });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.errors.push({ from: redirect.redirectFrom, error: message });
      stats.items.push({ id: redirect.redirectFrom, action: "error", error: message });
    }
  };

  const handle = async (redirect: RedirectRecord) => {
    if (selection && !selection.has(redirect.redirectFrom)) return; // per-item selection filter
    stats.total++;
    const p = run(redirect).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= config.concurrency) await Promise.race(inFlight);
  };

  if (source.ndjsonPath) {
    await readNdjsonLines(source.ndjsonPath, (o) => handle(o as unknown as RedirectRecord)); // awaits handle → backpressure
  } else {
    for (const r of source.legacyRedirects ?? []) await handle(r);
  }
  await Promise.all(inFlight);

  return stats;
}
