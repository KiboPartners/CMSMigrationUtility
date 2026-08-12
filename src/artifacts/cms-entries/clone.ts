/**
 * Import step: read exported JSON files from disk, upsert entries into target.
 *
 * For each JSON file:
 *   1. Reconstruct ModelDefinition from the saved schema in the export file
 *   2. For each entry: create (or update if already exists) → publish
 *
 * No target introspection — operation names and field definitions come from
 * the schema captured at export time.
 */

import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import { GraphQLClient,
  rewriteCdnUrls,
  createProgressBar,
  updateProgress,
  stopProgress, logger,
  syncFolders,
  validateFolderMapping,
  formatFolderValidation,
  filterFoldersForIds,
  readNdjsonLines,
  sourceIsPublished,
  shouldPublishAfterUpsert,
  FolderNode } from "@kibo-cms-clone-tool/shared";
import {
  ModelDefinition,
  FieldDefinition,
  buildCreateMutation,
  buildUpdateMutation,
  buildPublishMutation,
  buildListQuery,
  SYSTEM_FIELDS,
} from "./introspect";
import { ImportConfig } from "./config";
import { ExportFile, SavedModelSchema } from "./export";
import { entryFolderAdapter, entryFolderId } from "./folders";

export interface EntryResult {
  id: string;
  action: "created" | "updated" | "skipped" | "error";
  published: boolean;
  error?: string;
}

export interface ModelCloneResult {
  modelName: string;
  total: number;
  created: number;
  updated: number;
  published: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
  /** Per-entry outcomes, for the run ledger / audit. */
  items: EntryResult[];
}

export interface EntrySource {
  modelName: string;
  schema: SavedModelSchema;
  folderType: string | null;
  folders: FolderNode[];
  /** Set when a streaming sidecar exists; import streams this file. */
  ndjsonPath: string | null;
  /** Set for a legacy single-JSON export; the inline entries array. */
  legacyEntries: Record<string, unknown>[] | null;
}

export function readExportManifest(dir: string): EntrySource[] {
  if (!fs.existsSync(dir)) throw new Error(`Export directory not found: ${dir}`);
  const jsonFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".entries.ndjson"));
  if (jsonFiles.length === 0) throw new Error(`No JSON files found in: ${dir}`);

  return jsonFiles.map((f) => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Record<string, unknown>;
    const modelName = String(meta["modelName"] ?? path.basename(f, ".json"));
    const ndjsonPath = path.join(dir, `${modelName}.entries.ndjson`);
    const hasSidecar = fs.existsSync(ndjsonPath);
    return {
      modelName,
      schema: meta["schema"] as SavedModelSchema,
      folderType: (meta["folderType"] as string | null) ?? null,
      folders: (meta["folders"] as FolderNode[]) ?? [],
      ndjsonPath: hasSidecar ? ndjsonPath : null,
      legacyEntries: hasSidecar ? null : ((meta["entries"] as Record<string, unknown>[]) ?? []),
    };
  });
}

/**
 * Load all entries for one model source — streams the ndjson sidecar, or returns
 * the legacy inline array. Holds one model's entries in memory (callers that need
 * the full id set: purge manifest, UI subset picker).
 */
export async function collectSourceEntries(source: EntrySource): Promise<Record<string, unknown>[]> {
  if (source.ndjsonPath) {
    const out: Record<string, unknown>[] = [];
    await readNdjsonLines(source.ndjsonPath, (e) => { out.push(e); });
    return out;
  }
  return source.legacyEntries ?? [];
}

/** Folder ids referenced by entries in `selection` (no ancestors). */
export function folderIdsForSelectedEntries(
  entries: Iterable<Record<string, unknown>>,
  selection: Set<string>
): Set<string> {
  const keep = new Set<string>();
  for (const entry of entries) {
    const entryId = extractEntryId(entry);
    if (!selection.has(entryId)) continue;
    const fid = entryFolderId(entry);
    if (fid) keep.add(fid);
  }
  return keep;
}

/**
 * Folders referenced by selected entries (+ ancestors). Used so selective import
 * does not sync the whole model folder tree.
 */
export function foldersForSelectedEntries(
  folders: FolderNode[],
  entries: Iterable<Record<string, unknown>>,
  selection: Set<string>
): FolderNode[] {
  return filterFoldersForIds(folders, folderIdsForSelectedEntries(entries, selection));
}

