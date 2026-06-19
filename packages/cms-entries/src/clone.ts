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
  createProgressBar,
  updateProgress,
  stopProgress, logger,
  syncFolders,
  validateFolderMapping,
  formatFolderValidation } from "@kibo-cms-clone-tool/shared";
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
import { ExportFile } from "./export";
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
  targetCdnDomain: string | null
): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  for (const field of fields) {
    if (SYSTEM_FIELDS.has(field.fieldId)) continue;
    if (["id", "entryId"].includes(field.fieldId)) continue;
    if (entry[field.fieldId] !== undefined) {
      input[field.fieldId] = field.type === "ref" ? cleanRef(entry[field.fieldId]) : entry[field.fieldId];
    }
  }

  if (sourceCdnDomain && targetCdnDomain) {
    return JSON.parse(
      JSON.stringify(input).replaceAll(sourceCdnDomain, targetCdnDomain)
    ) as Record<string, unknown>;
  }

  return input;
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
  targetCdnDomain: string | null
): string {
  const input = buildEntryInput(entry, fields, sourceCdnDomain, targetCdnDomain);
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
    config.targetCdnDomain
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
      return { id: entryId, action: "error", published: false, error: msg };
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
        config.targetCdnDomain
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
      return { id: entryId, action: "error", published: false, error: msg };
    }
  }

  // Step 3: Publish — always publish after create/update.
  // Kibo CMS 6.x does not expose a queryable `status` field on content entries,
  // so we cannot know the original publish state.  All cloned entries are
  // published; unpublish manually on target if needed.
  //
  // Note: Kibo CMS 6.x processes publish as an async background job and may
  // return "Tried to get value from a failed Result" immediately even though
  // the publish completes successfully in the background.  We treat that
  // specific error as a deferred success so the summary stays accurate.
  let published = false;
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

  return { id: entryId, action, published };
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
