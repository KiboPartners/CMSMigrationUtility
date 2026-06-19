/**
 * Model provisioning — ensure a content model exists on the target before
 * importing its entries.
 *
 * Kibo CMS/Kibo generates the per-model entry mutations (create<Model>, etc.) and
 * the <Model>Input type only after the model is defined. On an empty target this
 * step creates the model from the full Kibo model-export JSON via the Manage API
 * `createContentModel` mutation, then waits for the schema to regenerate.
 *
 * This module is engine code: it returns typed results and emits optional events,
 * never calls process.exit or writes to the console directly.
 */

import fs from "fs";
import { GraphQLClient, typeFieldNames, sleep } from "@kibo-cms-clone-tool/shared";
import { fetchSourceStructure } from "./structure";

/** Keys accepted by CmsContentModelFieldInput (from target introspection). */
const FIELD_KEYS = new Set([
  "id", "label", "help", "description", "note", "placeholder", "storageId",
  "fieldId", "type", "tags", "list", "predefinedValues", "renderer",
  "validation", "listValidation", "settings", "rules",
]);

/** Full model definition as it appears in the Kibo model-export JSON. */
export interface RawModel {
  modelId: string;
  name: string;
  singularApiName: string;
  pluralApiName: string;
  group?: string;
  icon?: string | null;
  description?: string | null;
  layout?: unknown;
  titleFieldId?: string | null;
  descriptionFieldId?: string | null;
  imageFieldId?: string | null;
  fields: Array<Record<string, unknown>>;
}

export type ProvisionAction = "created" | "already-exists" | "timed-out" | "failed";

export interface ProvisionResult {
  model: string;
  createOp: string;
  action: ProvisionAction;
  error?: string;
}

export interface ProvisionEvent {
  model: string;
  message: string;
}