/** Thrown inside ndjson scan to stop reading once a selected entry is found. */
class SelectedEntryFound extends Error {
  constructor() { super("selected-entry-found"); }
}

async function sourceHasSelectedEntry(source: EntrySource, selection: Set<string>): Promise<boolean> {
  const check = (entry: Record<string, unknown>): boolean => {
    const eid = String(entry["entryId"] ?? entry["id"] ?? "");
    return !!eid && selection.has(eid);
  };
  if (source.ndjsonPath) {
    try {
      await readNdjsonLines(source.ndjsonPath, (e) => {
        if (check(e)) throw new SelectedEntryFound();
      });
    } catch (e) {
      if (e instanceof SelectedEntryFound) return true;
      throw e;
    }
    return false;
  }
  for (const e of source.legacyEntries ?? []) if (check(e)) return true;
  return false;
}

/**
 * Narrow an export manifest to models implicated by `--select`:
 * - modelId present in the selection, or
 * - at least one entryId in the selection belongs to the model.
 *
 * Used so selective import does not structure-clone / folder-sync every model
 * in the export folder (e.g. 1 entry must not pull all 29 models).
 */
export async function filterManifestForSelection(
  sources: EntrySource[],
  models: Map<string, ModelDefinition>,
  selection: Set<string>
): Promise<{ sources: EntrySource[]; models: Map<string, ModelDefinition> }> {
  const modelIdToName = new Map<string, string>();
  for (const [name, m] of models) modelIdToName.set(m.modelId, name);

  const neededNames = new Set<string>();
  for (const id of selection) {
    const name = modelIdToName.get(id);
    if (name) neededNames.add(name);
  }

  for (const source of sources) {
    if (neededNames.has(source.modelName)) continue;
    if (!models.has(source.modelName)) continue;
    if (await sourceHasSelectedEntry(source, selection)) neededNames.add(source.modelName);
  }

  if (neededNames.size === 0) {
    return { sources: [], models: new Map() };
  }

  return {
    sources: sources.filter((s) => neededNames.has(s.modelName)),
    models: new Map([...models].filter(([name]) => neededNames.has(name))),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractEntryId(entry: Record<string, unknown>): string {
  if (typeof entry["entryId"] === "string" && entry["entryId"]) {
    return entry["entryId"];
  }
  const id = String(entry["id"] ?? "");
  return id.includes("#") ? id.split("#")[0] : id;
}

function isAlreadyExistsError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("already exists") ||
    lower.includes("entry with id") ||
    lower.includes("duplicate") ||
    lower.includes("conflict")
  );
}

/**
 * Kibo CMS 6.x processes publish as an async background job.
 * The API may return an error immediately even though the job will complete
 * successfully.  Treat these as deferred publish (not a real failure).
 */
function isAsyncPublishError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("tried to get value from a failed result") ||
    lower.includes("async") ||
    lower.includes("background job") ||
    lower.includes("queued")
  );
}

/**
 * Kibo returns an opaque "Validation failed." with no field detail. The usual
 * cause is a required field sent as null/empty (e.g. a source entry with a null
 * value for a field the target model marks required). Append the input's
 * null/empty field names as a hint so the failure is actionable instead of a
 * dead-end message. No-op for non-validation errors.
 */
export function enrichValidationError(msg: string, input: Record<string, unknown>): string {
  if (!/validation/i.test(msg)) return msg;
  const suspects = Object.keys(input).filter((k) => {
    const v = input[k];
    return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  });
  return suspects.length
    ? `${msg} — likely a required field sent null/empty: ${suspects.join(", ")}`
    : msg;
}

/**
 * Build the $data input for create/update mutations.
 * Picks only the model's declared content fields from the flat entry object,
 * excluding system fields and entry-level metadata (id, entryId).
 * Optionally rewrites CDN domains in string values.
 */
/**
 * Kibo CMS's ref input (RefFieldInput) accepts only { modelId, id } — but exported
 * ref values carry an extra `entryId`, which the API rejects ("Field entryId is
 * not defined by type RefFieldInput"). Strip each ref to the accepted shape.
 */
export function cleanRef(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cleanRef);
  if (v && typeof v === "object") {
    const r = v as { modelId?: unknown; id?: unknown; entryId?: unknown };
    if (r.modelId !== undefined && (r.id !== undefined || r.entryId !== undefined)) {
      return { modelId: r.modelId, id: r.id ?? r.entryId };
    }
  }
  return v;
}

