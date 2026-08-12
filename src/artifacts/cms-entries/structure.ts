/**
 * CMS content-model **structure** clone (groups + models + fields) — the
 * prerequisite for cloning entries.
 *
 * Kibo generates the per-model GraphQL types and mutations (`PromoBannerInput`,
 * `createPromoBanner`, …) only AFTER a model is defined. So a model must exist on
 * the target before any of its entries can be imported. This module wraps the two
 * inverse Manage-API operations that move the structure between tenants:
 *
 *   exportStructure (source)  →  { groups, models }  (returned as a JSON string)
 *   importStructure (target)  →  recreates groups + models + fields in one call
 *
 * Structure can also be persisted as `cms/models.json` (export-models) for offline
 * import-models. The `{ groups, models }` envelope matches the Kibo admin UI
 * Content Models → Export shape.
 */

import fs from "fs";
import path from "path";
import { GraphQLClient, typeFieldNames, sleep, logger } from "@kibo-cms-clone-tool/shared";

export interface CmsStructure {
  groups: unknown[];
  models: unknown[];
}

/** On-disk models export (`cms/models.json`). */
export interface ModelsExportFile extends CmsStructure {
  exportedAt: string;
  sourceTenant?: string;
}

export const MODELS_EXPORT_FILENAME = "models.json";

/** Narrow structure to selected modelIds / names (case-insensitive). Empty select = unchanged. */
export function filterCmsStructure(structure: CmsStructure, select: string[]): CmsStructure {
  if (!select.length) return structure;
  const want = new Set(select.map((s) => s.toLowerCase()));
  const models = structure.models.filter((m) => {
    const o = m as { modelId?: string; name?: string };
    return want.has(String(o.modelId ?? "").toLowerCase()) || want.has(String(o.name ?? "").toLowerCase());
  });
  return { groups: structure.groups, models };
}

export function modelsExportPath(dirOrFile: string): string {
  return dirOrFile.endsWith(MODELS_EXPORT_FILENAME)
    ? dirOrFile
    : path.join(dirOrFile, MODELS_EXPORT_FILENAME);
}

export function writeModelsExport(
  outDir: string,
  structure: CmsStructure,
  meta?: { sourceTenant?: string }
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const filepath = modelsExportPath(outDir);
  const body: ModelsExportFile = {
    exportedAt: new Date().toISOString(),
    ...(meta?.sourceTenant ? { sourceTenant: meta.sourceTenant } : {}),
    groups: structure.groups,
    models: structure.models,
  };
  fs.writeFileSync(filepath, JSON.stringify(body, null, 2), "utf-8");
  return filepath;
}

/** Read `models.json` from a cms dir or file path. null if missing/invalid. */
export function readModelsExport(dirOrFile: string): ModelsExportFile | null {
  const file = modelsExportPath(dirOrFile);
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    return {
      exportedAt: typeof j["exportedAt"] === "string" ? j["exportedAt"] : "",
      sourceTenant: typeof j["sourceTenant"] === "string" ? j["sourceTenant"] : undefined,
      groups: Array.isArray(j["groups"]) ? j["groups"] : [],
      models: Array.isArray(j["models"]) ? j["models"] : [],
    };
  } catch {
    return null;
  }
}

/**
 * Split an array into chunks of at most `size`. `size < 1` yields a single chunk
 * (guards against an infinite loop). Empty input → []. Pure; unit-tested.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  if (size < 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Default models-per-importStructure call. Bulk chunks (5–10) hang or 504 on
 * this gateway; one model at a time is slower but finishes. Override via
 * STRUCTURE_CHUNK_SIZE.
 */
const DEFAULT_STRUCTURE_CHUNK = 1;

/** Fail fast when the gateway holds the connection open instead of returning 504. */
const STRUCTURE_REQUEST_TIMEOUT_MS =
  Number(process.env["STRUCTURE_TIMEOUT_MS"]) || 35_000;

// ── exportStructure (source read) ───────────────────────────────────────────────

