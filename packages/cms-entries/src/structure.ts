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
 * The structure is pulled live from the source and applied to the target at import
 * time (no on-disk bundle) — the import already requires source connectivity.
 * The `{ groups, models }` envelope is identical to the JSON the Kibo admin UI
 * produces under Content Models → ⋮ → Export.
 */

import { GraphQLClient, typeFieldNames, sleep } from "@kibo-cms-clone-tool/shared";

export interface CmsStructure {
  groups: unknown[];
  models: unknown[];
}

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

/**
 * Recreate groups + models + fields on the target via `importStructure`.
 * Throws on a top-level failure (or null data); per-group/per-model errors are
 * collected and returned so the caller can report them without aborting.
 *
 * NOTE: `importStructure` input is the unwrapped `{ groups, models }` object —
 * unlike entry inputs, it is NOT nested under `values`.
 */
export async function importStructure(
  client: GraphQLClient,
  structure: CmsStructure
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
  }>(STRUCTURE_IMPORT_MUTATION, { data: structure });

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