function buildEntryInput(
  entry: Record<string, unknown>,
  fields: ModelDefinition["fields"],
  sourceCdnDomain: string | null,
  targetCdnDomain: string | null,
  urlMap?: Record<string, string>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  for (const field of fields) {
    if (SYSTEM_FIELDS.has(field.fieldId)) continue;
    if (["id", "entryId"].includes(field.fieldId)) continue;
    if (entry[field.fieldId] !== undefined) {
      input[field.fieldId] = field.type === "ref" ? cleanRef(entry[field.fieldId]) : entry[field.fieldId];
    }
  }

  return rewriteCdnUrls(input, sourceCdnDomain, targetCdnDomain, urlMap) as Record<string, unknown>;
}

// ─── Content fingerprint (skip-identical) ─────────────────────────────────────

/**
 * System / metadata fields that must NOT influence the content fingerprint —
 * otherwise every entry looks "changed" on re-import. Covers Kibo CMS
 * entry-level metadata plus the ACO folder membership (handled separately).
 */
const FINGERPRINT_IGNORE_FIELDS = new Set<string>([
  "id",
  "entryId",
  "createdOn",
  "savedOn",
  "createdBy",
  "ownedBy",
  "modifiedBy",
  "meta",
  "version",
  "webinyVersion",
  "wbyAco_location",
  "status",
]);

/**
 * Produce a stable, order-independent JSON string of an entry's content values,
 * dropping system/metadata fields. Object keys are sorted recursively so two
 * semantically-identical payloads with different key order compare equal.
 *
 * Exported for unit testing of the normalization rules.
 */