export interface ProvisionOptions {
  /** Max time to wait for async schema regeneration. Default 60000ms. */
  pollDeadlineMs?: number;
  onEvent?: (e: ProvisionEvent) => void;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pickFieldInput(f: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (FIELD_KEYS.has(k) && v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** Read the full model definitions from a Kibo model-export JSON file. */
export function loadRawModels(schemaFile: string): RawModel[] {
  if (!fs.existsSync(schemaFile)) {
    throw new Error(`Schema file not found: ${schemaFile}\n  Export it from the Kibo admin UI: Content Models → ⋮ → Export`);
  }
  const raw = JSON.parse(fs.readFileSync(schemaFile, "utf-8")) as { models?: RawModel[] };
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error(`Schema file ${schemaFile} contains no models`);
  }
  return raw.models;
}

/** The generated create mutation name for a model (e.g. createPromoBanner). */
export function createOpFor(model: { singularApiName: string }): string {
  return `create${capitalize(model.singularApiName)}`;
}

// ── Live model fetch (replaces the manual Kibo model-export JSON) ───────────────
// The Manage API exposes the full model + field definition (CmsContentModelField
// output keys are 1:1 with CmsContentModelFieldInput), so we can fetch everything
// createContentModel needs straight from the source — no manual export step.

/** Hidden/system models we never migrate. */
function isSystemModel(modelId: string): boolean {
  return /^(wby|webhook|backgroundTask)/i.test(modelId);
}

export interface ModelSummary {
  modelId: string;
  name: string;
  singularApiName: string;
  pluralApiName: string;
  group: string | null;
  fieldCount: number;
}

interface ListModelsResp {
  listContentModels: { data: Array<{ modelId: string; name: string; singularApiName: string; pluralApiName: string; group: string | null; fields: unknown[] }> | null; error: { message: string } | null };
}

/** Lightweight list of source user models (one query) — for browsing/selection. */
export async function listSourceModels(manageClient: GraphQLClient): Promise<ModelSummary[]> {
  const resp = await manageClient.request<ListModelsResp>(
    `{ listContentModels { data { modelId name singularApiName pluralApiName group fields { fieldId } } error { message } } }`,
    undefined, { maxAttempts: 1 }
  );
  if (resp.listContentModels.error) throw new Error(resp.listContentModels.error.message);
  return (resp.listContentModels.data ?? [])
    .filter((m) => !isSystemModel(m.modelId))
    .map((m) => ({
      modelId: m.modelId, name: m.name, singularApiName: m.singularApiName,
      pluralApiName: m.pluralApiName, group: m.group ?? null, fieldCount: (m.fields ?? []).length,
    }));
}

/**
 * Fetch full definitions for the given model ids (or all source user models)
 * in a single `exportStructure` call — the same `{ groups, models }` envelope the
 * structure clone uses (see structure.ts). Returns the RawModel shape provisioning
 * consumes; no per-model round-trips, no manual schema file.
 *
 * `exportStructure` may pull in referenced models, so when specific ids are
 * requested we filter back down to them (preserving the previous per-id fetch
 * semantics — callers get exactly the models they asked for).
 */
export async function fetchSourceModelDefs(manageClient: GraphQLClient, modelIds?: string[]): Promise<RawModel[]> {
  const { models } = await fetchSourceStructure(manageClient, modelIds);
  let raw = (models as RawModel[]).filter((m) => !isSystemModel(m.modelId));
  if (modelIds && modelIds.length) {
    const want = new Set(modelIds.map((s) => s.toLowerCase()));
    raw = raw.filter((m) => want.has(m.modelId.toLowerCase()) || want.has(m.name.toLowerCase()));
  }
  return raw;
}

// ── Schema validation (source ↔ target field compatibility) ─────────────────────

export interface FieldDiff {
  fieldId: string;
  issue: "missing-on-target" | "type-mismatch" | "extra-on-target";
  sourceType?: string;
  targetType?: string;
}

export interface ModelCompat {
  modelId: string;
  ok: boolean;            // no blocking issues
  blocking: FieldDiff[];  // would break the import (missing field / type change)
  warnings: FieldDiff[];  // informational (extra target fields)
}

/**
 * Compare the source model's fields (as exported) against the target model's
 * live fields. Blocking = a source field the target lacks, or a type change on a
 * shared field (entries would be rejected/corrupted). Extra target fields are
 * warnings only.
 */
export function diffModelFields(
  modelId: string,
  sourceFields: Array<{ fieldId: string; type: string }>,
  targetFields: Array<{ fieldId: string; type: string }>
): ModelCompat {
  const tById = new Map(targetFields.map((f) => [f.fieldId, f.type]));
  const sIds = new Set(sourceFields.map((f) => f.fieldId));
  const blocking: FieldDiff[] = [];
  const warnings: FieldDiff[] = [];

  for (const sf of sourceFields) {
    if (!tById.has(sf.fieldId)) blocking.push({ fieldId: sf.fieldId, issue: "missing-on-target", sourceType: sf.type });
    else if (tById.get(sf.fieldId) !== sf.type) blocking.push({ fieldId: sf.fieldId, issue: "type-mismatch", sourceType: sf.type, targetType: tById.get(sf.fieldId) });
  }
  for (const tf of targetFields) {
    if (!sIds.has(tf.fieldId)) warnings.push({ fieldId: tf.fieldId, issue: "extra-on-target", targetType: tf.type });
  }
  return { modelId, ok: blocking.length === 0, blocking, warnings };
}

/**
 * Ensure a single model exists on the target Manage API. Creates it from the
 * raw export definition if missing, then polls until the generated create
 * mutation appears (schema regenerates asynchronously).
 */
export async function ensureModelProvisioned(
  manageClient: GraphQLClient,
  raw: RawModel,
  opts: ProvisionOptions = {}
): Promise<ProvisionResult> {
  const createOp = createOpFor(raw);
  const emit = (message: string) => opts.onEvent?.({ model: raw.name, message });

  try {
    const before = await typeFieldNames(manageClient);
    if (before.includes(createOp)) {
      return { model: raw.name, createOp, action: "already-exists" };
    }

    // Resolve a target group id: prefer same slug, else fall back to Ungrouped.
    const groupsResp = await manageClient.request<{
      listContentModelGroups: { data: Array<{ id: string; name: string; slug: string }> | null };
    }>(`{ listContentModelGroups { data { id name slug } error { message } } }`, undefined, { maxAttempts: 1 });
    const groups = groupsResp.listContentModelGroups.data ?? [];
    const wantSlug = String(raw.group ?? "").toLowerCase();
    const matched = groups.find((g) => g.slug?.toLowerCase() === wantSlug);
    const fallback = groups.find((g) => g.slug === "ungrouped") ?? groups[0];
    const groupId = (matched ?? fallback)?.id;
    if (!groupId) {
      return { model: raw.name, createOp, action: "failed", error: "no content model group available on target" };
    }
    emit(`creating model in group "${(matched ?? fallback)?.name}" (${groupId})`);

    const data: Record<string, unknown> = {
      name: raw.name,
      modelId: raw.modelId,
      singularApiName: raw.singularApiName,
      pluralApiName: raw.pluralApiName,
      group: groupId,
      fields: raw.fields.map(pickFieldInput),
      layout: raw.layout,
    };
    if (raw.titleFieldId) data.titleFieldId = raw.titleFieldId;
    if (raw.descriptionFieldId) data.descriptionFieldId = raw.descriptionFieldId;
    if (raw.imageFieldId) data.imageFieldId = raw.imageFieldId;
    if (raw.description) data.description = raw.description;

    const resp = await manageClient.request<{
      createContentModel: { data: { modelId: string } | null; error: { message: string; code?: string } | null };
    }>(
      `mutation Create($data: CmsContentModelCreateInput!) { createContentModel(data: $data) { data { modelId } error { message code } } }`,
      { data }, { maxAttempts: 1 }
    );
    if (resp.createContentModel.error) {
      const e = resp.createContentModel.error;
      return { model: raw.name, createOp, action: "failed", error: `${e.message}${e.code ? ` (${e.code})` : ""}` };
    }

    // Poll until the generated entry mutation appears (async schema regen).
    const deadline = opts.pollDeadlineMs ?? 60_000;
    let waited = 0, delay = 2000;
    while (waited < deadline) {
      const names = await typeFieldNames(manageClient);
      if (names.includes(createOp)) return { model: raw.name, createOp, action: "created" };
      await sleep(delay);
      waited += delay;
      delay = Math.min(delay * 1.5, 8000);
      emit(`waiting for schema regen (${Math.round(waited / 1000)}s)`);
    }
    return { model: raw.name, createOp, action: "timed-out", error: `${createOp} not available after ${deadline / 1000}s` };
  } catch (err) {
    return { model: raw.name, createOp, action: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ensure each of the named models exists on target. `wantedModelIds` filters the
 * raw models (match by modelId or name, case-insensitive); empty = all.
 */
export async function ensureModelsProvisioned(
  manageClient: GraphQLClient,
  rawModels: RawModel[],
  wantedModelIds: string[],
  opts: ProvisionOptions = {}
): Promise<ProvisionResult[]> {
  const want = new Set(wantedModelIds.map((s) => s.toLowerCase()));
  const selected = want.size
    ? rawModels.filter((m) => want.has(m.modelId.toLowerCase()) || want.has(m.name.toLowerCase()))
    : rawModels;

  const results: ProvisionResult[] = [];
  for (const raw of selected) {
    results.push(await ensureModelProvisioned(manageClient, raw, opts));
  }
  return results;
}
