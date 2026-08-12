/**
 * Import step: read exported files.json from disk,
 * recreate folder structure in target,
 * register each file's metadata in target File Manager,
 * write s3-copy-manifest.txt for the binary copy.
 */

import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import {
  GraphQLClient,
  ItemResult,
  logger,
  syncFolders,
  validateFolderMapping,
  formatFolderValidation,
  FolderAdapter,
  FolderSyncResult,
  transferBinary,
  uploadLocalBinary,
  isWithinSizeLimit,
  safeKeyPath,
  KeyRemapRecord,
  recordRemaps,
  SourceAssetMissingError,
} from "@kibo-cms-clone-tool/shared";
import {
  getExistingFile,
  createFileInTarget,
  updateFileLocationInTarget,
  fetchAllTargetFolders,
  createFolderInTarget,
  FileRecord,
} from "./files";
import { ExportFile } from "./export";
import { ImportConfig } from "./config";

export type BinaryMode = "manifest" | "local" | "stream";
export type BinaryGapFallback = "stream" | "skip";

export interface KeyMapEntry { sourceUrl: string; targetUrl: string }

export function buildKeyMap(
  rows: Array<{ sourceUrl: string; sourceKey: string; targetUrl: string; targetKey: string }>
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (!r.sourceUrl || !r.targetUrl) continue;
    if (r.sourceKey === r.targetKey) continue; // domain swap covers these
    map[r.sourceUrl] = r.targetUrl;
  }
  return map;
}

export function remapRecordsFor(
  rows: Array<{ fileId: string; sourceUrl: string; sourceKey: string; targetUrl: string; targetKey: string }>,
  sourceTenant: string,
  targetTenant: string
): KeyRemapRecord[] {
  const out: KeyRemapRecord[] = [];
  for (const r of rows) {
    if (!r.sourceUrl || !r.targetUrl) continue;
    if (r.sourceKey === r.targetKey) continue;
    out.push({ sourceTenant, targetTenant, fileId: r.fileId, sourceUrl: r.sourceUrl, targetUrl: r.targetUrl, targetKey: r.targetKey, updatedAt: null });
  }
  return out;
}

export function decideBinaryAction(
  file: FileRecord,
  mode: BinaryMode,
  maxFileBytes: number,
  localExists: boolean,
  gapFallback: BinaryGapFallback = "skip"
): "upload-local" | "stream" | "skip-large" | "manifest-skip" | "skip-gap" {
  if (mode === "manifest") return "manifest-skip";
  if (!isWithinSizeLimit(file.size, maxFileBytes)) return "skip-large";
  if (mode === "local") {
    if (localExists) return "upload-local";
    return gapFallback === "stream" ? "stream" : "skip-gap";
  }
  return "stream";
}

/**
 * Resolve import binary behavior from CLI flags + whether a local cache is present.
 * Default is stream. When no explicit flag is given and a local binaries cache
 * exists, prefer it but stream any files missing from the cache (Breaking Change B:
 * an incomplete cache must not silently register metadata-only rows). Explicit
 * --upload-binaries keeps the offline intent (skip + warn on gaps).
 */
export function resolveImportBinaryMode(
  flags: { manifestOnly?: boolean; uploadBinaries?: boolean; streamBinaries?: boolean },
  cachePresent: boolean
): { binaryMode: BinaryMode; gapFallback: BinaryGapFallback } {
  if (flags.manifestOnly && (flags.uploadBinaries || flags.streamBinaries)) {
    throw new Error("--manifest-only cannot be combined with --upload-binaries/--stream-binaries");
  }
  if (flags.manifestOnly) return { binaryMode: "manifest", gapFallback: "skip" };
  if (flags.streamBinaries) return { binaryMode: "stream", gapFallback: "skip" };
  if (flags.uploadBinaries) return { binaryMode: "local", gapFallback: "skip" };
  if (cachePresent) return { binaryMode: "local", gapFallback: "stream" };
  return { binaryMode: "stream", gapFallback: "skip" };
}