export function normalizeEntryValues(values: Record<string, unknown>): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) {
        if (FINGERPRINT_IGNORE_FIELDS.has(key)) continue;
        const val = src[key];
        if (val === undefined) continue;
        out[key] = stable(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(stable(values));
}

/**
 * Compute the comparable fingerprint for the SOURCE side of an upsert.
 * `buildEntryInput` already strips system fields, cleans refs, and applies the
 * source→target CDN rewrite, so a CDN-only difference does not register as a
 * change. We then normalize (sort keys, drop metadata) for a stable signature.
 */
export function fingerprintSourceEntry(
  entry: Record<string, unknown>,
  fields: ModelDefinition["fields"],
  sourceCdnDomain: string | null,
  targetCdnDomain: string | null,
  urlMap?: Record<string, string>
): string {
  const input = buildEntryInput(entry, fields, sourceCdnDomain, targetCdnDomain, urlMap);
  return normalizeEntryValues(input);
}

type EntryLookupResponse = {
  [key: string]: {
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  };
};

/**
 * Fetch the existing target entry's content values by entryId, normalized the
 * same way as the source side. Returns the fingerprint string, or null if the
 * entry can't be found / the lookup fails (caller falls back to upsert).
 */
async function fetchTargetEntryFingerprint(
  targetClient: GraphQLClient,
  model: ModelDefinition,
  entryId: string
): Promise<string | null> {
  try {
    const query = buildListQuery(model, { entryId: { eq: entryId } });
    const resp = await targetClient.request<EntryLookupResponse>(query, {
      where: { entryId: { eq: entryId } },
    });
    const result = resp[model.listOperation];
    if (!result || result.error || !result.data || result.data.length === 0) {
      return null;
    }
    // Match the exact entry (the where may be honoured loosely by some servers).
    const match =
      result.data.find((e) => extractEntryId(e) === entryId) ?? result.data[0];
    const values = (match["values"] as Record<string, unknown> | undefined) ?? {};
    return normalizeEntryValues(values);
  } catch {
    return null; // lookup failure is non-fatal — fall back to upsert
  }
}

// ─── Upsert single entry ─────────────────────────────────────────────────────

/**
 * Build the ACO folder field for the entry input, remapped to the target tree.
 * Returns `{ wbyAco_location: { folderId } }` to spread into the mutation data,
 * or {} when the entry is intentionally at root / its folder is unmapped.
 */
function folderInput(
  entry: Record<string, unknown>,
  folderIdMap: Map<string, string>
): Record<string, unknown> {
  const srcId = entryFolderId(entry);
  if (!srcId) return {};
  const targetId = folderIdMap.get(srcId);
  return targetId ? { wbyAco_location: { folderId: targetId } } : {};
}

async function upsertEntry(
  targetClient: GraphQLClient,
  model: ModelDefinition,
  entry: Record<string, unknown>,
  config: ImportConfig,
  folderIdMap: Map<string, string>
): Promise<EntryResult> {
  const entryId = extractEntryId(entry);
  const input = buildEntryInput(
    entry,
    model.fields,
    config.sourceCdnDomain,
    config.targetCdnDomain,
    config.keyMap
  );
  const folder = folderInput(entry, folderIdMap);

  if (config.dryRun) {
    return { id: entryId, action: "skipped", published: false };
  }

  const createMutation = buildCreateMutation(model);
  const updateMutation = buildUpdateMutation(model);
  const publishMutation = buildPublishMutation(model);

  type MutResp = {
    [key: string]: {
      data: { id: string; entryId: string } | null;
      error: { message: string; code?: string } | null;
    };
  };

  let action: "created" | "updated" = "created";
  let targetEntryId = entryId;

  // Step 1: Create with the original entryId so it matches across environments.
  // Kibo CMS 6.x: content fields are nested under "values" in the Input type,
  // e.g. PromoBannerInput { id: ID, values: PromoBannerValuesInput }
  try {
    const resp = await targetClient.request<MutResp>(createMutation, {
      data: { id: entryId, values: input, ...folder },
    });
    const result = resp[model.createOperation];

    if (result?.error) {
      if (isAlreadyExistsError(result.error.message)) {
        action = "updated";
      } else {
        throw new Error(result.error.message);
      }
    } else if (result?.data) {
      targetEntryId = result.data.id;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAlreadyExistsError(msg)) {
      action = "updated";
    } else {
      return { id: entryId, action: "error", published: false, error: enrichValidationError(msg, input) };
    }
  }

  // Step 1b: Skip-identical — if the entry already exists, compare a normalized
  // content fingerprint of source vs the existing target entry. If they match,
  // skip without updating or publishing. A lookup failure falls back to upsert.
  if (action === "updated") {
    const targetFp = await fetchTargetEntryFingerprint(targetClient, model, entryId);
    if (targetFp !== null) {
      const sourceFp = fingerprintSourceEntry(
        entry,
        model.fields,
        config.sourceCdnDomain,
        config.targetCdnDomain,
        config.keyMap
      );
      if (sourceFp === targetFp) {
        return { id: entryId, action: "skipped", published: false };
      }
    }
  }

  // Step 2: Update if entry already existed
  if (action === "updated") {
    try {
      const resp = await targetClient.request<MutResp>(updateMutation, {
        revision: entryId,
        data: { values: input, ...folder },
      });
      const result = resp[model.updateOperation];
      if (result?.error) throw new Error(result.error.message);
      if (result?.data) targetEntryId = result.data.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: entryId, action: "error", published: false, error: enrichValidationError(msg, input) };
    }
  }

  // Step 3: Publish — only when not as-draft and the source was published.
  // Default as-draft leaves a draft revision on target (create/update already
  // do that). Kibo may return "Tried to get value from a failed Result" on
  // publish even though the async job succeeds — treat as deferred success.
  let published = false;
  if (shouldPublishAfterUpsert(config.asDraft, sourceIsPublished(entry))) {
    try {
      const resp = await targetClient.request<MutResp>(publishMutation, {
        revision: targetEntryId,
      });
      const result = resp[model.publishOperation];
      if (result?.error) {
        if (isAsyncPublishError(result.error.message)) {
          published = true; // async job — will complete in background
        } else {
          logger.warn(`  ⚠  Publish failed for ${entryId}: ${result.error.message}`);
        }
      } else {
        published = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAsyncPublishError(msg)) {
        published = true; // async job — will complete in background
      } else {
        logger.warn(`  ⚠  Publish error for ${entryId}: ${msg}`);
      }
    }
  }

  return { id: entryId, action, published };
}

// ─── Import one entry source (streaming, per-item folder check) ─────────────

/**
 * Stream-import one model's entries. Reads `source.ndjsonPath` line-by-line
 * when a sidecar exists, else iterates the legacy inline `entries` array —
 * never buffering the whole file either way.
 *
 * Folder validation is per-item: an entry whose folder did not sync becomes
 * an isolated error (or falls back to root when `--allow-folder-mismatch`
 * is set), instead of aborting the entire model's import.
 */
