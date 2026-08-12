/**
 * Configuration for cms-entries cloner.
 * Two shapes: ExportConfig (source → disk) and ImportConfig (disk → target).
 *
 * Values come from the consolidated repo-root .env via @kibo-cms-clone-tool/shared.
 * This module is a thin adapter that maps them onto the shapes this package uses.
 */

import {
  loadRootEnv,
  resolveEnvironment,
  getRateLimitDelay,
  getDebug,
  defaultKeymapDir,
  type FrozenFilterSpec,
} from "@kibo-cms-clone-tool/shared";

loadRootEnv();

export interface ExportConfig {
  sourceAdminGqlUrl: string;   // Admin API — used for listContentModels
  sourceManageUrl: string;     // Manage API — used for entry CRUD
  sourceApiKey: string;
  sourceTenant: string;
  locale: string;
  models: string[];            // ['ALL'] or specific names
  siteIdFilter: string | null;
  /** Frozen advanced filter (dates/name/siteId); null = none. */
  filterSpec: FrozenFilterSpec | null;
  outDir: string;
  rateLimitDelay: number;      // ms to sleep between requests (0 = disabled)
  debug: boolean;
}

export interface ImportConfig {
  targetAdminGqlUrl: string;   // Admin API — used for listContentModels
  targetManageUrl: string;     // Manage API — used for entry CRUD
  targetApiKey: string;
  targetTenant: string;
  locale: string;
  concurrency: number;
  dryRun: boolean;
  sourceCdnDomain: string | null;
  targetCdnDomain: string | null;
  dir: string;
  allowFolderMismatch: boolean;
  /** Full-URL source→target remap for files whose S3 key changed (from file-manager import). */
  keyMap: Record<string, string>;
  keymapDir: string;
  /** When true (default), skip publish — leave a draft revision on target. */
  asDraft: boolean;
  rateLimitDelay: number;
  debug: boolean;
}

export function loadExportConfig(opts: {
  models: string;
  locale: string;
  siteId: string;
  out: string;
  filterSpec?: FrozenFilterSpec | null;
}): ExportConfig {
  const src = resolveEnvironment("source", { requireManage: true });
  return {
    sourceAdminGqlUrl: src.adminGqlUrl,
    sourceManageUrl: src.manageUrl,
    sourceApiKey: src.apiKey,
    sourceTenant: src.tenant,
    locale: opts.locale,
    models: opts.models.split(",").map((m) => m.trim()).filter(Boolean),
    siteIdFilter: opts.siteId || null,
    filterSpec: opts.filterSpec ?? null,
    outDir: opts.out,
    rateLimitDelay: getRateLimitDelay(),
    debug: getDebug(),
  };
}

export function loadImportConfig(opts: {
  locale: string;
  concurrency: string;
  dryRun: boolean;
  dir: string;
  allowFolderMismatch?: boolean;
  keyMap?: Record<string, string>;
  keymapDir?: string;
  asDraft?: boolean;
}): ImportConfig {
  const tgt = resolveEnvironment("target", { requireManage: true });
  return {
    targetAdminGqlUrl: tgt.adminGqlUrl,
    targetManageUrl: tgt.manageUrl,
    targetApiKey: tgt.apiKey,
    targetTenant: tgt.tenant,
    locale: opts.locale,
    concurrency: parseInt(opts.concurrency, 10) || 5,
    dryRun: opts.dryRun,
    sourceCdnDomain: resolveEnvironment("source").cdnDomain || null,
    targetCdnDomain: tgt.cdnDomain || null,
    dir: opts.dir,
    allowFolderMismatch: opts.allowFolderMismatch ?? false,
    keyMap: opts.keyMap ?? {},
    keymapDir: opts.keymapDir || defaultKeymapDir(),
    asDraft: opts.asDraft !== false,
    rateLimitDelay: getRateLimitDelay(),
    debug: getDebug(),
  };
}
