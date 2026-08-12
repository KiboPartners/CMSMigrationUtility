/**
 * Live target-tenant GraphQL probes for e2e verification.
 *
 * Connects directly to the TARGET Admin GQL / Manage API to confirm a
 * migrated item landed and to read status/version/values for
 * draft-vs-published and CDN-locality checks. Lookup rules mirror the
 * import/clone code paths.
 */

import { resolveEnvironment, loadRootEnv } from "../src/shared/config";
import { createClient } from "../src/shared/provider";
import { GraphQLClient } from "../src/shared/graphql";
import { defaultKeymapDir, loadStore, selectFileRemaps } from "../src/shared/keymap";
import {
  ModelDefinition,
  FieldDefinition,
  SYSTEM_FIELDS,
  capitalize,
  buildListQuery,
  seedMultiValueFileSkips,
  seedAllFileFieldSkips,
  isMultiValueFileSerializeError,
} from "../src/artifacts/cms-entries/introspect";
import { discoverPageBuilderOps, PageBuilderOps } from "../src/artifacts/page-builder/ops";
import { wrap } from "../src/artifacts/page-builder/categories";

// ─── Env + clients ────────────────────────────────────────────────────────────

export interface VerifyEnv {
  sourceTenant: string;
  targetTenant: string;
  sourceCdn: string;
  targetCdn: string;
}

/** Tenants + CDN domains for source/target. Specs skip when a CDN var is empty. */
export function loadVerifyEnv(): VerifyEnv {
  loadRootEnv();
  const source = resolveEnvironment("source", { required: false, requireCdn: false });
  const target = resolveEnvironment("target", { required: false, requireCdn: false });
  return {
    sourceTenant: source.tenant,
    targetTenant: target.tenant,
    sourceCdn: source.cdnDomain,
    targetCdn: target.cdnDomain,
  };
}

export interface TargetClients {
  admin: GraphQLClient;
  manage: GraphQLClient;
}

/** Admin GQL + Manage API clients for the target environment. */
export function targetClients(): TargetClients {
  const target = resolveEnvironment("target");
  return {
    admin: createClient(target),
    manage: createClient(target, { useManage: true }),
  };
}

// ─── model ────────────────────────────────────────────────────────────────────

interface ListContentModelsResp {
  listContentModels: {
    data: Array<{
      modelId: string;
      name: string;
      singularApiName?: string | null;
      pluralApiName?: string | null;
      fields: Array<{ fieldId: string; type: string; list?: boolean; settings?: Record<string, unknown> }>;
    }> | null;
    error: { message: string } | null;
  };
}

const LIST_CONTENT_MODELS_QUERY = /* GraphQL */ `
  {
    listContentModels {
      data {
        modelId
        name
        singularApiName
        pluralApiName
        fields { fieldId type list settings }
      }
      error { message }
    }
  }
`;

type RawTargetModel = NonNullable<ListContentModelsResp["listContentModels"]["data"]>[number];

/** Fetch one target content model by modelId (case-insensitive), or null. */
async function fetchTargetModel(manage: GraphQLClient, modelId: string): Promise<RawTargetModel | null> {
  const resp = await manage.request<ListContentModelsResp>(LIST_CONTENT_MODELS_QUERY, undefined, { maxAttempts: 1 });
  if (resp.listContentModels.error) {
    throw new Error(
      `fetchTargetModel(modelId=${modelId}): listContentModels failed — ${resp.listContentModels.error.message}`
    );
  }
  const data = resp.listContentModels.data ?? [];
  return data.find((m) => m.modelId.toLowerCase() === modelId.toLowerCase()) ?? null;
}

/** Presence check: does `modelId` exist on the target Manage API? */
export async function verifyModel(modelId: string): Promise<{ found: boolean; modelId: string }> {
  const { manage } = targetClients();
  const match = await fetchTargetModel(manage, modelId);
  return { found: !!match, modelId };
}

// ─── cms-entry ────────────────────────────────────────────────────────────────

