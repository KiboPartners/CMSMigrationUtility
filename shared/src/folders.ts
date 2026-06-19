/**
 * Shared folder-tree migration engine.
 *
 * Every foldered artifact (files, redirects, pages, cms-entries) follows the
 * same pattern when copied source → target:
 *
 *   1. Export the source folder tree (id / parentId / slug / name).
 *   2. sortByDepth — parents always before children.
 *   3. For each folder: match an existing target folder by `${parentId}::${slug}`,
 *      or create it under the already-remapped target parent.
 *   4. Build idMap(sourceId → targetId) so items can reference the right folder.
 *   5. validateFolderMapping — before importing items, confirm every folder an
 *      item references actually resolved to a real target folder. Surfaces the
 *      silent "fell back to root" case instead of letting items land in the
 *      wrong place.
 *
 * API specifics (which GraphQL query lists folders, which mutation creates one,
 * the folder `type` discriminator) live in a per-artifact FolderAdapter — the
 * engine itself is API-agnostic.
 */

/** A folder node, normalized across artifacts. */
export interface FolderNode {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
}

/** Per-artifact bridge to the underlying folder API. */
export interface FolderAdapter {
  /** Fetch every existing folder on the target. The engine indexes them. */
  listTargetFolders(): Promise<FolderNode[]>;
  /**
   * Create one folder under an already-mapped target parent (null = root).
   * Returns the new target folder id.
   */
  createFolder(input: { name: string; slug: string; parentId: string | null }): Promise<string>;
}

/** Minimal logger surface (shared/src/logger satisfies this). */
export interface FolderLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface FolderSyncOptions {
  /** Don't touch the target — just plan the tree. */
  dryRun?: boolean;
  /** Noun for log lines, e.g. "redirect folder", "page folder". Default "folder". */
  label?: string;
  logger?: FolderLogger;
}

export interface FolderSyncResult {
  /** sourceId → targetId. Missing entry = folder was not created (see `failed`). */
  idMap: Map<string, string>;
  created: number;
  reused: number;
  /** Folders that could not be created (API error, or parent failed). */
  failed: Array<{ folder: FolderNode; error: string }>;
}

const ROOT = "ROOT";
const lookupKey = (parentId: string | null, slug: string) => `${parentId ?? ROOT}::${slug}`;

/** Kibo CMS's literal "no folder" sentinel — an item with this folderId is at root. */
export const ROOT_FOLDER_ID = "root";
/** Normalize a folderId: null / "" / "root" all mean "intentionally at root". */
export function normalizeFolderId(v: unknown): string | null {
  return typeof v === "string" && v && v !== ROOT_FOLDER_ID ? v : null;
}

/** Sort folders root-first: a parent always precedes its children. */
export function sortByDepth(folders: FolderNode[]): FolderNode[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const depth = (f: FolderNode, seen = new Set<string>()): number => {
    if (!f.parentId || !byId.has(f.parentId) || seen.has(f.id)) return 0;
    seen.add(f.id);
    return 1 + depth(byId.get(f.parentId)!, seen);
  };
  return [...folders].sort((a, b) => depth(a) - depth(b));
}

/** Map every folder id → its full slug path (e.g. "/media/images/heroes"). */
export function buildFolderPathMap(folders: FolderNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of folders) map.set(f.id, buildFolderPath(f, folders));
  return map;
}

