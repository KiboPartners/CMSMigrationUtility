/**
 * Export step: stream all entries from source, writing a `<Model>.entries.ndjson`
 * sidecar (one flat entry object per line) plus a `<Model>.json` metadata file
 * (schema, folders, count — no entries) per model. Entries are never held fully
 * in memory: each fetched page is written straight to the ndjson stream.
 *
 * Assumes Kibo CMS 6.x: content fields are always under `values { … }` in list
 * responses.  Streamed entries flatten them to the top level so the import
 * step can send them directly as `$data` without knowing the wrapper.
 *
 * Metadata file format (`<Model>.json`):
 * {
 *   "modelId": "promoBanner",
 *   "modelName": "PromoBanner",
 *   "locale": "en-US",
 *   "exportedAt": "2024-01-01T00:00:00Z",
 *   "schema": { …ModelDefinition fields… },
 *   "folderType": "promoBanner",
 *   "folders": [ …FolderNode tree… ],
 *   "count": 42
 * }
 *
 * Entries live in the sibling `<Model>.entries.ndjson` — one JSON object per line.
 */

import fs from "fs";
import path from "path";
import {
  GraphQLClient,
  logger,
  FolderNode,
  createNdjsonWriter,
  buildWhereForArtifact,
  formatFilterPlanLog,
  matchCatalogItem,
  filterFoldersForIds,
  type FrozenFilterSpec,
  type CatalogItem,
} from "@kibo-cms-clone-tool/shared";
import {
  ModelDefinition,
  FieldDefinition,
  buildListQuery,
  parseSkippableField,
  seedMultiValueFileSkips,
  seedAllFileFieldSkips,
  isMultiValueFileSerializeError,
} from "./introspect";
import { introspectedFieldLines, entryAcoLocationLine, entryDisplayLines } from "./entry-selection";
import { fetchEntryFolders, entryFolderId } from "./folders";
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
 * Paginate all entries for a model from source, streaming each flattened
 * entry to `onEntry` as soon as it's fetched instead of accumulating them.
 *
 * Kibo CMS 6.x: content fields live under `values { … }`.  After fetching,
 * each entry's `values` sub-object is hoisted to the root so the streamed
 * object is a plain flat object (id, entryId, title, slug, siteId, …).
 */
