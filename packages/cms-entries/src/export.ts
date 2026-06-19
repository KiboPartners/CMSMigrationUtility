/**
 * Export step: paginate all entries from source, write one JSON file per model.
 *
 * Assumes Kibo CMS 6.x: content fields are always under `values { … }` in list
 * responses.  The exported JSON flattens them to the top level so the import
 * step can send them directly as `$data` without knowing the wrapper.
 *
 * Output format per file:
 * {
 *   "modelId": "promoBanner",
 *   "modelName": "PromoBanner",
 *   "locale": "en-US",
 *   "exportedAt": "2024-01-01T00:00:00Z",
 *   "schema": { …ModelDefinition fields… },
 *   "entries": [ …flat entry objects… ]
 * }
 */

import fs from "fs";
import path from "path";
import { GraphQLClient, logger, FolderNode } from "@kibo-cms-clone-tool/shared";
import { ModelDefinition, FieldDefinition, buildListQuery, parseSkippableField } from "./introspect";
import { introspectedFieldLines, entryAcoLocationLine } from "./entry-selection";
import { fetchEntryFolders } from "./folders";
import { ExportConfig } from "./config";

/**
 * Serialisable snapshot of a ModelDefinition saved alongside the entries.
 * The import step reconstructs the ModelDefinition from this without needing
 * to introspect the target.
 */
export interface SavedModelSchema {
  modelId: string;
  name: string;
  pluralApiName: string;
  fields: FieldDefinition[];
  listOperation: string;
  createOperation: string;
  updateOperation: string;
  publishOperation: string;
  deleteOperation: string;
  whereInputType: string;
}

export interface ExportFile {
  modelId: string;
  modelName: string;
  locale: string;
  exportedAt: string;
  /**
   * Model schema captured at export time.
   * Import reuses these field definitions and operation names directly —
   * no target introspection required.
   */
  schema: SavedModelSchema;
  /** ACO folder `type` used for this model's folders (equals modelId), or null. */
  folderType?: string | null;
  /** Source ACO folder tree for this model — synced to target so entries keep their folder. */
  folders?: FolderNode[];
  entries: Record<string, unknown>[];
}

/**
 * Paginate all entries for a model from source.
 *
 * Kibo CMS 6.x: content fields live under `values { … }`.  After fetching,
 * each entry's `values` sub-object is hoisted to the root so the export JSON
 * is a plain flat object (id, entryId, title, slug, siteId, …).
 */
async function fetchAllEntries(
  client: GraphQLClient,
  model: ModelDefinition,
  siteIdFilter: string | null
): Promise<Record<string, unknown>[]> {
  // Kibo CMS 6.x where-input nests content fields under the wrapper name:
  // where: { values: { siteId: "..." } }
  const hasSiteIdField = model.fields.some((f) => f.fieldId === "siteId");
  const whereFilter: Record<string, unknown> | undefined =
    siteIdFilter && hasSiteIdField
      ? { values: { siteId: siteIdFilter } }
      : undefined;

  // Client-side fallback flag: model has no siteId field but filter was requested
  const clientSideFilter = !!(siteIdFilter && !hasSiteIdField);

  const entries: Record<string, unknown>[] = [];
  // Fields dropped from the selection because the source has corrupt stored
  // values that crash Kibo CMS's server-side deserialization (see parseCorruptField).
  const skipFields = new Set<string>();
  // Precise selection from the live schema; null → heuristic fallback.
  const fieldLines = await introspectedFieldLines(client, model).catch(() => null);
  // Entry-level ACO folder line (omitted when the entry type has no such field).
  const acoLine = await entryAcoLocationLine(client, model.listOperation).catch(() => null);
  const extraRootLines = acoLine ? [acoLine] : [];
  let cursor: string | null = null;
  let hasMore = true;
  let firstPage = true;

  type ListResponse = {
    [key: string]: {
      data: Record<string, unknown>[];
      meta: { cursor: string | null; hasMoreItems: boolean; totalCount: number };
      error: { message: string } | null;
    };
  };

  while (hasMore) {
    // Rebuild query each page — $after is only included when paginating so the
    // first-page query matches the minimal shape that Kibo CMS 6.x expects.
    const query = buildListQuery(model, whereFilter, cursor ?? undefined, skipFields, fieldLines ?? undefined, extraRootLines);

    const variables: Record<string, unknown> = {};
    if (cursor) variables.after = cursor;
    if (whereFilter) variables.where = whereFilter;

    let resp: ListResponse;
    try {
      resp = await client.request<ListResponse>(query, variables);
    } catch (err) {
      // A field that's corrupt (Kibo CMS fromStorage) or has the wrong selection
      // shape fails the whole page query. Drop that field and refetch the same
      // page (cursor unchanged). Only drop genuine model fields, so an operation
      // -name error isn't misread. skipFields grows monotonically → terminates.
      const bad = parseSkippableField(err);
      if (bad && !skipFields.has(bad) && model.fields.some((f) => f.fieldId === bad)) {
        skipFields.add(bad);
        logger.warn(`\n  ⚠  Field "${bad}" on ${model.name} is unselectable/corrupt — excluding it and continuing.`);
        continue;
      }
      throw err;
    }
    const result = resp[model.listOperation];

    if (!result) throw new Error(`Unexpected response for ${model.listOperation}`);
    if (result.error) throw new Error(`Error fetching ${model.name}: ${result.error.message}`);

    if (firstPage) {
      logger.write(` (${result.meta.totalCount} total)`);
      firstPage = false;
    }

    let batch = (result.data ?? []).map((entry) => {
      // Hoist values.* to root so the flat export matches $data input shape
      const values = (entry["values"] ?? {}) as Record<string, unknown>;
      const { values: _v, ...rest } = entry;
      return { ...rest, ...values };
    });

    if (clientSideFilter) {
      batch = batch.filter((e) => e["siteId"] === siteIdFilter);
    }

    entries.push(...batch);
    cursor = result.meta.cursor ?? null;
    hasMore = result.meta.hasMoreItems ?? false;
  }

  return entries;
}

/**
 * Export all entries for a model to a JSON file.
 * Returns the number of entries written.
 */
export async function exportModel(
  client: GraphQLClient,
  model: ModelDefinition,
  config: ExportConfig,
  adminClient?: GraphQLClient
): Promise<number> {
  const entries = await fetchAllEntries(client, model, config.siteIdFilter);

  // Folder tree lives on the Admin endpoint (aco), keyed by modelId. Best-effort:
  // if the Admin client is absent or aco is unavailable, export entries flat.
  let folders: FolderNode[] = [];
  if (adminClient) {
    folders = await fetchEntryFolders(adminClient, model.modelId).catch(() => []);
  }

  const schema: SavedModelSchema = {
    modelId: model.modelId,
    name: model.name,
    pluralApiName: model.pluralApiName,
    fields: model.fields,
    listOperation: model.listOperation,
    createOperation: model.createOperation,
    updateOperation: model.updateOperation,
    publishOperation: model.publishOperation,
    deleteOperation: model.deleteOperation,
    whereInputType: model.whereInputType,
  };

  const payload: ExportFile = {
    modelId: model.modelId,
    modelName: model.name,
    locale: config.locale,
    exportedAt: new Date().toISOString(),
    schema,
    folderType: model.modelId,
    folders,
    entries,
  };

  fs.mkdirSync(config.outDir, { recursive: true });
  const filePath = path.join(config.outDir, `${model.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");

  return entries.length;
}