/** Human-readable path like /media/images/heroes (for logs). */
export function buildFolderPath(folder: FolderNode, all: FolderNode[]): string {
  const byId = new Map(all.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur: FolderNode | undefined = folder;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(cur.slug);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return "/" + parts.join("/");
}

/**
 * Reconcile the source folder tree into the target: match-or-create each
 * folder, parents before children. Resilient — a single failed folder is
 * recorded in `result.failed` (and its descendants cascade-fail) instead of
 * aborting the whole tree; validateFolderMapping then decides whether that's
 * blocking for the items being imported.
 */
export async function syncFolders(
  adapter: FolderAdapter,
  sourceFolders: FolderNode[],
  opts: FolderSyncOptions = {}
): Promise<FolderSyncResult> {
  const { dryRun = false, label = "folder", logger } = opts;
  const result: FolderSyncResult = { idMap: new Map(), created: 0, reused: 0, failed: [] };

  if (sourceFolders.length === 0) return result;

  logger?.log(`\n  Syncing ${sourceFolders.length} ${label}(s)...`);

  // Index existing target folders by parent::slug for O(1) match.
  const index = new Map<string, string>();
  if (!dryRun) {
    for (const f of await adapter.listTargetFolders()) {
      index.set(lookupKey(f.parentId, f.slug), f.id);
    }
  }

  const sorted = sortByDepth(sourceFolders);
  const failedSourceIds = new Set<string>();

  for (const folder of sorted) {
    if (dryRun) {
      result.idMap.set(folder.id, `dry-run-${folder.id}`);
      result.created++;
      logger?.log(`  [dry-run] ${label}: ${buildFolderPath(folder, sourceFolders)}`);
      continue;
    }

    // If this folder's parent failed, the child can't be placed correctly —
    // cascade-fail rather than silently re-parent it to root.
    if (folder.parentId && failedSourceIds.has(folder.parentId)) {
      failedSourceIds.add(folder.id);
      result.failed.push({ folder, error: "parent folder failed to sync" });
      continue;
    }

    const targetParentId = folder.parentId ? (result.idMap.get(folder.parentId) ?? null) : null;
    const key = lookupKey(targetParentId, folder.slug);
    const existing = index.get(key);

    if (existing) {
      result.idMap.set(folder.id, existing);
      result.reused++;
      logger?.log(`  ✓ ${label} exists: ${buildFolderPath(folder, sourceFolders)}`);
      continue;
    }

    try {
      const newId = await adapter.createFolder({
        name: folder.name,
        slug: folder.slug,
        parentId: targetParentId,
      });
      result.idMap.set(folder.id, newId);
      index.set(key, newId);
      result.created++;
      logger?.log(`  ✚ Created ${label}: ${buildFolderPath(folder, sourceFolders)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failedSourceIds.add(folder.id);
      result.failed.push({ folder, error: msg });
      logger?.warn(`  ✗ Failed ${label}: ${buildFolderPath(folder, sourceFolders)} — ${msg}`);
    }
  }

  return result;
}

// ─── Validation gate ──────────────────────────────────────────────────────────

export interface FolderValidationIssue {
  itemId: string;
  sourceFolderId: string;
  /** unmapped = folder not in the source tree at all; create-failed = sync couldn't create it. */
  reason: "unmapped" | "create-failed";
  detail?: string;
}

export interface FolderValidationReport {
  /** True when no item references a folder that failed to resolve. */
  ok: boolean;
  issues: FolderValidationIssue[];
  checkedItems: number;
  /** Items that would silently fall back to root because their folder is unresolved. */
  rootFallbackCount: number;
}

/**
 * Before importing items, verify every source folder an item references resolved
 * to a real target folder. An item whose folder didn't resolve would otherwise be
 * silently placed at root — this surfaces it so the caller can block (or warn with
 * an explicit override).
 *
 * Items with `folderId == null` are intentionally at root and never flagged.
 */
export function validateFolderMapping(
  itemFolderRefs: Array<{ itemId: string; folderId: string | null }>,
  sync: FolderSyncResult
): FolderValidationReport {
  const failedIds = new Set(sync.failed.map((f) => f.folder.id));
  const issues: FolderValidationIssue[] = [];

  for (const { itemId, folderId } of itemFolderRefs) {
    // null / "" / Kibo CMS's "root" sentinel all mean "intentionally at root".
    const fid = normalizeFolderId(folderId);
    if (!fid) continue;
    if (sync.idMap.has(fid)) continue; // resolved cleanly
    issues.push({
      itemId,
      sourceFolderId: fid,
      reason: failedIds.has(fid) ? "create-failed" : "unmapped",
      detail: failedIds.has(fid)
        ? sync.failed.find((f) => f.folder.id === fid)?.error
        : "folder id not present in the source folder tree",
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    checkedItems: itemFolderRefs.length,
    rootFallbackCount: issues.length,
  };
}

/** Format a validation report into human-readable lines for the CLI/log. */
export function formatFolderValidation(report: FolderValidationReport, label = "item"): string[] {
  if (report.ok) return [];
  const lines = [
    `⚠  ${report.issues.length} ${label}(s) reference a folder that did not sync to the target:`,
  ];
  const shown = report.issues.slice(0, 20);
  for (const i of shown) {
    lines.push(`     - ${label} ${i.itemId} → folder ${i.sourceFolderId} (${i.reason}${i.detail ? `: ${i.detail}` : ""})`);
  }
  if (report.issues.length > shown.length) {
    lines.push(`     … and ${report.issues.length - shown.length} more`);
  }
  lines.push(`   These items would fall back to the root folder. Pass --allow-folder-mismatch to import anyway.`);
  return lines;
}