export interface ImportStats {
  total: number;
  skipped: number;
  registered: number;
  folderUpdated: number;
  errors: Array<{ key: string; id: string; error: string }>;
  skippedLarge: string[];
  uploaded: string[];
  keyRemaps: number;
  skippedKeys: string[];
  folderUpdatedKeys: string[];
  missingSource: string[];
  manifested: string[];
  skippedGap: string[];
}

export function binaryResultItems(
  files: FileRecord[],
  errorsByKey: Map<string, string>,
  skippedLargeKeys: Set<string>,
  uploadedKeys: Set<string>,
  skippedKeys: Set<string> = new Set(),
  folderUpdatedKeys: Set<string> = new Set(),
  missingSourceKeys: Set<string> = new Set(),
  manifestedKeys: Set<string> = new Set(),
  skippedGapKeys: Set<string> = new Set()
): ItemResult[] {
  return files.map((f) => {
    const id = f.src || f.key;
    if (errorsByKey.has(f.key)) return { type: "file", id, status: "error", error: errorsByKey.get(f.key) };
    if (skippedLargeKeys.has(f.key)) return { type: "file", id, status: "skipped", action: "skipped-large" };
    if (missingSourceKeys.has(f.key)) return { type: "file", id, status: "skipped", action: "no-source-binary" };
    if (manifestedKeys.has(f.key)) return { type: "file", id, status: "skipped", action: "manifested" };
    if (skippedGapKeys.has(f.key)) return { type: "file", id, status: "error", error: "file absent from local cache; not registered on target" };
    if (skippedKeys.has(f.key)) return { type: "file", id, status: "skipped", action: "exists" };
    if (uploadedKeys.has(f.key)) return { type: "file", id, status: "done", action: "uploaded" };
    if (folderUpdatedKeys.has(f.key)) return { type: "file", id, status: "done", action: "folder-moved" };
    return { type: "file", id, status: "done", action: "registered" };
  });
}

