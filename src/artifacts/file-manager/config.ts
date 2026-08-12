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
  parseMaxBytes,
  defaultKeymapDir,
  loadStore,
  selectFileRemaps,
  type FrozenFilterSpec,
} from "@kibo-cms-clone-tool/shared";
import { resolveImportBinaryMode, BinaryMode, BinaryGapFallback } from "./clone";
import fs from "fs";
import path from "path";

loadRootEnv();

export interface ExportConfig {
  sourceAdminGqlUrl: string;
  sourceApiKey: string;
  sourceTenant: string;
  locale: string;
  tagsFilter: string[];
  filterSpec: FrozenFilterSpec | null;
  /** When set, only these files (src/key/id) are exported and folders are scoped. */
  selectIds: Set<string> | null;
  outDir: string;
  withBinaries: boolean;
  maxFileBytes: number;
  concurrency: number;
  rateLimitDelay: number;
  debug: boolean;
}

export interface ImportConfig {
  targetAdminGqlUrl: string;
  targetApiKey: string;
  targetTenant: string;
  sourceTenant: string;
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
  binaryMode: BinaryMode;
  gapFallback: BinaryGapFallback;
  /** Per-fileId remaps from a prior import (this tenant pair) — idempotency cache. */
  priorRemaps: Map<string, { targetUrl: string; targetKey: string }>;
  maxFileBytes: number;
  rateLimitDelay: number;
  debug: boolean;
  keymapDir: string;
}

export function loadExportConfig(opts: {
  tags: string;
  out: string;
  withBinaries?: boolean;
  maxFileSize?: string;
  filterSpec?: FrozenFilterSpec | null;
  selectIds?: Set<string> | null;
}): ExportConfig {
  const src = resolveEnvironment("source");
  return {
    sourceAdminGqlUrl: src.adminGqlUrl,
    sourceApiKey: src.apiKey,
    sourceTenant: src.tenant,
    locale: optionalEnv("LOCALE", "en-US"),
    tagsFilter: opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    filterSpec: opts.filterSpec ?? null,
    selectIds: opts.selectIds ?? null,
    outDir: opts.out,
    withBinaries: opts.withBinaries ?? false,
    maxFileBytes: parseMaxBytes(opts.maxFileSize ?? optionalEnv("MAX_FILE_SIZE_MB", "")),
    concurrency: parseInt(optionalEnv("EXPORT_CONCURRENCY", optionalEnv("CONCURRENCY", "6")), 10) || 6,
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
  uploadBinaries?: boolean;
  streamBinaries?: boolean;
  manifestOnly?: boolean;
  maxFileSize?: string;
  keymapDir?: string;
}): ImportConfig {
  const dryRun = opts.dryRun;

  // Target connection + CDN are only required when actually writing.
  const tgt = resolveEnvironment("target", { requireCdn: !dryRun, required: !dryRun });

  // Source tenant is used only for tagging remap records — best-effort, never required.
  const sourceTenant = (() => {
    try { return resolveEnvironment("source").tenant; } catch { return ""; }
  })();

  // Idempotency cache: files already migrated for this tenant pair in a prior run.
  const keymapDir = opts.keymapDir || defaultKeymapDir();
  const priorRemaps = selectFileRemaps(loadStore(keymapDir), sourceTenant, tgt.tenant);

  return {
    targetAdminGqlUrl: tgt.adminGqlUrl,
    targetApiKey: tgt.apiKey,
    targetTenant: tgt.tenant,
    sourceTenant,
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
    ...(() => {
      const cachePresent = fs.existsSync(path.join(opts.dir, "binaries", "manifest.json"));
      return resolveImportBinaryMode(
        { manifestOnly: opts.manifestOnly, uploadBinaries: opts.uploadBinaries, streamBinaries: opts.streamBinaries },
        cachePresent
      );
    })(),
    maxFileBytes: parseMaxBytes(opts.maxFileSize ?? optionalEnv("MAX_FILE_SIZE_MB", "")),
    rateLimitDelay: getRateLimitDelay(),
    debug: getDebug(),
    keymapDir,
    priorRemaps,
  };
}