function toModelDefinition(raw: RawTargetModel): ModelDefinition {
  const singular = raw.singularApiName || raw.modelId;
  const plural = raw.pluralApiName || `${raw.modelId}s`;
  const capSingular = capitalize(singular);
  const capPlural = capitalize(plural);
  const fields: FieldDefinition[] = (raw.fields ?? [])
    .filter((f) => !SYSTEM_FIELDS.has(f.fieldId))
    .map((f) => ({ fieldId: f.fieldId, type: f.type, multipleValues: f.list ?? false, settings: f.settings }));

  return {
    modelId: raw.modelId,
    name: raw.name,
    pluralApiName: plural,
    fields,
    listOperation: `list${capPlural}`,
    createOperation: `create${capSingular}`,
    updateOperation: `update${capSingular}`,
    publishOperation: `publish${capSingular}`,
    deleteOperation: `delete${capSingular}`,
    whereInputType: `${capSingular}ListWhereInput`,
  };
}

type EntryListResp = Record<
  string,
  { data: Array<Record<string, unknown>> | null; error: { message: string } | null } | undefined
>;

/**
 * Presence + status/version/values for one cms-entry on target.
 * Mirrors `fetchTargetEntryFingerprint` (cms-entries/clone.ts): resolve the
 * model's singular/plural API names via `listContentModels`, then run its
 * generated `list<Plural>(where: { entryId: { eq } })` query, selecting
 * `meta { status version }` alongside `values`.
 */
export async function verifyCmsEntry(
  modelId: string,
  entryId: string
): Promise<{ found: boolean; status: string | null; version: number | null; values: Record<string, unknown> }> {
  const { manage } = targetClients();
  const raw = await fetchTargetModel(manage, modelId);
  if (!raw) {
    return { found: false, status: null, version: null, values: {} };
  }
  const model = toModelDefinition(raw);
  // List-where inputs use flat comparator-suffix fields (e.g. `entryId`).
  const where = { entryId };
  // Multi-value file fields crash list serialization on this API (see
  // `export.ts`/`catalog.ts`) — seed the same skips up front, then drop-and-
  // retry once more (all file fields) if the server still complains.
  const skipFields = new Set<string>();
  seedMultiValueFileSkips(model, skipFields);

  let resp: EntryListResp | null = null;
  for (let attempt = 0; attempt < 2 && !resp; attempt++) {
    const query = buildListQuery(model, where, null, skipFields, undefined, ["meta { status version }"]);
    try {
      resp = await manage.request<EntryListResp>(query, { where });
    } catch (err) {
      const canRetry = attempt === 0 && isMultiValueFileSerializeError(err) && seedAllFileFieldSkips(model, skipFields).length > 0;
      if (!canRetry) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`verifyCmsEntry(model=${modelId}, entryId=${entryId}): ${model.listOperation} request failed — ${msg}`);
      }
    }
  }
  if (!resp) {
    throw new Error(`verifyCmsEntry(model=${modelId}, entryId=${entryId}): ${model.listOperation} request failed after retry`);
  }

  const result = resp[model.listOperation];
  if (!result || result.error) {
    throw new Error(
      `verifyCmsEntry(model=${modelId}, entryId=${entryId}): ${model.listOperation} returned an error — ${result?.error?.message ?? "no result"}`
    );
  }

  const data = result.data ?? [];
  const match =
    data.find((e) => String(e["entryId"] ?? e["id"] ?? "") === entryId) ?? (data.length === 1 ? data[0] : null);
  if (!match) {
    return { found: false, status: null, version: null, values: {} };
  }

  const meta = (match["meta"] as { status?: string | null; version?: number | null } | undefined) ?? {};
  const values = (match["values"] as Record<string, unknown> | undefined) ?? {};
  return { found: true, status: meta.status ?? null, version: meta.version ?? null, values };
}

// ─── page ─────────────────────────────────────────────────────────────────────

type PageLookupResp = Record<string, unknown>;

