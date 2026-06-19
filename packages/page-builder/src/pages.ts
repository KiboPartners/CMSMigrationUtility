/**
 * Import step: read exported pages.json, sync categories, upsert pages into target.
 *
 * Operation names and namespace come from discoverPageBuilderOps() so the mutations
 * work regardless of which Kibo CMS version renamed or restructured them.
 *
 * PbPage is Record<string, unknown> — field access is done via safe casts so the
 * importer works even when page shape differs across Kibo CMS versions.
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
  formatFolderValidation } from "@kibo-cms-clone-tool/shared";
import { wrap, syncCategories } from "./categories";
import { discoverPageBuilderOps, PageBuilderOps } from "./ops";
import { pageFolderAdapter, normalizeFolderId, ROOT_FOLDER_ID } from "./folders";
import { ExportFile, PbPage } from "./export";
import { ImportConfig } from "./config";

export interface PageResult {
  slug: string;
  action: "created" | "updated" | "skipped" | "error";
  published: boolean;
  error?: string;
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  published: number;
  errors: Array<{ slug: string; id: string; error: string }>;
}

// ─── Dynamic query / mutation builders ───────────────────────────────────────

/**
 * Build the listPages lookup query using the where-input type discovered from the schema.
 * Only requests fields that actually exist on the page type.
 */
function buildLookupQuery(ops: PageBuilderOps, byField: "slug" | "path"): string {
  const whereType = ops.listPagesWhereType ?? "PbListPagesWhereInput";
  // Request the full page selection set so we can both identify the existing
  // page AND fingerprint its content for the skip-identical comparison.
  const dataFields = ops.pageSelection;

  const inner = `
    ${ops.listPages}(where: $where, limit: 1) {
      data { ${dataFields} }
      error { message }
    }`;
  return `query LookupPage($where: ${whereType}) { ${wrap(ops.namespace, inner)} }`;
}

function buildCreatePageMutation(ops: PageBuilderOps): string {
  const inputType = ops.createPageInputType ?? "PbCreatePageInput";
  const inner = `
    ${ops.createPage!}(data: $data) {
      data { id }
      error { message }
    }`;
  return `mutation CreatePage($data: ${inputType}!) { ${wrap(ops.mutNamespace, inner)} }`;
}

function buildUpdatePageMutation(ops: PageBuilderOps): string {
  const inputType = ops.updatePageInputType ?? "PbUpdatePageInput";
  const inner = `
    ${ops.updatePage!}(id: $id, data: $data) {
      data { id }
      error { message }
    }`;
  return `mutation UpdatePage($id: ID!, $data: ${inputType}!) { ${wrap(ops.mutNamespace, inner)} }`;
}

function buildPublishPageMutation(ops: PageBuilderOps): string {
  const inner = `
    ${ops.publishPage!}(id: $id) {
      data { id status }
      error { message }
    }`;
  return `mutation PublishPage($id: ID!) { ${wrap(ops.mutNamespace, inner)} }`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a mutation input object from a source page by keeping only fields that
 * exist in the target input type (discovered from schema introspection).
 * Skips null/undefined values and system-generated fields (id, createdOn, etc.).
 */
const SKIP_ON_WRITE = new Set([
  "id", "entryId", "createdOn", "modifiedOn", "savedOn", "deletedOn",
  "restoredOn", "locked", "version", "status",
]);

function buildInputData(page: PbPage, allowedFields: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (SKIP_ON_WRITE.has(key)) continue;
    const val = page[key];
    if (val === undefined || val === null) continue;
    out[key] = val;
  }
  return out;
}

/** Safely extract a string field from a PbPage (Record<string, unknown>). */
function str(page: PbPage, key: string): string {
  const v = page[key];
  return typeof v === "string" ? v : "";
}

/** Safely extract a nested slug from page.category (or similar objects). */
function categorySlug(page: PbPage): string {
  const cat = page["category"];
  if (!cat) return "static"; // Kibo CMS default category
  if (typeof cat === "string") return cat;
  if (typeof cat === "object" && cat !== null && "slug" in cat) {
    return (cat as Record<string, unknown>)["slug"] as string ?? "static";
  }
  return "static";
}