const CMS_EXPORT_STRUCTURE_QUERY = `query CmsExportStructure($models: [String!]) {
  exportStructure(models: $models) {
    data
    error { message code data }
  }
}`;

/**
 * Fetch the source content-model structure via `exportStructure`.
 * `data` comes back as a JSON STRING of { groups, models } — it must be parsed.
 * Pass `modelIds` to filter; empty/omitted means "all models".
 */
export async function fetchSourceStructure(
  manageClient: GraphQLClient,
  modelIds?: string[]
): Promise<CmsStructure> {
  const resp = await manageClient.request<{
    exportStructure: { data: string | null; error: { message: string } | null };
  }>(
    CMS_EXPORT_STRUCTURE_QUERY,
    { models: modelIds && modelIds.length ? modelIds : [] },
    { maxAttempts: 1 }
  );

  const payload = resp.exportStructure;
  if (payload?.error) throw new Error(`exportStructure error: ${payload.error.message}`);
  if (!payload?.data) throw new Error("exportStructure returned no data");

  const parsed = (typeof payload.data === "string" ? JSON.parse(payload.data) : payload.data) as CmsStructure;
  return { groups: parsed.groups ?? [], models: parsed.models ?? [] };
}

// ── importStructure (target write) ───────────────────────────────────────────────

const STRUCTURE_IMPORT_MUTATION = `mutation StructureImport($data: CmsImportStructureInput!) {
  importStructure(data: $data) {
    data {
      groups {
        group { id name }
        imported
        action
        error { code message data }
      }
      models {
        model { modelId name group }
        imported
        related
        action
        error { code message data }
      }
      message
    }
    error { code message data }
  }
}`;

export interface StructureItemResult {
  name: string;
  action: string;
  imported: boolean;
  error?: string;
}

export interface StructureImportResult {
  groups: StructureItemResult[];
  models: StructureItemResult[];
  message?: string;
}

function modelLabel(m: unknown): string {
  const o = m as { name?: string; modelId?: string };
  return o.name ?? o.modelId ?? "(unknown)";
}

/**
 * Recreate groups + models + fields on the target via `importStructure`, batched
 * into chunks of `chunkSize` models per call (default 1, or STRUCTURE_CHUNK_SIZE).
 *
 * Each call uses a hard request timeout (STRUCTURE_TIMEOUT_MS, default 35s) so a
 * hanging gateway cannot freeze the import. Chunks larger than 1 that fail are
 * retried one model at a time. Per-model failures are recorded, not thrown — the
 * caller's `--create-missing-model` pre-flight backstops missing models.
 *
 * NOTE: `importStructure` input is the unwrapped `{ groups, models }` object —
 * unlike entry inputs, it is NOT nested under `values`.
 */
