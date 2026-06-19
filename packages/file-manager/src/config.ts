/**
 * Configuration for file-manager cloner.
 * Two shapes: ExportConfig (source → disk) and ImportConfig (disk → target).
 *
 * Values come from the consolidated repo-root .env via @kibo-cms-clone-tool/shared.
 * This module is a thin adapter that maps them onto the shapes this package uses.
 */

import {
  loadRootEnv,
  resolveEnvironment,
  requireEnv,
  optionalEnv,
  getRateLimitDelay,
  getDebug,
} from "@kibo-cms-clone-tool/shared";

loadRootEnv();

export interface ExportConfig {
  sourceAdminGqlUrl: string;
  sourceApiKey: string;
  sourceTenant: string;
  locale: string;
  tagsFilter: string[];
  outDir: string;
  rateLimitDelay: number;
  debug: boolean;
}

export interface ImportConfig {
  targetAdminGqlUrl: string;
  targetApiKey: string;
  targetTenant: string;
  locale: string;
  sourceCdnDomain: string;
  targetCdnDomain: string;
  sourceS3Bucket: string;
  targetS3Bucket: string;
  sourceS3Prefix: string;
  concurrency: number;
  dryRun: boolean;
  skipExisting: boolean;
  dir: string;
  allowFolderMismatch: boolean;
  rateLimitDelay: number;
  debug: boolean;
}

export function loadExportConfig(opts: {
  tags: string;
  out: string;
}): ExportConfig {
  const src = resolveEnvironment("source");
  return {
    sourceAdminGqlUrl: src.adminGqlUrl,
    sourceApiKey: src.apiKey,
    sourceTenant: src.tenant,
    locale: optionalEnv("LOCALE", "en-US"),
    tagsFilter: opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    outDir: opts.out,
    rateLimitDelay: getRateLimitDelay(),
    debug: getDebug(),
  };
}

export function loadImportConfig(opts: {
  concurrency: string;
  dryRun: boolean;
  skipExisting: string;
  dir: string;
  allowFolderMismatch?: boolean;
}): ImportConfig {
  const dryRun = opts.dryRun;

  // Target connection + CDN are only required when actually writing.
  const tgt = resolveEnvironment("target", { requireCdn: !dryRun, required: !dryRun });

  return {
    targetAdminGqlUrl: tgt.adminGqlUrl,
    targetApiKey: tgt.apiKey,
    targetTenant: tgt.tenant,
    locale: optionalEnv("LOCALE", "en-US"),
    sourceCdnDomain: requireEnv("SOURCE_CDN_DOMAIN"),
    targetCdnDomain: tgt.cdnDomain,
    sourceS3Bucket: optionalEnv("SOURCE_S3_BUCKET", "source-bucket"),
    targetS3Bucket: optionalEnv("TARGET_S3_BUCKET", "target-bucket"),
    sourceS3Prefix: optionalEnv("SOURCE_S3_PREFIX", "files/"),
    concurrency: parseInt(opts.concurrency, 10) || 10,
    dryRun,
    skipExisting: opts.skipExisting !== "false",
    dir: opts.dir,
    allowFolderMismatch: opts.allowFolderMismatch ?? false,
    rateLimitDelay: getRateLimitDelay(),
    debug: getDebug(),
  };
}