type LookupPageResult = {
  data: PbPage[];
  error: { message: string } | null;
};

/**
 * Try to find an existing page on the target by path or slug (whichever the type supports).
 * Returns the full target page object if found (so the caller can fingerprint it
 * for the skip-identical comparison), or null otherwise.
 */
async function findExistingPage(
  client: GraphQLClient,
  ops: PageBuilderOps,
  page: PbPage
): Promise<PbPage | null> {
  // Choose which field and value to look up by
  let byField: "slug" | "path" | null = null;
  let byValue: string | null = null;

  if (ops.pageKeyFields.hasPath) {
    const v = str(page, "path");
    if (v) { byField = "path"; byValue = v; }
  }
  if (!byField && ops.pageKeyFields.hasSlug) {
    const v = str(page, "slug");
    if (v) { byField = "slug"; byValue = v; }
  }

  if (!byField || !byValue) return null; // no usable identifier

  try {
    type Resp = Record<string, unknown>;
    const resp = await client.request<Resp>(
      buildLookupQuery(ops, byField),
      { where: { [byField]: byValue } }
    );
    const nsResp = ops.namespace ? (resp[ops.namespace] as Record<string, unknown>) : resp;
    const result = nsResp[ops.listPages] as LookupPageResult | undefined;
    if (!result || result.error || !result.data.length) return null;
    const match = result.data.find((p) => str(p, byField!) === byValue);
    return match ?? null;
  } catch {
    return null; // lookup failure is non-fatal — we'll just create
  }
}

// ─── Content fingerprint (skip-identical) ─────────────────────────────────────

/**
 * Page-level system / metadata fields that must NOT influence the content
 * fingerprint — otherwise every page looks "changed" on re-import.
 */
const FINGERPRINT_IGNORE_FIELDS = new Set<string>([
  "id",
  "pid",
  "entryId",
  "createdOn",
  "modifiedOn",
  "savedOn",
  "deletedOn",
  "restoredOn",
  "publishedOn",
  "createdBy",
  "ownedBy",
  "status",
  "version",
  "locked",
  "location",
  "wbyAco_location",
]);

/**
 * The page fields that carry real content/settings and are compared for the
 * skip-identical decision. Title/path/slug live under these or at the root and
 * are picked up by the generic walk below.
 */
const FINGERPRINT_PAGE_FIELDS = ["title", "path", "slug", "content", "settings", "properties", "category"];

/**
 * Produce a stable, order-independent JSON string of a page's comparable fields,
 * dropping system/metadata fields. Object keys are sorted recursively so two
 * semantically-identical payloads with different key order compare equal.
 *
 * Exported for unit testing of the normalization rules.
 */
export function normalizePageContent(page: PbPage): string {
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

  const picked: Record<string, unknown> = {};
  for (const key of FINGERPRINT_PAGE_FIELDS) {
    if (FINGERPRINT_IGNORE_FIELDS.has(key)) continue;
    if (page[key] !== undefined && page[key] !== null) picked[key] = page[key];
  }
  return JSON.stringify(stable(picked));
}

/**
 * Compute the comparable fingerprint for the SOURCE side of a page upsert.
 * The source's content/settings are CDN-rewritten first so a CDN-only domain
 * difference does not register as a content change.
 */
export function fingerprintSourcePage(
  page: PbPage,
  sourceCdnDomain: string | null,
  targetCdnDomain: string | null
): string {
  const rewritten: PbPage = { ...page };
  if (rewritten["content"] !== undefined) {
    rewritten["content"] = rewriteCdnUrls(page["content"], sourceCdnDomain, targetCdnDomain);
  }
  if (rewritten["settings"] !== undefined) {
    rewritten["settings"] = rewriteCdnUrls(page["settings"], sourceCdnDomain, targetCdnDomain);
  }
  return normalizePageContent(rewritten);
}