export async function importStructure(
  client: GraphQLClient,
  structure: CmsStructure,
  opts: { chunkSize?: number } = {}
): Promise<StructureImportResult> {
  const chunkSize =
    opts.chunkSize ?? (Number(process.env["STRUCTURE_CHUNK_SIZE"]) || DEFAULT_STRUCTURE_CHUNK);

  if (structure.models.length === 0) {
    return importStructureOnce(client, structure, { maxAttempts: 1 });
  }

  const batches = chunk(structure.models, chunkSize);
  logger.log(
    `   importStructure: ${structure.models.length} models in ${batches.length} chunk(s) of ${chunkSize}` +
      ` (timeout ${Math.round(STRUCTURE_REQUEST_TIMEOUT_MS / 1000)}s/call)`
  );
  const merged: StructureImportResult = { groups: [], models: [] };

  for (let i = 0; i < batches.length; i++) {
    const labels = batches[i].map(modelLabel).join(", ");
    logger.log(`   … chunk ${i + 1}/${batches.length}: ${labels}`);
    try {
      // Bulk 504/hang is size-bound — do not retry the same oversized payload.
      const res = await importStructureOnce(
        client,
        { groups: structure.groups, models: batches[i] },
        { maxAttempts: 1 }
      );
      if (merged.groups.length === 0) merged.groups = res.groups; // groups identical each chunk
      merged.models.push(...res.models);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (chunkSize <= 1) {
        logger.warn(`   ⚠  structure model failed: ${labels} — ${msg}`);
        merged.models.push({ name: labels, action: "failed", imported: false, error: msg });
        continue;
      }
      // Bulk structure import can hit gateway timeouts — retry models one at a time.
      logger.warn(`   ⚠  structure chunk ${i + 1}/${batches.length} failed: ${msg} — retrying models one-by-one`);
      for (let j = 0; j < batches[i].length; j++) {
        const m = batches[i][j];
        const label = modelLabel(m);
        logger.log(`   … model ${j + 1}/${batches[i].length}: ${label}`);
        try {
          const res = await importStructureOnce(
            client,
            { groups: structure.groups, models: [m] },
            { maxAttempts: 1 }
          );
          if (merged.groups.length === 0) merged.groups = res.groups;
          merged.models.push(...res.models);
        } catch (oneErr) {
          const oneMsg = oneErr instanceof Error ? oneErr.message : String(oneErr);
          merged.models.push({
            name: label,
            action: "failed",
            imported: false,
            error: oneMsg,
          });
        }
      }
    }
  }
  return merged;
}

/** One importStructure mutation for a (chunked) subset. */
async function importStructureOnce(
  client: GraphQLClient,
  structure: CmsStructure,
  retry: { maxAttempts: number } = { maxAttempts: 3 }
): Promise<StructureImportResult> {
  const resp = await client.request<{
    importStructure: {
      data: {
        groups: Array<{ group: { id: string; name: string } | null; imported: boolean; action: string; error: { message: string } | null }>;
        models: Array<{ model: { modelId: string; name: string; group: string } | null; imported: boolean; related: boolean; action: string; error: { message: string } | null }>;
        message: string | null;
      } | null;
      error: { message: string } | null;
    };
  }>(STRUCTURE_IMPORT_MUTATION, { data: structure }, {
    ...retry,
    timeoutMs: STRUCTURE_REQUEST_TIMEOUT_MS,
  });

  const payload = resp.importStructure;
  if (payload?.error) throw new Error(`importStructure error: ${payload.error.message}`);
  if (!payload?.data) throw new Error("importStructure returned no data");

  return {
    groups: payload.data.groups.map((g) => ({
      name: g.group?.name ?? "(unknown)",
      action: g.action,
      imported: g.imported,
      error: g.error?.message,
    })),
    models: payload.data.models.map((m) => ({
      name: m.model?.name ?? "(unknown)",
      action: m.action,
      imported: m.imported,
      error: m.error?.message,
    })),
    message: payload.data.message ?? undefined,
  };
}

// ── Async schema-regen wait ──────────────────────────────────────────────────────
// Kibo regenerates the per-model GraphQL schema asynchronously after a model is
// created, so the generated create<Model> mutations may not exist for a few seconds
// after importStructure returns. Poll until they appear before importing entries.

/**
 * Wait until every `createOp` is present in the target schema (or the deadline
 * elapses). Returns the create ops that never showed up.
 */
export async function waitForModelMutations(
  client: GraphQLClient,
  createOps: string[],
  opts: { deadlineMs?: number; onTick?: (waitedMs: number, remaining: string[]) => void } = {}
): Promise<string[]> {
  const wanted = [...new Set(createOps)];
  if (wanted.length === 0) return [];

  const deadline = opts.deadlineMs ?? 60_000;
  let waited = 0;
  let delay = 2000;

  while (true) {
    const available = new Set(await typeFieldNames(client));
    const remaining = wanted.filter((op) => !available.has(op));
    if (remaining.length === 0) return [];
    if (waited >= deadline) return remaining;
    opts.onTick?.(waited, remaining);
    await sleep(delay);
    waited += delay;
    delay = Math.min(delay * 1.5, 8000);
  }
}
