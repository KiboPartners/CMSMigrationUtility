/**
 * Configuration for page-builder cloner.
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
} from "@kibo-cms-clone-tool/shared";

loadRootEnv();

export interface ExportConfig {
  sourceAdminGqlUrl: string;
  sourceApiKey: string;
  sourceTenant: string;
  locale: string;
  includeUnpublished: boolean;
  outDir: string;
  rateLimitDelay: number;
  debug: boolean;
}

export interface ImportConfig {
  targetAdminGqlUrl: string;
  targetApiKey: string;
  targetTenant: string;
  locale: string;
  concurrency: number;
  dryRun: boolean;
  sourceCdnDomain: string | null;
  targetCdnDomain: string | null;
  dir: string;
  allowFolderMismatch: boolean;
  rateLimitDelay: number;
  debug: boolean;
}

export function loadExportConfig(opts: {
  locale: string;
  includeUnpublished: string;
  out: string;
}): ExportConfig {
  const src = resolveEnvironment("source");
  return {
    sourceAdminGqlUrl: src.adminGqlUrl,
    sourceApiKey: src.apiKey,
    sourceTenant: src.tenant,
    locale: opts.locale,
    includeUnpublished: opts.includeUnpublished !== "false",
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
}): ImportConfig {
  // source is only read for the CDN domain (URL rewriting) — never require it.
  const src = resolveEnvironment("source", { required: false });
  const tgt = resolveEnvironment("target", { required: !opts.dryRun });
  return {
    targetAdminGqlUrl: tgt.adminGqlUrl,
    targetApiKey: tgt.apiKey,
    targetTenant: tgt.tenant,
    locale: opts.locale,
    concurrency: parseInt(opts.concurrency, 10) || 3,
    dryRun: opts.dryRun,
    sourceCdnDomain: src.cdnDomain || null,
    targetCdnDomain: tgt.cdnDomain || null,
    dir: opts.dir,
    allowFolderMismatch: opts.allowFolderMismatch ?? false,
    rateLimitDelay: getRateLimitDelay(),
    debug: getDebug(),
  };
}