// ─── Upsert single page ───────────────────────────────────────────────────────

/**
 * Remap a page's ACO folder reference to the target folder tree before create.
 * Source folderId is invalid on target — translate via the synced idMap, falling
 * back to root for unmapped folders (validation has already gated this case).
 */
function remapPageLocation(
  page: PbPage,
  createData: Record<string, unknown>,
  folderIdMap: Map<string, string>
): void {
  if (!("location" in createData)) return;
  const loc = page["location"] as { folderId?: unknown } | undefined;
  const srcId = normalizeFolderId(loc?.folderId);
  const targetId = srcId ? folderIdMap.get(srcId) : null;
  createData["location"] = { folderId: targetId ?? ROOT_FOLDER_ID };
}

async function upsertPage(
  client: GraphQLClient,
  ops: PageBuilderOps,
  page: PbPage,
  config: ImportConfig,
  folderIdMap: Map<string, string>
): Promise<PageResult> {
  // Use path > slug > id as the human-readable identifier for logging
  const pageId = str(page, "path") || str(page, "slug") || str(page, "id");

  if (config.dryRun) {
    return { slug: pageId, action: "skipped", published: false };
  }

  if (!ops.createPage || !ops.updatePage) {
    return { slug: pageId, action: "error", published: false, error: "createPage/updatePage not available on target" };
  }

  const content  = rewriteCdnUrls(page["content"],  config.sourceCdnDomain, config.targetCdnDomain);
  const settings = rewriteCdnUrls(page["settings"], config.sourceCdnDomain, config.targetCdnDomain);

  let targetId: string;
  let action: "created" | "updated" = "created";

  const existing = await findExistingPage(client, ops, page);

  if (existing) {
    // Skip-identical: compare a normalized content fingerprint (CDN-rewritten)
    // of source vs the existing target page. If identical, skip without
    // updating or publishing.
    const sourceFp = fingerprintSourcePage(page, config.sourceCdnDomain, config.targetCdnDomain);
    const targetFp = normalizePageContent(existing);
    if (sourceFp === targetFp) {
      return { slug: pageId, action: "skipped", published: false };
    }
    targetId = str(existing, "id");
    action = "updated";
  } else {
    type CreateResult = { data: { id: string } | null; error: { message: string } | null };

    // Build create payload — only include fields that WbPageCreateInput actually accepts
    const createData = buildInputData(page, ops.createPageInputFields);
    // Translate the source ACO folder id → the target folder tree.
    remapPageLocation(page, createData, folderIdMap);

    const resp = await client.request<Record<string, unknown>>(
      buildCreatePageMutation(ops),
      { data: createData }
    );

    const nsResp = ops.mutNamespace ? (resp[ops.mutNamespace] as Record<string, unknown>) : resp;
    const result = nsResp[ops.createPage] as CreateResult | undefined;

    if (result?.error || !result?.data) {
      return {
        slug: pageId,
        action: "error",
        published: false,
        error: result?.error?.message ?? "createPage returned no data",
      };
    }
    targetId = result.data.id;
  }

  // Build update payload — only include fields that WbPageUpdateInput actually accepts
  // Start with all page fields filtered to what the input type accepts, then overlay CDN-rewritten content/settings
  const updateBase = buildInputData(page, ops.updatePageInputFields);
  if (content  !== undefined && ops.updatePageInputFields.has("content"))  updateBase["content"]  = content;
  if (settings !== undefined && ops.updatePageInputFields.has("settings")) updateBase["settings"] = settings;
  const updateData = updateBase;

  type UpdateResult = { data: { id: string } | null; error: { message: string } | null };

  const updateResp = await client.request<Record<string, unknown>>(
    buildUpdatePageMutation(ops),
    { id: targetId, data: updateData }
  );

  const nsUpdateResp = ops.mutNamespace
    ? (updateResp[ops.mutNamespace] as Record<string, unknown>)
    : updateResp;
  const updateResult = nsUpdateResp[ops.updatePage] as UpdateResult | undefined;

  if (updateResult?.error || !updateResult?.data) {
    return {
      slug: pageId,
      action: "error",
      published: false,
      error: updateResult?.error?.message ?? "updatePage returned no data",
    };
  }

  const updatedId = updateResult.data.id;

  // Publish if originally published and publishPage op is available
  let published = false;
  if (page["status"] === "published" && ops.publishPage) {
    type PublishResp = Record<string, unknown>;
    type PublishResult = {
      data: { id: string; status: string } | null;
      error: { message: string } | null;
    };

    const publishResp = await client.request<PublishResp>(
      buildPublishPageMutation(ops),
      { id: updatedId }
    );

    const nsPublishResp = ops.mutNamespace
      ? (publishResp[ops.mutNamespace] as Record<string, unknown>)
      : publishResp;
    const publishResult = nsPublishResp[ops.publishPage] as PublishResult | undefined;

    if (publishResult?.error) {
      logger.warn(`  ⚠  Publish failed for "${pageId}": ${publishResult.error.message}`);
    } else {
      published = true;
    }
  }

  return { slug: pageId, action, published };
}