async function lookupPageBy(
  admin: GraphQLClient,
  ops: PageBuilderOps,
  field: "path" | "entryId",
  value: string
): Promise<Record<string, unknown> | null> {
  const whereType = ops.listPagesWhereType ?? "WbPagesListWhereInput";
  const inner = `
    ${ops.listPages}(where: $where, limit: 1) {
      data { ${ops.pageSelection} }
      error { message }
    }`;
  const query = `query VerifyLookupPage($where: ${whereType}) { ${wrap(ops.namespace, inner)} }`;

  let resp: PageLookupResp;
  try {
    resp = await admin.request<PageLookupResp>(query, { where: { [field]: value } });
  } catch (err) {
    // `ops.pageKeyFields.hasPath`/`hasEntryId` are derived from the page
    // *output* type, not from this where-input's fields — the field can
    // exist on one but not the other, and the request then errors. Mirror
    // production `findExistingPage` (page-builder/pages.ts) and degrade to
    // null so `verifyPage`'s `scanPagesForPath` fallback can still run,
    // instead of hard-failing the caller.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`verifyPage(${field}=${value}): ${ops.listPages} request failed, falling back to scan — ${msg}`);
    return null;
  }

  const nsResp = ops.namespace ? (resp[ops.namespace] as Record<string, unknown>) : resp;
  const result = nsResp[ops.listPages] as
    | { data: Array<Record<string, unknown>>; error: { message: string } | null }
    | undefined;
  if (!result) return null;
  if (result.error) {
    console.warn(`verifyPage(${field}=${value}): ${ops.listPages} returned an error, falling back to scan — ${result.error.message}`);
    return null;
  }
  // Path lives under `properties.path` on this install (see `pageProp`), not
  // the root field — and a `limit: 1` result is only a genuine match when it
  // actually equals the looked-up value, never an arbitrary `data[0]`.
  const match = result.data?.find((p) => (pageProp(p, field) ?? String(p[field] ?? "")) === value) ?? null;
  return match ?? null;
}

/** Page name/path live under `properties` on some Kibo versions; fall back to root. */
function pageProp(page: Record<string, unknown>, key: string): string | null {
  const props = page["properties"] as Record<string, unknown> | null | undefined;
  const v = (props && typeof props === "object" ? props[key] : undefined) ?? page[key];
  return typeof v === "string" && v ? v : null;
}

/**
 * Fallback for installs where `WbPagesListWhereInput` has no `path`/`properties`
 * filter at all (confirmed via `__type` introspection on this tenant) — the
 * same limitation that makes production `findExistingPage` (page-builder/pages.ts)
 * always create fresh pages there (never dedup by path). Scans recent pages
 * client-side and matches by `properties.path`, bounded to `maxPages` pages of
 * 50 so a large tenant can't make this loop unbounded.
 */
async function scanPagesForPath(
  admin: GraphQLClient,
  ops: PageBuilderOps,
  path: string,
  maxPages = 10
): Promise<Record<string, unknown> | null> {
  let cursor: string | null = null;
  let hasMore = true;
  for (let i = 0; i < maxPages && hasMore; i++) {
    const withAfter = !!cursor;
    const inner = `
      ${ops.listPages}(limit: 50${withAfter ? ", after: $after" : ""}) {
        data { ${ops.pageSelection} }
        meta { cursor hasMoreItems }
        error { message }
      }`;
    const query = `query VerifyScanPages${withAfter ? "($after: String)" : ""} { ${wrap(ops.namespace, inner)} }`;

    let resp: Record<string, unknown>;
    try {
      resp = await admin.request<Record<string, unknown>>(query, withAfter ? { after: cursor } : undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`scanPagesForPath(path=${path}): ${ops.listPages} request failed — ${msg}`);
    }
    const nsResp = ops.namespace ? (resp[ops.namespace] as Record<string, unknown>) : resp;
    const result = nsResp[ops.listPages] as
      | { data: Array<Record<string, unknown>>; meta: { cursor: string | null; hasMoreItems: boolean } | null; error: { message: string } | null }
      | undefined;
    if (!result || result.error) break;

    const match = result.data.find((p) => pageProp(p, "path") === path);
    if (match) return match;

    if (!result.meta) break;
    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }
  return null;
}

/**
 * Presence + status/version for a page on target. Prefers `opts.path` (the
 * import-time match key); falls back to `opts.entryId` when the target's
 * page type exposes it (`ops.pageKeyFields.hasEntryId`), then to a bounded
 * client-side scan by `properties.path` when the install exposes neither as
 * a where-filterable root field (see `scanPagesForPath`).
 */
export async function verifyPage(opts: {
  entryId?: string;
  path?: string;
}): Promise<{ found: boolean; status: string | null; version: number | null; page: Record<string, unknown> | null }> {
  if (!opts.path && !opts.entryId) {
    throw new Error("verifyPage: must supply opts.path or opts.entryId");
  }
  const { admin } = targetClients();
  const ops = await discoverPageBuilderOps(admin);

  let page: Record<string, unknown> | null = null;
  if (opts.path && ops.pageKeyFields.hasPath) {
    page = await lookupPageBy(admin, ops, "path", opts.path);
  }
  if (!page && opts.entryId && ops.pageKeyFields.hasEntryId) {
    page = await lookupPageBy(admin, ops, "entryId", opts.entryId);
  }
  if (!page && opts.path) {
    page = await scanPagesForPath(admin, ops, opts.path);
  }
  if (!page) {
    return { found: false, status: null, version: null, page: null };
  }

  const status = typeof page["status"] === "string" ? (page["status"] as string) : null;
  const version = typeof page["version"] === "number" ? (page["version"] as number) : null;
  return { found: true, status, version, page };
}