async function streamAllEntries(
  client: GraphQLClient,
  model: ModelDefinition,
  siteIdFilter: string | null,
  filterSpec: FrozenFilterSpec | null,
  onEntry: (entry: Record<string, unknown>) => void,
  selection: Set<string> | null = null
): Promise<number> {
  // Kibo CMS 6.x where-input nests content fields under the wrapper name:
  // where: { values: { siteId: "..." } }
  const hasSiteIdField = model.fields.some((f) => f.fieldId === "siteId");

  let whereFilter: Record<string, unknown> | undefined;
  let residualKeys: Set<string> | undefined;

  if (filterSpec) {
    const plan = buildWhereForArtifact("cms-entry", filterSpec, undefined, {
      modelFields: model.fields.map((f) => ({
        fieldId: f.fieldId,
        type: f.type,
        settings: f.settings,
      })),
      hasSiteId: hasSiteIdField,
    });
    logger.log(formatFilterPlanLog(plan));
    for (const w of plan.warnings) logger.warn(`  ⚠  ${w}`);
    whereFilter = plan.where ?? undefined;
    residualKeys = new Set(plan.residual.map((c) => c.key));
  } else if (siteIdFilter && hasSiteIdField) {
    whereFilter = { values: { siteId: siteIdFilter } };
  }

  // Client-side fallback: siteId when model lacks the field, or residual clauses
  const clientSideSiteId = !!(siteIdFilter && !hasSiteIdField && !filterSpec);

  // Fields dropped from the selection because the source has corrupt stored
  // values that crash Kibo CMS's server-side deserialization (see parseCorruptField).
  const skipFields = new Set<string>();
  // Precise selection from the live schema; null → heuristic fallback.
  const fieldLines = await introspectedFieldLines(client, model).catch(() => null);
  const seededFiles = seedMultiValueFileSkips(model, skipFields);
  if (seededFiles.length) {
    logger.warn(
      `\n  ⚠  Omitting multi-value file field(s) on ${model.name}: ${seededFiles.join(", ")}`
    );
  }
  // Display columns (meta.status/version/title, dates, folder) mirror catalog.ts
  // so exported entries carry the same meta.status that sourceIsPublished() reads —
  // without it, publish-after-upsert always skips (entry looks unpublished).
  const displayLines = await entryDisplayLines(client, model.listOperation).catch((): string[] => []);
  const acoLine = await entryAcoLocationLine(client, model.listOperation).catch(() => null);
  const extraRootLines =
    acoLine && !displayLines.includes(acoLine) ? [...displayLines, acoLine] : displayLines;
  let cursor: string | null = null;
  let hasMore = true;
  let firstPage = true;
  let count = 0;
  let listed = 0;

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
      if (isMultiValueFileSerializeError(err)) {
        let more = seedMultiValueFileSkips(model, skipFields);
        if (!more.length) more = seedAllFileFieldSkips(model, skipFields);
        if (more.length) {
          logger.warn(
            `\n  ⚠  String/list file mismatch on ${model.name} — omitting ${more.join(", ")}`
          );
          continue;
        }
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

    for (const entry of result.data ?? []) {
      // Hoist values.* to root so the streamed entry matches $data input shape
      const values = (entry["values"] ?? {}) as Record<string, unknown>;
      const { values: _v, ...rest } = entry;
      const flat = { ...rest, ...values };
      listed++;
      if (clientSideSiteId && flat["siteId"] !== siteIdFilter) continue;
      if (filterSpec && residualKeys?.size) {
        const pseudo: CatalogItem = {
          type: "cms-entry",
          id: String(flat["entryId"] ?? flat["id"] ?? ""),
          label: String(flat["title"] ?? flat["name"] ?? flat["entryId"] ?? ""),
          metadata: {
            siteId: flat["siteId"],
            status: (flat["meta"] as { status?: string } | undefined)?.status ?? flat["status"],
            createdOn: flat["createdOn"],
            modifiedOn: flat["savedOn"] ?? flat["modifiedOn"],
          },
        };
        if (!matchCatalogItem(pseudo, filterSpec, { residualKeys })) continue;
      }
      if (selection) {
        const eid = String(flat["entryId"] ?? flat["id"] ?? "");
        if (!eid || !selection.has(eid)) continue;
      }
      onEntry(flat);
      count++;
    }

    cursor = result.meta.cursor ?? null;
    hasMore = result.meta.hasMoreItems ?? false;
  }

  if (selection) {
    logger.write(` — ${count} matched --select of ${listed} listed`);
  }

  return count;
}

/**
 * Export all entries for a model: entries stream to a `<Model>.entries.ndjson`
 * sidecar as they're fetched (never accumulated in memory), and a
 * `<Model>.json` metadata file (schema, folders, count — no entries) is
 * written alongside it. Returns the number of entries written.
 */
export async function exportModel(
  client: GraphQLClient,
  model: ModelDefinition,
  config: ExportConfig,
  adminClient?: GraphQLClient,
  selection: Set<string> | null = null
): Promise<number> {
  fs.mkdirSync(config.outDir, { recursive: true });
  const ndjsonPath = path.join(config.outDir, `${model.name}.entries.ndjson`);
  const writer = createNdjsonWriter(ndjsonPath);
  const folderIds = new Set<string>();

  let count: number;
  try {
    count = await streamAllEntries(
      client,
      model,
      config.siteIdFilter,
      config.filterSpec,
      (e) => {
        const fid = entryFolderId(e);
        if (fid) folderIds.add(fid);
        writer.write(e);
      },
      selection
    );
  } finally {
    await writer.close();
  }

  // With --select, skip empty models so the export folder only holds implicated ones.
  if (selection && count === 0) {
    try { fs.unlinkSync(ndjsonPath); } catch { /* ignore */ }
    return 0;
  }

  // Folder tree lives on the Admin endpoint (aco), keyed by modelId. Best-effort:
  // if the Admin client is absent or aco is unavailable, export entries flat.
  let folders: FolderNode[] = [];
  if (adminClient) {
    const all = await fetchEntryFolders(adminClient, model.modelId).catch(() => []);
    folders = selection ? filterFoldersForIds(all, folderIds) : all;
    if (selection) {
      logger.log(`  Folders kept for selection (${model.name}): ${folders.length}/${all.length}`);
    }
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

  // Metadata sidecar — NO entries. Import reads this, then streams the ndjson.
  const meta = {
    modelId: model.modelId,
    modelName: model.name,
    locale: config.locale,
    exportedAt: new Date().toISOString(),
    schema,
    folderType: model.modelId,
    folders,
    count,
  };

  fs.writeFileSync(path.join(config.outDir, `${model.name}.json`), JSON.stringify(meta, null, 2), "utf-8");

  return count;
}