// ─── Read export file ─────────────────────────────────────────────────────────

export function readExportFile(dir: string): ExportFile {
  const filePath = path.join(dir, "pages.json");
  if (!fs.existsSync(filePath)) throw new Error(`Export file not found: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ExportFile;
}

// ─── Main import orchestrator ─────────────────────────────────────────────────

export async function importPages(
  targetClient: GraphQLClient,
  exportFile: ExportFile,
  config: ImportConfig
): Promise<ImportResult> {
  logger.log("  Discovering Page Builder operations on target...");
  const ops = await discoverPageBuilderOps(targetClient);

  await syncCategories(targetClient, ops, exportFile.categories, config.dryRun);

  // Sync the ACO page-folder tree, then remap each page's location.folderId.
  const sync = await syncFolders(
    pageFolderAdapter(targetClient, exportFile.pageFolderType ?? "WbPage"),
    exportFile.folders ?? [],
    { dryRun: config.dryRun, label: "page folder", logger }
  );
  const folderIdMap = sync.idMap;

  const { pages } = exportFile;

  // Validate folder mapping before writing — blocks unless --allow-folder-mismatch.
  if (!config.dryRun) {
    const refs = pages.map((p) => ({
      itemId: str(p, "path") || str(p, "slug") || str(p, "id"),
      folderId: normalizeFolderId((p["location"] as { folderId?: unknown } | undefined)?.folderId),
    }));
    const report = validateFolderMapping(refs, sync);
    if (!report.ok) {
      formatFolderValidation(report, "page").forEach((l) => logger.warn(`  ${l}`));
      if (!config.allowFolderMismatch) {
        throw new Error(
          `Folder validation failed: ${report.issues.length} page(s) reference folders ` +
            `that did not sync to the target. Pass --allow-folder-mismatch to import anyway.`
        );
      }
    }
  }

  logger.log(`\n📄 Importing ${pages.length} pages...`);

  const result: ImportResult = {
    total: pages.length,
    created: 0,
    updated: 0,
    skipped: 0,
    published: 0,
    errors: [],
  };

  if (pages.length === 0) return result;

  const bar = createProgressBar("pages", pages.length);
  const limit = pLimit(config.concurrency);
  let processed = 0;

  const tasks = pages.map((page) =>
    limit(async () => {
      const r = await upsertPage(targetClient, ops, page, config, folderIdMap);

      if (r.action === "created") result.created++;
      else if (r.action === "updated") result.updated++;
      else if (r.action === "skipped") result.skipped++;
      if (r.published) result.published++;
      if (r.action === "error") {
        const id = str(page, "id") || str(page, "pid") || "unknown";
        result.errors.push({ slug: r.slug, id, error: r.error ?? "unknown" });
      }

      processed++;
      updateProgress(bar, processed);
    })
  );

  await Promise.all(tasks);
  stopProgress(bar);

  return result;
}