// ─── redirect ─────────────────────────────────────────────────────────────────

interface ListRedirectsProbeResp {
  websiteBuilder: {
    listRedirects: {
      data: Array<{ redirectFrom: string; redirectTo: string; isEnabled: boolean }>;
      meta: { cursor: string | null; hasMoreItems: boolean } | null;
      error: { message: string } | null;
    };
  };
}

const LIST_REDIRECTS_PROBE_QUERY = /* GraphQL */ `
  query VerifyListRedirects($after: String, $limit: Int) {
    websiteBuilder {
      listRedirects(after: $after, limit: $limit) {
        data { redirectFrom redirectTo isEnabled }
        meta { cursor hasMoreItems }
        error { message }
      }
    }
  }
`;

/**
 * Presence + redirectTo/isEnabled for a redirect on target, matched by
 * `redirectFrom` (mirrors `fetchAllTargetRedirects` in redirects/clone.ts, but
 * stops paging as soon as a match is found instead of building the full map).
 */
export async function verifyRedirect(
  redirectFrom: string
): Promise<{ found: boolean; redirectTo: string | null; isEnabled: boolean | null }> {
  const { admin } = targetClients();

  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    let resp: ListRedirectsProbeResp;
    try {
      resp = await admin.request<ListRedirectsProbeResp>(LIST_REDIRECTS_PROBE_QUERY, { after: cursor, limit: 100 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`verifyRedirect(${redirectFrom}): listRedirects request failed — ${msg}`);
    }
    const result = resp.websiteBuilder.listRedirects;
    if (result.error) {
      throw new Error(`verifyRedirect(${redirectFrom}): listRedirects returned an error — ${result.error.message}`);
    }
    const match = result.data.find((r) => r.redirectFrom === redirectFrom);
    if (match) {
      return { found: true, redirectTo: match.redirectTo, isEnabled: match.isEnabled };
    }
    if (!result.meta) break;
    cursor = result.meta.cursor;
    hasMore = result.meta.hasMoreItems;
  }

  return { found: false, redirectTo: null, isEnabled: null };
}

// ─── file ─────────────────────────────────────────────────────────────────────

interface ListFilesByKeyProbeResp {
  fileManager: {
    listFiles: {
      data: Array<{ id: string; key: string; src: string }>;
      error: { message: string } | null;
    };
  };
}

const LIST_FILES_BY_KEY_PROBE_QUERY = /* GraphQL */ `
  query VerifyListFilesByKey($where: FmFileListWhereInput) {
    fileManager {
      listFiles(limit: 1, where: $where) {
        data { id key src }
        error { message }
      }
    }
  }
`;

async function lookupFileByKey(
  admin: GraphQLClient,
  key: string
): Promise<{ id: string; key: string; src: string } | null> {
  const resp = await admin.request<ListFilesByKeyProbeResp>(LIST_FILES_BY_KEY_PROBE_QUERY, { where: { key } });
  const result = resp.fileManager.listFiles;
  if (result.error) return null;
  return result.data.find((f) => f.key === key) ?? null;
}

/**
 * Presence + src/key for a file on target. Lookup order (design doc §Lookup
 * rules / file):
 *   1. `.keymap` store row for (sourceTenant, targetTenant, fileId) → probe by `targetKey`
 *   2. `opts.sourceKey`, when the file was never re-keyed (same key on both sides)
 *   3. `fileId` itself, for installs where key === id-derived
 */
export async function verifyFile(
  fileId: string,
  opts: { sourceKey?: string } = {}
): Promise<{ found: boolean; src: string | null; key: string | null }> {
  const { admin } = targetClients();
  const env = loadVerifyEnv();
  const remaps = selectFileRemaps(loadStore(defaultKeymapDir()), env.sourceTenant, env.targetTenant);
  const remap = remaps.get(fileId);

  const candidateKeys = [remap?.targetKey, opts.sourceKey, fileId].filter(
    (k): k is string => !!k
  );

  for (const key of candidateKeys) {
    const hit = await lookupFileByKey(admin, key);
    if (hit) return { found: true, src: hit.src, key: hit.key };
  }

  return { found: false, src: null, key: null };
}