export function readExportFile(dir: string): ExportFile {
  const filePath = path.join(dir, "files.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Export file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ExportFile;
}

/**
 * Folder adapter: bridges the shared folder engine to the File Manager / ACO
 * folder API (discovery + fall-through live in files.ts).
 */
function fileFolderAdapter(targetClient: GraphQLClient): FolderAdapter {
  return {
    listTargetFolders: () => fetchAllTargetFolders(targetClient),
    createFolder: async ({ name, slug, parentId }) => {
      const created = await createFolderInTarget(targetClient, name, slug, parentId);
      return created.id;
    },
  };
}

async function processFile(
  file: FileRecord,
  targetClient: GraphQLClient,
  config: ImportConfig,
  exportSourceCdnDomain: string,
  folderIdMap: Map<string, string>
): Promise<{ action: "skipped" | "registered" | "folderUpdated" | "error"; binary?: "uploaded" | "skipped-large" | "missing-source" | "manifested" | "skipped-gap"; error?: string; remap?: { fileId: string; sourceUrl: string; sourceKey: string; targetUrl: string; targetKey: string } }> {
  if (config.dryRun) {
    return { action: "registered" }; // count as "would register"
  }

  try {
    // Resolve target folder ID from the source folder map
    const sourceFolderId = file.location?.folderId ?? null;
    const targetFolderId = sourceFolderId ? (folderIdMap.get(sourceFolderId) ?? null) : null;

    // Check whether the file already exists in the target. First by the source
    // key (catches same-key / metadata files). If not found, consult the prior
    // remap for this fileId: a streamed/uploaded file lands under a minted key
    // that differs from the source key, so a re-run would otherwise miss it and
    // upload a duplicate. Re-probe by the recorded target key to confirm the
    // object is still there before treating it as existing.
    let existing = await getExistingFile(targetClient, file.key);
    if (!existing) {
      const prior = config.priorRemaps.get(file.id);
      if (prior) existing = await getExistingFile(targetClient, prior.targetKey);
    }

    if (existing) {
      if (!config.skipExisting) {
        // skipExisting=false means re-register (treat as new) — fall through to create
      } else {
        // File exists — check if it needs to be moved to the correct folder
        const existingFolderId = existing.location?.folderId ?? null;
        if (targetFolderId && existingFolderId !== targetFolderId) {
          await updateFileLocationInTarget(targetClient, existing.id, targetFolderId);
          return { action: "folderUpdated" };
        }
        return { action: "skipped" };
      }
    }

    // Binary content (opt-in). Decide and act before registering metadata
    // so the file record points at the actual S3 object.
    let finalKey: string | undefined;
    const localPath = safeKeyPath(path.join(config.dir, "binaries"), file.key);
    const binaryAction = decideBinaryAction(
      file,
      config.binaryMode,
      config.maxFileBytes,
      !!localPath && fs.existsSync(localPath),
      config.gapFallback
    );

    if (binaryAction === "skip-large") {
      return { action: "skipped", binary: "skipped-large", error: "over size limit (binary)" };
    }
    if (binaryAction === "manifest-skip") {
      // Manifest-only: no createFile, no metadata row, no remap — refs resolve
      // via same-key S3 copy + domain swap once the operator runs the manifest.
      return { action: "skipped", binary: "manifested" };
    }
    if (binaryAction === "skip-gap") {
      // Explicit --upload-binaries but this file is absent from the local cache.
      return { action: "skipped", binary: "skipped-gap", error: "not in local cache" };
    }

    const meta = { id: file.id, key: file.key, name: file.name, type: file.type, size: file.size };
    let finalId: string | undefined;
    let binaryOutcome: "uploaded" | undefined;
    if (binaryAction === "upload-local") {
      const { key, fileId } = await uploadLocalBinary({ meta, filePath: localPath!, targetClient });
      finalKey = key;
      finalId = fileId;
      binaryOutcome = "uploaded";
    } else if (binaryAction === "stream") {
      try {
        const { key, fileId } = await transferBinary({ meta, sourceUrl: file.src, targetClient });
        finalKey = key;
        finalId = fileId;
        binaryOutcome = "uploaded";
      } catch (e) {
        // Source has metadata but no binary (orphan) — skip this file, don't fail the run.
        if (e instanceof SourceAssetMissingError) {
          return { action: "skipped", binary: "missing-source", error: "source binary not found (404)" };
        }
        throw e;
      }
    }

    const created = await createFileInTarget(
      targetClient,
      file,
      exportSourceCdnDomain || config.sourceCdnDomain,
      config.targetCdnDomain,
      targetFolderId ?? undefined,
      finalKey,
      finalId
    );

    // Capture remap row when a binary was uploaded (key may have changed on target)
    let remap: { fileId: string; sourceUrl: string; sourceKey: string; targetUrl: string; targetKey: string } | undefined;
    if (binaryOutcome === "uploaded") {
      remap = {
        fileId: file.id,
        sourceUrl: file.src,
        sourceKey: file.key,
        targetUrl: created.src,
        targetKey: created.key,
      };
    }

    return { action: "registered", binary: binaryOutcome, remap };
  } catch (err) {
    return {
      action: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * POSIX single-quote a shell argument so a crafted S3 key (quotes, `$(...)`,
 * backticks) cannot break out and inject commands when the manifest is run.
 * The manifest assumes a POSIX shell (bash/zsh).
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildManifestLines(
  files: FileRecord[],
  skippedLargeKeys: Set<string>,
  sourceBucket: string,
  targetBucket: string,
  sourcePrefix: string,
  manifestOnly: boolean
): string[] {
  const cp = (key: string) =>
    `aws s3 cp ${shQuote(`s3://${sourceBucket}/${key}`)} ${shQuote(`s3://${targetBucket}/${key}`)}`;
  if (!manifestOnly) {
    // Focused manifest: `files` are already exactly the not-transferred set
    // (over the size limit, or absent from the local cache). No sync-entire-
    // prefix suggestion (that would imply nothing was copied), and no separate
    // skipped-large section (these files already ARE that set).
    return [
      "# Files NOT transferred by this import (over the size limit, or absent from the local cache) — copy these manually:",
      `# Source bucket : ${sourceBucket}`,
      `# Target bucket : ${targetBucket}`,
      "#",
      ...files.map((f) => cp(f.key)),
    ];
  }

  const lines = [
    "# S3 Copy Manifest — generated by Kibo CMS file-manager cloner",
    `# Source bucket : ${sourceBucket}`,
    `# Target bucket : ${targetBucket}`,
    "#",
    "# Option A — Sync entire files prefix:",
    `#   aws s3 sync s3://${sourceBucket}/${sourcePrefix} s3://${targetBucket}/${sourcePrefix}`,
    "#",
    "# Option B — Copy individual files:",
    ...files.map((f) => cp(f.key)),
  ];
  const skipped = files.filter((f) => skippedLargeKeys.has(f.key));
  if (skipped.length) {
    lines.push(
      "",
      "# ─────────────────────────────────────────────",
      "# Files SKIPPED by the size gate — copy these manually:",
      ...skipped.map((f) => cp(f.key))
    );
  }
  return lines;
}

function writeS3Manifest(files: FileRecord[], skippedLargeKeys: Set<string>, config: ImportConfig, manifestOnly: boolean): void {
  const manifestPath = path.resolve(process.cwd(), "s3-copy-manifest.txt");

  const lines = buildManifestLines(files, skippedLargeKeys, config.sourceS3Bucket, config.targetS3Bucket, config.sourceS3Prefix, manifestOnly);
  // Insert the generated-at timestamp after the header buckets block
  lines.splice(3, 0, `# Generated at  : ${new Date().toISOString()}`);

  fs.writeFileSync(manifestPath, lines.join("\n"), "utf-8");
  logger.log(`\n📄 S3 copy manifest written to: ${manifestPath}`);
  logger.log(`   Share with your AWS admin to copy ${files.length} file(s).`);
}

export async function importFiles(
  targetClient: GraphQLClient,
  exportFile: ExportFile,
  config: ImportConfig
): Promise<ImportStats> {
  const { files, folders = [] } = exportFile;

  // Step 1: sync folder tree, get sourceId→targetId map.
  // Folder creation is best-effort — if the target Kibo CMS instance doesn't
  // expose a folder API at all, skip it and import all files flat (no folder).
  let folderIdMap = new Map<string, string>();
  let sync: FolderSyncResult | null = null;
  try {
    sync = await syncFolders(fileFolderAdapter(targetClient), folders, {
      dryRun: config.dryRun,
      label: "folder",
      logger,
    });
    folderIdMap = sync.idMap;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`\n  ⚠  Folder sync skipped — folder API unavailable on this target:`);
    logger.warn(`     ${msg.split("\n")[0]}`);
    logger.warn(`     Files will be imported without folder assignment.\n`);
  }

  // Step 1b: validate that every file's folder resolved before importing.
  // Blocks (unless --allow-folder-mismatch) so files don't silently land at root.
  // Runs on dry-run too — otherwise dry-run can look green while a live import fails.
  if (sync) {
    const refs = files.map((f) => ({ itemId: f.id, folderId: f.location?.folderId ?? null }));
    const report = validateFolderMapping(refs, sync);
    if (!report.ok) {
      formatFolderValidation(report, "file").forEach((l) => logger.warn(`  ${l}`));
      if (!config.allowFolderMismatch) {
        throw new Error(
          `Folder validation failed: ${report.issues.length} file(s) reference folders ` +
            `that did not sync to the target. Pass --allow-folder-mismatch to import anyway.`
        );
      }
    }
  }

  // Step 2: register file metadata
  const stats: ImportStats = {
    total: files.length,
    skipped: 0,
    registered: 0,
    folderUpdated: 0,
    errors: [],
    skippedLarge: [],
    uploaded: [],
    keyRemaps: 0,
    skippedKeys: [],
    folderUpdatedKeys: [],
    missingSource: [],
    manifested: [],
    skippedGap: [],
  };

  logger.log(
    config.dryRun
      ? `\n  [dry-run] Would register ${files.length} file(s) (no writes)…`
      : `\n  Registering ${files.length} files in target...`
  );

  const limit = pLimit(config.concurrency);
  let processed = 0;
  const remapRows: Array<{ fileId: string; sourceUrl: string; sourceKey: string; targetUrl: string; targetKey: string }> = [];

  const tasks = files.map((file) =>
    limit(async () => {
      const result = await processFile(
        file,
        targetClient,
        config,
        exportFile.sourceCdnDomain,
        folderIdMap
      );

      if (result.action === "skipped") stats.skipped++;
      else if (result.action === "registered") stats.registered++;
      else if (result.action === "folderUpdated") stats.folderUpdated++;
      else {
        stats.errors.push({ key: file.key, id: file.id, error: result.error ?? "unknown" });
      }

      // Classify skips: plain skip (exists) vs over-gate vs missing source binary.
      if (result.action === "skipped" && result.binary === undefined) stats.skippedKeys.push(file.key);
      else if (result.action === "folderUpdated") stats.folderUpdatedKeys.push(file.key);

      if (result.binary === "skipped-large") stats.skippedLarge.push(file.key);
      else if (result.binary === "missing-source") stats.missingSource.push(file.key);
      else if (result.binary === "uploaded") stats.uploaded.push(file.key);
      else if (result.binary === "manifested") stats.manifested.push(file.key);
      else if (result.binary === "skipped-gap") stats.skippedGap.push(file.key);

      if (result.remap) remapRows.push(result.remap);

      processed++;
      if (processed % 50 === 0 || processed === files.length) {
        logger.write(`\r  Progress: ${processed}/${files.length}`);
      }
    })
  );

  await Promise.all(tasks);
  logger.write("\n");

  // Write the S3 copy manifest only when files actually need a manual copy:
  // manifest-only mode (all files), or files skipped by the size gate / absent
  // from the local cache. A normal streaming/upload import transfers everything,
  // so emitting an all-files manifest (and the "not copied" note the UI derives
  // from it) would be misleading.
  if (!config.dryRun) {
    const manualCopyFiles = config.binaryMode === "manifest"
      ? files
      : files.filter((f) => stats.skippedLarge.includes(f.key) || stats.skippedGap.includes(f.key));
    if (manualCopyFiles.length > 0) {
      writeS3Manifest(manualCopyFiles, new Set(stats.skippedLarge), config, config.binaryMode === "manifest");
    }
  }

  // Write key-map.json (always on a real run, even if empty — downstream steps can rely on it).
  // Dry-run must not touch the export dir or the central store.
  if (!config.dryRun) {
    const keyMap = buildKeyMap(remapRows);
    stats.keyRemaps = Object.keys(keyMap).length;
    const keyMapPath = path.join(config.dir, "key-map.json");
    fs.writeFileSync(keyMapPath, JSON.stringify(keyMap, null, 2), "utf-8");

    const records = remapRecordsFor(remapRows, config.sourceTenant, config.targetTenant);
    recordRemaps(config.keymapDir, records);

    if (stats.keyRemaps > 0) {
      logger.warn(
        `\n  ⚠  ${stats.keyRemaps} file(s) received a NEW S3 key on the target. ` +
          `Recorded ${records.length} remap(s) in the central key-map store ` +
          `(${config.keymapDir}/store.json) under tenant ${config.sourceTenant} → ${config.targetTenant}.\n` +
          `     cms-entries/page-builder import read this automatically for the same tenant pair.`
      );
    }
  }

  if (stats.missingSource.length > 0) {
    logger.warn(
      `\n  ⚠  ${stats.missingSource.length} file(s) skipped — the SOURCE has no binary (HTTP 404, orphan ` +
        `metadata). Nothing to copy; the binary must exist on the source first. Affected keys:\n` +
        stats.missingSource.slice(0, 20).map((k) => `       ${k}`).join("\n") +
        (stats.missingSource.length > 20 ? `\n       …and ${stats.missingSource.length - 20} more` : "")
    );
  }

  if (stats.skippedGap.length > 0) {
    logger.warn(
      `\n  ⚠  ${stats.skippedGap.length} file(s) were NOT transferred — absent from the local ` +
        `binaries cache (--upload-binaries). Their references will break until copied. ` +
        `Re-run with --stream-binaries, or complete the export's binaries/ cache:\n` +
        stats.skippedGap.slice(0, 20).map((k) => `       ${k}`).join("\n") +
        (stats.skippedGap.length > 20 ? `\n       …and ${stats.skippedGap.length - 20} more` : "")
    );
  }

  return stats;
}
