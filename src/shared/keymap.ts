/**
 * Central, persistent file key-remap store.
 *
 * When a migrated file lands at a NEW S3 key on the target, the source CDN URL
 * embedded in Content entries/pages no longer resolves after a domain-only swap.
 * This store records `sourceUrl → targetUrl` remaps tagged by source+target
 * tenant, so any later import/migrate (independent of the export folder) can
 * fix references for the correct tenant pair. Modeled on the .runs/ ledger.
 */

import fs from "fs";
import path from "path";
import { findRepoRoot } from "./config";
import { loadKeyMap } from "./utils";

export interface KeyRemapRecord {
  sourceTenant: string;
  targetTenant: string;
  fileId: string;
  sourceUrl: string;
  targetUrl: string;
  /** The minted target S3 key. Absent on records written before this field existed. */
  targetKey?: string;
  updatedAt: string | null;
}

export function recordKey(r: { sourceTenant: string; targetTenant: string; fileId: string }): string {
  return `${r.sourceTenant}::${r.targetTenant}::${r.fileId}`;
}

export function upsertRecords(existing: KeyRemapRecord[], incoming: KeyRemapRecord[]): KeyRemapRecord[] {
  const byKey = new Map<string, KeyRemapRecord>();
  for (const r of existing) byKey.set(recordKey(r), r);
  for (const r of incoming) byKey.set(recordKey(r), r); // upsert
  return [...byKey.values()];
}

export function selectUrlMap(
  records: KeyRemapRecord[],
  sourceTenant: string,
  targetTenant: string
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of records) {
    if (r.sourceTenant !== sourceTenant || r.targetTenant !== targetTenant) continue;
    if (!r.sourceUrl || !r.targetUrl) continue;
    map[r.sourceUrl] = r.targetUrl;
  }
  return map;
}

/**
 * Per-file remaps for a tenant pair, keyed by fileId — used by file-manager
 * import as an idempotency cache: a file already migrated in a prior run (and
 * still present on the target) is skipped instead of re-uploaded under a new
 * minted key. Only records carrying a targetKey qualify (older records without
 * one fall through to a normal upload, then get re-recorded with the key).
 */
export function selectFileRemaps(
  records: KeyRemapRecord[],
  sourceTenant: string,
  targetTenant: string
): Map<string, { targetUrl: string; targetKey: string }> {
  const map = new Map<string, { targetUrl: string; targetKey: string }>();
  for (const r of records) {
    if (r.sourceTenant !== sourceTenant || r.targetTenant !== targetTenant) continue;
    if (!r.fileId || !r.targetKey || !r.targetUrl) continue;
    map.set(r.fileId, { targetUrl: r.targetUrl, targetKey: r.targetKey });
  }
  return map;
}

export function defaultKeymapDir(): string {
  return path.join(findRepoRoot() ?? process.cwd(), ".keymap");
}

function storeFile(dir: string): string {
  return path.join(dir, "store.json");
}

export function loadStore(dir: string): KeyRemapRecord[] {
  const f = storeFile(dir);
  if (!fs.existsSync(f)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
    return Array.isArray(parsed) ? (parsed as KeyRemapRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveStore(dir: string, records: KeyRemapRecord[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const f = storeFile(dir);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), "utf-8");
  fs.renameSync(tmp, f);
}

export function recordRemaps(dir: string, incoming: KeyRemapRecord[]): void {
  if (incoming.length === 0) return;
  const stamped = incoming.map((r) => ({ ...r, updatedAt: new Date().toISOString() }));
  saveStore(dir, upsertRecords(loadStore(dir), stamped));
}

export function resolveImportKeyMap(opts: {
  keymapDir: string;
  sourceTenant: string;
  targetTenant: string;
  explicitFile?: string;
}): Record<string, string> {
  const fromStore = selectUrlMap(loadStore(opts.keymapDir), opts.sourceTenant, opts.targetTenant);
  const fromFile = loadKeyMap(opts.explicitFile);
  return { ...fromStore, ...fromFile }; // explicit file wins on collisions
}