export async function importEntrySource(
  targetClient: GraphQLClient,
  model: ModelDefinition,
  source: EntrySource,
  config: ImportConfig,
  targetAdminClient: GraphQLClient,
  selection: Set<string> | null
): Promise<ModelCloneResult> {
  const result: ModelCloneResult = {
    modelName: model.name, total: 0, created: 0, updated: 0, published: 0, skipped: 0, errors: [], items: [],
  };

  // Sync the folder tree up front (folders come from the small metadata sidecar).
  // When --select is active, only folders referenced by selected entries (+ ancestors).
  const folderType = source.folderType ?? model.modelId;
  let foldersToSync = source.folders ?? [];
  if (selection && selection.size && foldersToSync.length) {
    const keep = new Set<string>();
    const noteFolder = (entry: Record<string, unknown>) => {
      for (const id of folderIdsForSelectedEntries([entry], selection)) keep.add(id);
    };
    if (source.ndjsonPath) {
      await readNdjsonLines(source.ndjsonPath, noteFolder);
    } else {
      for (const e of source.legacyEntries ?? []) noteFolder(e);
    }
    const before = foldersToSync.length;
    foldersToSync = filterFoldersForIds(foldersToSync, keep);
    if (before !== foldersToSync.length) {
      logger.log(`  Folders kept for selection (${model.name}): ${foldersToSync.length}/${before}`);
    }
  }
  const sync = await syncFolders(
    entryFolderAdapter(targetAdminClient, folderType),
    foldersToSync,
    { dryRun: config.dryRun, label: `${model.name} folder`, logger }
  );
  const folderIdMap = sync.idMap;

  // Bounded in-flight window (not a pLimit queue of all N tasks up front) —
  // keeps only ~config.concurrency entries resident in memory at once, so
  // readNdjsonLines' per-line `await onItem` actually applies backpressure
  // on the file reader for large models.
  const inFlight = new Set<Promise<void>>();

  const run = async (entryId: string, entry: Record<string, unknown>): Promise<void> => {
    // Per-item folder validation (replaces the whole-file pre-flight gate).
    const srcFolder = entryFolderId(entry);
    if (srcFolder && !folderIdMap.has(srcFolder) && !config.allowFolderMismatch) {
      result.errors.push({ id: entryId, error: `references folder "${srcFolder}" that did not sync (pass --allow-folder-mismatch to send to root)` });
      result.items.push({ id: entryId, action: "error", published: false, error: "folder did not sync" });
      return;
    }
    const r = await upsertEntry(targetClient, model, entry, config, folderIdMap);
    result.items.push(r);
    if (r.action === "created") result.created++;
    else if (r.action === "updated") result.updated++;
    else if (r.action === "skipped") result.skipped++;
    else result.errors.push({ id: r.id, error: r.error ?? "unknown" });
    if (r.published) result.published++;
  };

  const handle = async (entry: Record<string, unknown>) => {
    const entryId = extractEntryId(entry);
    if (selection && !selection.has(entryId)) return;      // per-item selection filter
    result.total++;
    const p = run(entryId, entry).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= config.concurrency) await Promise.race(inFlight);
  };

  if (source.ndjsonPath) {
    await readNdjsonLines(source.ndjsonPath, handle);       // awaits handle → backpressure
  } else {
    for (const e of source.legacyEntries ?? []) await handle(e);
  }
  await Promise.all(inFlight);
  return result;
}

// ─── Import one model file ────────────────────────────────────────────────────

