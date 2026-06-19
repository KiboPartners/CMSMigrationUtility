/**
 * Configuration for redirects cloner.
 * Two shapes: ExportConfig (source → disk) and ImportConfig (disk → target).
 *
 * Values come from the consolidated repo-root .env via @kibo-cms-clone-tool/shared.
 * This module is a thin adapter that maps them onto the shapes this package uses.
 */

import {
  loadRootEnv,
  resolveEnvironment,
  getLocale,
  getRateLimitDelay,
  getDebug,
} from "@kibo-cms-clone-tool/shared";

loadRootEnv();

export interface ExportConfig {
  sourceAdminGqlUrl: string;
  sourceApiKey: string;
  sourceTenant: string;
  locale: string;
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
  dir: string;
  allowFolderMismatch: boolean;
  rateLimitDelay: number;
  debug: boolean;
}

export function loadExportConfig(opts: { out: string }): ExportConfig {
  const src = resolveEnvironment("source");
  return {
    sourceAdminGqlUrl: src.adminGqlUrl,
    sourceApiKey: src.apiKey,
    sourceTenant: src.tenant,
    locale: getLocale(),
    outDir: opts.out,
    rateLimitDelay: getRateLimitDelay(),
    debug: getDebug(),
  };
}

export function loadImportConfig(opts: {
  concurrency: string;
  dryRun: boolean;
  dir: string;
  allowFolderMismatch?: boolean;
}): ImportConfig {
  const tgt = resolveEnvironment("target", { required: !opts.dryRun });
  return {
    targetAdminGqlUrl: tgt.adminGqlUrl,
    targetApiKey: tgt.apiKey,
    targetTenant: tgt.tenant,
    locale: getLocale(),
    concurrency: parseInt(opts.concurrency, 10) || 5,
    dryRun: opts.dryRun,
    dir: opts.dir,
    allowFolderMismatch: opts.allowFolderMismatch ?? false,
    rateLimitDelay: getRateLimitDelay(),
    debug: getDebug(),
  };
}