export async function importModelFile(
  targetClient: GraphQLClient,
  model: ModelDefinition,
  exportFile: ExportFile,
  config: ImportConfig,
  targetAdminClient: GraphQLClient
): Promise<ModelCloneResult> {
  const { entries } = exportFile;

  const result: ModelCloneResult = {
    modelName: model.name,
    total: entries.length,
    created: 0,
    updated: 0,
    published: 0,
    skipped: 0,
    errors: [],
    items: [],
  };

  if (entries.length === 0) return result;

  // Sync this model's ACO folder tree (Admin endpoint, type = modelId), then
  // remap each entry's wbyAco_location.folderId to the target tree.
  const folderType = exportFile.folderType ?? model.modelId;
  const sync = await syncFolders(
    entryFolderAdapter(targetAdminClient, folderType),
    exportFile.folders ?? [],
    { dryRun: config.dryRun, label: `${model.name} folder`, logger }
  );
  const folderIdMap = sync.idMap;

  // Validate folder mapping before writing — blocks unless --allow-folder-mismatch.
  if (!config.dryRun) {
    const refs = entries.map((e) => ({ itemId: extractEntryId(e), folderId: entryFolderId(e) }));
    const report = validateFolderMapping(refs, sync);
    if (!report.ok) {
      formatFolderValidation(report, `${model.name} entry`).forEach((l) => logger.warn(`  ${l}`));
      if (!config.allowFolderMismatch) {
        throw new Error(
          `Folder validation failed: ${report.issues.length} ${model.name} entry(ies) reference ` +
            `folders that did not sync to the target. Pass --allow-folder-mismatch to import anyway.`
        );
      }
    }
  }

  const bar = createProgressBar(model.name, entries.length);
  const limit = pLimit(config.concurrency);
  let processed = 0;

  const tasks = entries.map((entry) =>
    limit(async () => {
      const r = await upsertEntry(targetClient, model, entry, config, folderIdMap);
      result.items.push(r);

      if (r.action === "created") result.created++;
      else if (r.action === "updated") result.updated++;
      else if (r.action === "skipped") result.skipped++;
      else result.errors.push({ id: r.id, error: r.error ?? "unknown" });

      if (r.published) result.published++;

      processed++;
      updateProgress(bar, processed);
    })
  );

  await Promise.all(tasks);
  stopProgress(bar);

  return result;
}

// ─── Discover export files on disk ───────────────────────────────────────────

export function readExportFiles(dir: string): ExportFile[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Export directory not found: ${dir}`);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f));

  if (files.length === 0) {
    throw new Error(`No JSON files found in: ${dir}`);
  }

  return files.map((f) => {
    const raw = fs.readFileSync(f, "utf-8");
    return JSON.parse(raw) as ExportFile;
  });
}

// ─── Reconstruct ModelDefinitions from export files ──────────────────────────

/**
 * Build a ModelDefinition map directly from the schemas saved in export files.
 * No target API calls — operation names and fields come from the export.
 */
export function buildModelsFromExportFiles(
  exportFiles: ExportFile[]
): Map<string, ModelDefinition> {
  const models = new Map<string, ModelDefinition>();

  for (const file of exportFiles) {
    if (!file.schema) {
      logger.warn(`  ⚠  Export file for "${file.modelName}" has no saved schema — re-export with the latest tool`);
      continue;
    }
    const s = file.schema;
    models.set(s.name, {
      modelId: s.modelId,
      name: s.name,
      pluralApiName: s.pluralApiName,
      fields: s.fields as FieldDefinition[],
      listOperation: s.listOperation,
      createOperation: s.createOperation,
      updateOperation: s.updateOperation,
      publishOperation: s.publishOperation,
      deleteOperation: s.deleteOperation ?? `delete${s.modelId.charAt(0).toUpperCase() + s.modelId.slice(1)}`,
      whereInputType: s.whereInputType,
    });
  }

  return models;
}

// ─── Reconstruct ModelDefinitions from the streaming manifest ───────────────

/**
 * Same reconstruction as `buildModelsFromExportFiles`, but from the metadata
 * sidecars produced by `readExportManifest` (one `SavedModelSchema` per source,
 * no need to have loaded the (possibly huge) entries array to get it).
 */
export function buildModelsFromManifest(sources: EntrySource[]): Map<string, ModelDefinition> {
  const map = new Map<string, ModelDefinition>();
  for (const s of sources) {
    const sc = s.schema;
    if (!sc) continue;
    map.set(s.modelName, {
      modelId: sc.modelId, name: sc.name, pluralApiName: sc.pluralApiName, fields: sc.fields,
      listOperation: sc.listOperation, createOperation: sc.createOperation, updateOperation: sc.updateOperation,
      publishOperation: sc.publishOperation,
      deleteOperation: sc.deleteOperation ?? `delete${sc.modelId.charAt(0).toUpperCase() + sc.modelId.slice(1)}`,
      whereInputType: sc.whereInputType,
    });
  }
  return map;
}
