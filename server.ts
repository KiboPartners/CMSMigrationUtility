/**
 * Local web UI (Express) for the Kibo CMS Import/Export Utility.
 *
 * Single embedded HTML page (no external assets/CDN/build) with a collapsible
 * left nav over four workspaces:
 *   • Export — selectively export artifacts from a source tenant to a server folder
 *   • Import — import a previously exported folder into a target tenant
 *   • Copy   — direct source→target migration (catalog → select → migrate)
 *   • Logs   — browse workstream console runs (.logs/) with search + filters
 *
 * Catalog/plan/runs are computed in-process; export/import/copy/catalog spawn the
 * root CLI with the chosen tenants injected via child env. Design system follows
 * the Kibo Commerce brand (charcoal #2E343E + signal yellow #FFCE01), light & dark.
 *
 * Start:  npx ts-node index.ts serve --port 4317
 */

import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import AdmZip from "adm-zip";
import {
  Catalog,
  CatalogItem,
  CatalogSection,
  ArtifactType,
  planMigration,
  listRuns,
  loadRunWithFallback,
  runSummary,
  aggregateMetrics,
  workstreamLedgerDirs,
  readNdjsonLines,
  validateFilterSpec,
  freezeFilterSpec,
  writeFilterSpec,
  isFilterActive,
  matchCatalogItem,
  normalizeFileDepId,
} from "@kibo-cms-clone-tool/shared";
import { startJob, getJob, subscribeJob } from "./src/jobs/runner";
import { listWorkstreamRuns, defaultLogsRoot, Workstream } from "./src/jobs/logstore";
import { stripOmittedIds } from "./src/jobs/selectiveExport";

export interface ServeOptions {
  root: string;
  port: number;
  catalogPath: string;
  schemaFile: string;
  runsDir: string;
}

/** Resolve a zip entry to an absolute path inside destDir, or null if it escapes (zip-slip guard). */
export function safeZipEntryPath(destDir: string, entryName: string): string | null {
  const resolved = path.resolve(destDir, entryName);
  const root = path.resolve(destDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

// Artifact type ↔ package mapping shared by export/import selection.
const PKGS = ["file-manager", "cms-entries", "page-builder", "redirects"] as const;
type Pkg = (typeof PKGS)[number];

/** Export UI targets — Content Models and Content Entries are separate chips. */
const EXPORT_TARGETS = ["file-manager", "cms-models", "cms-entries", "page-builder", "redirects"] as const;
type ExportTarget = (typeof EXPORT_TARGETS)[number];

const PKG_FOR_ARTIFACT: Record<ArtifactType, Pkg> = {
  model: "cms-entries",
  file: "file-manager",
  "cms-entry": "cms-entries",
  page: "page-builder",
  redirect: "redirects",
};

/** Same CDN file-URL scan page-builder catalog uses for dependsOn. */
const FILE_URL_RE = /https?:\/\/[^"'\s]+\/files\/[^"'\s\\]+/g;

function extractEntryDeps(
  fields: Array<{ fieldId: string; type: string }>,
  entry: Record<string, unknown>
): string[] {
  const deps: string[] = [];
  for (const field of fields) {
    const v = entry[field.fieldId];
    if (v == null) continue;
    if (field.type === "file") {
      const arr = Array.isArray(v) ? v : [v];
      for (const f of arr) if (typeof f === "string" && f) deps.push(normalizeFileDepId(f) || f);
    } else if (field.type === "ref") {
      const arr = Array.isArray(v) ? v : [v];
      for (const r of arr) {
        const eid = (r as { entryId?: string })?.entryId;
        if (eid) deps.push(eid);
      }
    }
  }
  return deps;
}

function extractPageFileDeps(page: Record<string, unknown>): string[] {
  const matches = JSON.stringify(page).match(FILE_URL_RE);
  if (!matches) return [];
  return [...new Set(matches.map((u) => normalizeFileDepId(u)).filter(Boolean))];
}

/** True when cms/ has entry manifests (not just models.json). */
export function cmsDirHasEntries(cmsDir: string): boolean {
  if (!fs.existsSync(cmsDir)) return false;
  return fs.readdirSync(cmsDir).some(
    (n) => n.endsWith(".entries.ndjson") || (n.endsWith(".json") && n !== "models.json")
  );
}

/**
 * Human-readable artifact pills for an export folder (Import source list).
 * Content Models is separate from Content Entries when models.json is present.
 */
export function listExportArtifactLabels(exportDir: string): string[] {
  const labels: string[] = [];
  if (fs.existsSync(path.join(exportDir, "files"))) labels.push("Files");
  const cms = path.join(exportDir, "cms");
  if (fs.existsSync(path.join(cms, "models.json"))) labels.push("Content Models");
  if (cmsDirHasEntries(cms)) labels.push("Content Entries");
  if (fs.existsSync(path.join(exportDir, "pages"))) labels.push("Pages");
  if (fs.existsSync(path.join(exportDir, "redirects"))) labels.push("Redirects");
  return labels;
}

/** Packages present in an export folder (for import-all when nothing is selected). */
export function packagesInExport(exportDir: string): Pkg[] {
  const out: Pkg[] = [];
  if (fs.existsSync(path.join(exportDir, "files"))) out.push("file-manager");
  if (cmsDirHasEntries(path.join(exportDir, "cms"))) out.push("cms-entries");
  if (fs.existsSync(path.join(exportDir, "pages"))) out.push("page-builder");
  if (fs.existsSync(path.join(exportDir, "redirects"))) out.push("redirects");
  return out;
}

/**
 * Build a Catalog from an on-disk export folder (same inventory as Import UI),
 * including dependsOn edges so selection can resolve like Migrate.
 */
export async function buildImportCatalog(exportDir: string): Promise<Catalog> {
  const sections: CatalogSection[] = [];
  const readJson = (p: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  };

  const cmsDir = path.join(exportDir, "cms");
  if (fs.existsSync(cmsDir)) {
    const modelItems: CatalogItem[] = [];
    const entryItems: CatalogItem[] = [];
    const modelIdsFromStructure = new Set<string>();

    // Prefer standalone models.json (export-models) for the Content Models section.
    const modelsFile = path.join(cmsDir, "models.json");
    if (fs.existsSync(modelsFile)) {
      const struct = readJson(modelsFile) as {
        models?: Array<{ modelId?: string; name?: string; fields?: unknown[] }>;
      } | null;
      for (const m of struct?.models ?? []) {
        const modelId = String(m.modelId ?? "").trim();
        if (!modelId || modelIdsFromStructure.has(modelId)) continue;
        modelIdsFromStructure.add(modelId);
        modelItems.push({
          type: "model",
          id: modelId,
          label: String(m.name ?? modelId),
          metadata: {
            name: String(m.name ?? modelId),
            fields: Array.isArray(m.fields) ? m.fields.length : null,
            entries: null,
          },
        });
      }
    }

    for (const f of fs.readdirSync(cmsDir).filter((n) => n.endsWith(".json") && n !== "models.json")) {
      const j = readJson(path.join(cmsDir, f)) as {
        modelId?: string;
        modelName?: string;
        count?: number;
        schema?: { fields?: Array<{ fieldId?: string; type?: string }> };
        entries?: Array<Record<string, unknown>>;
      } | null;
      const modelName = j?.modelName ?? path.basename(f, ".json");
      const modelId = String(j?.modelId ?? "").trim();
      const fields = (j?.schema?.fields ?? [])
        .map((fld) => ({ fieldId: String(fld.fieldId ?? ""), type: String(fld.type ?? "") }))
        .filter((fld) => fld.fieldId);
      // Fallback: synthesize model rows from entry manifests when models.json is absent.
      if (modelId && !modelIdsFromStructure.has(modelId)) {
        modelItems.push({
          type: "model",
          id: modelId,
          label: modelName,
          metadata: {
            name: modelName,
            fields: fields.length || null,
            entries: typeof j?.count === "number" ? j.count : (j?.entries?.length ?? null),
          },
        });
      } else if (modelId && modelIdsFromStructure.has(modelId)) {
        // Enrich entry count on the structure-backed model row when known.
        const row = modelItems.find((it) => it.id === modelId);
        if (row && row.metadata && typeof j?.count === "number") {
          (row.metadata as { entries?: number }).entries = j.count;
        }
      }
      const pushEntry = (e: Record<string, unknown>) => {
        const meta = (e["meta"] as { title?: string; status?: string; version?: unknown } | undefined) ?? {};
        const id = String(e["entryId"] ?? e["id"] ?? "");
        if (!id) return;
        const label = String(e["title"] ?? e["name"] ?? e["slug"] ?? meta.title ?? id);
        entryItems.push({
          type: "cms-entry",
          id,
          label,
          group: modelName,
          metadata: {
            name: label,
            model: modelName,
            status: meta.status ?? null,
            live: meta.status === "published",
            version: meta.status === "published" ? meta.version ?? null : null,
          },
          dependsOn: modelId ? [modelId, ...extractEntryDeps(fields, e)] : extractEntryDeps(fields, e),
        });
      };
      const ndjsonPath = path.join(cmsDir, `${modelName}.entries.ndjson`);
      if (fs.existsSync(ndjsonPath)) {
        await readNdjsonLines(ndjsonPath, (e) => {
          pushEntry(e);
        });
      } else {
        for (const e of j?.entries ?? []) pushEntry(e);
      }
    }
    if (modelItems.length) sections.push({ type: "model", total: modelItems.length, items: modelItems });
    if (entryItems.length || modelItems.length) {
      sections.push({ type: "cms-entry", total: entryItems.length, items: entryItems });
    }
  }

  const pagesFile = path.join(exportDir, "pages", "pages.json");
  if (fs.existsSync(pagesFile)) {
    const items: CatalogItem[] = [];
    const pushPage = (p: Record<string, unknown>) => {
      const props = (p["properties"] as { title?: string; path?: string } | undefined) ?? {};
      const id = String(p["entryId"] ?? p["id"] ?? "");
      if (!id) return;
      const status = (p["status"] as string) ?? null;
      items.push({
        type: "page",
        id,
        label: String(props.title ?? props.path ?? id),
        metadata: {
          name: props.title ?? id,
          path: props.path ?? null,
          status,
          live: status === "published",
          version: status === "published" ? p["version"] ?? null : null,
        },
        dependsOn: extractPageFileDeps(p),
      });
    };
    const pagesNdjsonPath = path.join(exportDir, "pages", "pages.entries.ndjson");
    if (fs.existsSync(pagesNdjsonPath)) {
      await readNdjsonLines(pagesNdjsonPath, pushPage);
    } else {
      const j = readJson(pagesFile) as { pages?: Array<Record<string, unknown>> } | null;
      for (const p of j?.pages ?? []) pushPage(p);
    }
    sections.push({ type: "page", total: items.length, items });
  }

  const redirFile = path.join(exportDir, "redirects", "redirects.json");
  if (fs.existsSync(redirFile)) {
    const items: CatalogItem[] = [];
    const pushRedirect = (r: Record<string, unknown>) => {
      const id = String(r["redirectFrom"] ?? "");
      if (!id) return;
      items.push({
        type: "redirect",
        id,
        label: id,
        metadata: { name: r["redirectFrom"], path: r["redirectTo"] },
      });
    };
    const redirNdjsonPath = path.join(exportDir, "redirects", "redirects.entries.ndjson");
    if (fs.existsSync(redirNdjsonPath)) {
      await readNdjsonLines(redirNdjsonPath, pushRedirect);
    } else {
      const j = readJson(redirFile) as { redirects?: Array<Record<string, unknown>> } | null;
      for (const r of j?.redirects ?? []) pushRedirect(r);
    }
    sections.push({ type: "redirect", total: items.length, items });
  }

  const filesFile = path.join(exportDir, "files", "files.json");
  if (fs.existsSync(filesFile)) {
    const j = readJson(filesFile) as { files?: Array<Record<string, unknown>> } | null;
    const items: CatalogItem[] = (j?.files ?? [])
      .map((f) => {
        const id = String(f["src"] ?? f["key"] ?? "");
        return {
          type: "file" as const,
          id,
          label: String(f["key"] ?? f["src"] ?? ""),
          metadata: { name: f["key"], mimeType: f["type"] ?? f["mimeType"], size: f["size"] },
        };
      })
      .filter((it) => it.id);
    sections.push({ type: "file", total: items.length, items });
  }

  return {
    environment: { role: "export", tenant: path.basename(exportDir), locale: "" },
    generatedAt: null,
    sections,
  };
}

export type ImportSelectionPlan =
  | { mode: "all" }
  /** Only content-model rows selected → provision schemas, no entries. */
  | { mode: "models-only"; modelIds: string[] }
  /**
   * Selective import — ids are dependency-resolved (entry → model + files + refs),
   * same as Migrate's planMigration. `packages` are the artifact packages to run.
   */
  | { mode: "items"; ids: string[]; addedByDependencies: string[]; packages: Pkg[] };

/**
 * Decide how Import UI selection should run (mirrors Migrate):
 * - no ids → import all of the chosen artifact types
 * - every id is a content modelId → provision those models only (no entries)
 * - otherwise → planMigration: resolve dependsOn, order types, derive packages
 */
export async function planImportSelection(exportDir: string, ids: string[]): Promise<ImportSelectionPlan> {
  if (!ids.length) return { mode: "all" };
  const catalog = await buildImportCatalog(exportDir);
  const modelIdSet = new Set(
    (catalog.sections.find((s) => s.type === "model")?.items ?? []).map((i) => i.id)
  );
  const onlyModels = ids.every((id) => modelIdSet.has(id));
  if (onlyModels) return { mode: "models-only", modelIds: [...new Set(ids)] };

  const mig = planMigration(catalog, ids);
  const pkgSet = new Set<Pkg>();
  for (const step of mig.steps) pkgSet.add(PKG_FOR_ARTIFACT[step.type]);
  const packages = PKGS.filter((p) => pkgSet.has(p));
  return {
    mode: "items",
    ids: mig.steps.flatMap((s) => s.ids),
    addedByDependencies: mig.addedByDependencies,
    packages,
  };
}

/** @deprecated prefer planImportSelection — kept for tests / call sites that only need expansion */
export async function expandImportSelection(exportDir: string, ids: string[]): Promise<string[]> {
  const plan = await planImportSelection(exportDir, ids);
  if (plan.mode === "all") return [];
  if (plan.mode === "models-only") {
    const catalog = await buildImportCatalog(exportDir);
    const byModel = new Map<string, string[]>();
    for (const it of catalog.sections.find((s) => s.type === "cms-entry")?.items ?? []) {
      // buildImportCatalog always puts modelId first in dependsOn
      const modelId = it.dependsOn?.[0];
      if (!modelId) continue;
      const list = byModel.get(modelId) ?? [];
      list.push(it.id);
      byModel.set(modelId, list);
    }
    const out = new Set<string>();
    for (const mid of plan.modelIds) for (const eid of byModel.get(mid) ?? []) out.add(eid);
    return [...out];
  }
  return plan.ids;
}

export function startServer(opts: ServeOptions): void {
  const runsDir = path.isAbsolute(opts.runsDir) ? opts.runsDir : path.join(opts.root, opts.runsDir);
  const catalogFile = path.isAbsolute(opts.catalogPath) ? opts.catalogPath : path.join(opts.root, opts.catalogPath);
  // Target catalog (for the Purge tab) is kept separate so it never clobbers the
  // source catalog the Migrate tab uses.
  const targetCatalogFile = path.join(opts.root, "target-catalog.json");
  const catalogFor = (env: string) => (env === "target" ? targetCatalogFile : catalogFile);
  const exportBase = path.join(opts.root, "export");
  const importTmpBase = path.join(opts.root, ".import-tmp");
  const loadCatalogFile = (f: string): Catalog | null =>
    fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf-8")) as Catalog) : null;
  const loadCatalog = (): Catalog | null => loadCatalogFile(catalogFile);
  // Artifact type → package.
  const PKG_FOR: Record<string, Pkg> = { file: "file-manager", "cms-entry": "cms-entries", page: "page-builder", redirect: "redirects" };

  // Resolve once — spawn node + ts-node directly (no npx / no shell).
  // Windows Node 24: spawn("npx.cmd", …) → EINVAL; shell:true + args → DEP0190.
  const tsNodeBin = require.resolve("ts-node/dist/bin.js", { paths: [opts.root] });
  const sharedRegister = path.join(opts.root, "register-shared.js");

  /** Async root CLI (streams stdout/stderr line-by-line for live UI). */
  const cli = (
    args: string[],
    env: NodeJS.ProcessEnv,
    onLine?: (line: string) => void
  ): Promise<{ status: number; output: string }> =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [tsNodeBin, "-r", sharedRegister, "index.ts", ...args],
        { cwd: opts.root, env: { ...process.env, ...env } }
      );
      let output = "";
      const feed = (buf: Buffer) => {
        const t = buf.toString();
        output += t;
        if (onLine) {
          for (const line of t.split(/\r?\n/)) {
            if (line.length) onLine(line);
          }
        }
      };
      child.stdout?.on("data", feed);
      child.stderr?.on("data", feed);
      child.on("close", (code) => resolve({ status: code ?? 1, output }));
      child.on("error", (err) => resolve({ status: 1, output: output + String(err) }));
    });

  // Write an ids list to a private temp file for `--select @file`. Uses a fresh
  // mkdtemp directory (unpredictable name defeats pre-creation) and O_EXCL +
  // O_NOFOLLOW (where supported) so a planted symlink can't be followed. Returns
  // the file path and a cleanup() that removes the whole temp dir.
  const writeIdsTmp = (ids: string[]): { file: string; cleanup: () => void } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-ids-"));
    const file = path.join(dir, "ids");
    const O_NOFOLLOW = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, ids.join("\n")); } finally { fs.closeSync(fd); }
    return { file, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } } };
  };

  // Input validation: args/env are passed to a child process and ids build
  // file paths — reject anything outside a safe character set to prevent
  // injection and path traversal.
  const TENANT_RE = /^[A-Za-z0-9_-]+$/; // tenant ids
  const RUNID_RE = /^[A-Za-z0-9_.-]+$/; // run ids (no path separators)
  const tenantOf = (v: unknown, fallback: string): string | null => {
    const s = String(v || fallback || "root");
    return TENANT_RE.test(s) ? s : null;
  };
  // Validate a comma/array list of package names against the known set.
  const pkgsOf = (v: unknown): Pkg[] => {
    const list = Array.isArray(v) ? v : String(v ?? "").split(",");
    return list.map((s) => String(s).trim()).filter((s): s is Pkg => (PKGS as readonly string[]).includes(s));
  };
  const exportTargetsOf = (v: unknown): ExportTarget[] => {
    const list = Array.isArray(v) ? v : String(v ?? "").split(",");
    return list
      .map((s) => String(s).trim())
      .filter((s): s is ExportTarget => (EXPORT_TARGETS as readonly string[]).includes(s));
  };
  const skipFor = (selected: Pkg[]): string[] => PKGS.filter((p) => !selected.includes(p));
  /** Map Export UI chips → export-all --skip + --cms-parts. */
  const exportAllFlags = (selected: ExportTarget[]): { skip: string[]; cmsParts: string } => {
    const skip: string[] = [];
    if (!selected.includes("file-manager")) skip.push("file-manager");
    if (!selected.includes("page-builder")) skip.push("page-builder");
    if (!selected.includes("redirects")) skip.push("redirects");
    const wantModels = selected.includes("cms-models");
    const wantEntries = selected.includes("cms-entries");
    // resolveCmsParts treats cms-models / cms-entries skips independently — skip both
    // when neither chip is selected (otherwise --cms-parts both still exports models).
    if (!wantModels) skip.push("cms-models");
    if (!wantEntries) skip.push("cms-entries");
    const cmsParts =
      wantModels && wantEntries ? "both" : wantModels ? "models" : wantEntries ? "entries" : "both";
    return { skip, cmsParts };
  };
  // Resolve a user-supplied export dir to an existing path strictly inside the
  // repo (no traversal). Returns the absolute path or null.
  const safeDir = (input: unknown): string | null => {
    const s = String(input ?? "").trim();
    if (!s) return null;
    const resolved = path.resolve(opts.root, s);
    const root = path.resolve(opts.root);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : null;
  };

  const app = express();
  app.use(express.json());

  app.get("/", (_req: Request, res: Response) => { res.type("html").send(PAGE); });

  // Brand logo — served from the repo so the page stays asset-self-contained
  // without inlining the binary.
  const logoFile = path.join(opts.root, "src", "shared", "img", "Kibo-Icon-Black.png");
  app.get("/logo.png", (_req: Request, res: Response) => {
    if (!fs.existsSync(logoFile)) return res.status(404).end();
    res.type("png").sendFile(logoFile);
  });

  app.get("/api/env", (_req: Request, res: Response) => {
    res.json({
      source: { url: process.env["SOURCE_MANAGE_URL"] || process.env["SOURCE_ADMIN_GQL_URL"] || "", tenant: process.env["SOURCE_TENANT"] || "root" },
      target: { url: process.env["TARGET_MANAGE_URL"] || process.env["TARGET_ADMIN_GQL_URL"] || "", tenant: process.env["TARGET_TENANT"] || "root" },
      hasSchema: !!opts.schemaFile,
    });
  });

  // ── Export: selectively export artifacts from source → a server folder ────────
  app.post("/api/export", (req: Request, res: Response) => {
    const sourceTenant = tenantOf(req.body?.sourceTenant, process.env["SOURCE_TENANT"] ?? "root");
    if (!sourceTenant) return res.status(400).json({ error: "Invalid source tenant id" });
    // Accept new chips (cms-models / cms-entries) or legacy package names (cms-entries = both).
    let selected = exportTargetsOf(req.body?.types);
    if (!selected.length) {
      const legacy = pkgsOf(req.body?.types);
      selected = legacy.flatMap((p) =>
        p === "cms-entries" ? (["cms-models", "cms-entries"] as ExportTarget[]) : [p as ExportTarget]
      );
    }
    if (selected.length === 0) return res.status(400).json({ error: "Select at least one artifact type." });
    const models = String(req.body?.models ?? "").trim();
    if (models && !/^[A-Za-z0-9 ,_-]+$/.test(models)) return res.status(400).json({ error: "Invalid models filter" });
    const maxFileSize = String(req.body?.maxFileSize ?? "").trim();
    if (maxFileSize && !/^\d+$/.test(maxFileSize)) return res.status(400).json({ error: "Invalid max file size" });

    const selectedIds = Array.isArray(req.body?.selectedIds)
      ? (req.body.selectedIds as unknown[]).map(String).filter(Boolean)
      : [];
    const omittedDepIds = Array.isArray(req.body?.omittedDepIds)
      ? (req.body.omittedDepIds as unknown[]).map(String).filter(Boolean)
      : [];

    // One timestamped folder per export so imports can pick a specific snapshot.
    // Use an ABSOLUTE --out: export-all / export-selected forward paths to each
    // package, which spawn with their own cwd — relative paths would scatter.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outRel = path.posix.join("export", `exp-${sourceTenant}-${stamp}`);
    const outAbs = path.join(exportBase, `exp-${sourceTenant}-${stamp}`);

    // ── Selective: catalog → hydrate → export-selected closure ───────────────
    if (selectedIds.length) {
      let filterPath: string | null = null;
      if (req.body?.filters) {
        try {
          const validated = validateFilterSpec(req.body.filters);
          if (isFilterActive(validated)) {
            const spec = freezeFilterSpec(validated);
            filterPath = path.join(opts.root, ".catalog-tmp", `ui-export-filter-${Date.now()}.json`);
            writeFilterSpec(filterPath, spec);
          }
        } catch (e) {
          return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
      }

      const catalogOut = catalogFor("source");
      const CAT_PKGS = ["file-manager", "cms-entries", "page-builder", "redirects"] as const;
      const want = new Set<string>();
      for (const t of selected) {
        if (t === "file-manager") want.add("file-manager");
        else if (t === "cms-models" || t === "cms-entries") want.add("cms-entries");
        else if (t === "page-builder") want.add("page-builder");
        else if (t === "redirects") want.add("redirects");
      }
      const skipCat = CAT_PKGS.filter((p) => !want.has(p));

      const { jobId } = startJob(
        opts.root,
        "export",
        async (run) => {
          const catArgs = ["catalog-all", "--env", "source", "--out", catalogOut];
          if (skipCat.length) catArgs.push("--skip", skipCat.join(","));
          if (opts.schemaFile) catArgs.push("--schema-file", opts.schemaFile);
          else if (models) catArgs.push("--models", models);
          if (filterPath) catArgs.push("--filter", filterPath);
          run.logLine(`Building catalog for selective export (${selectedIds.length} id(s))…`);
          const cr = await cli(
            catArgs,
            { SOURCE_TENANT: sourceTenant, KIBO_RUN_ID: run.meta.runId },
            (line) => run.logLine(line)
          );
          if (cr.status !== 0) throw new Error(`catalog-all exited ${cr.status}`);

          const t = writeIdsTmp(selectedIds);
          let cleanup = t.cleanup;
          const args = [
            "export-selected",
            "--catalog", catalogOut,
            "--select", `@${t.file}`,
            "--out", outAbs,
          ];
          if (omittedDepIds.length) {
            const ot = writeIdsTmp(omittedDepIds);
            const prev = cleanup;
            cleanup = () => { ot.cleanup(); prev(); };
            args.push("--omit-deps", `@${ot.file}`);
          }
          if (opts.schemaFile) args.push("--schema-file", opts.schemaFile);
          if (req.body?.withBinaries) args.push("--with-binaries");
          if (maxFileSize) args.push("--max-file-size", maxFileSize);
          if (req.body?.allowMissingDeps) args.push("--allow-missing-deps");
          try {
            run.logLine(`Selective export → ${outRel}`);
            const r = await cli(
              args,
              { SOURCE_TENANT: sourceTenant, KIBO_RUN_ID: run.meta.runId },
              (line) => run.logLine(line)
            );
            if (r.status !== 0) throw new Error(`export-selected exited ${r.status}`);
          } finally {
            cleanup();
          }
        },
        { sourceTenant, argsSummary: `export-selected (${selectedIds.length} ids)` }
      );
      return res.json({ jobId, dir: outRel, types: selected, selective: true });
    }

    // ── Whole-type: export-all (unchanged when nothing is selected) ──────────
    const { skip, cmsParts } = exportAllFlags(selected);
    const args = ["export-all", "--out", outAbs, "--cms-parts", cmsParts];
    if (skip.length) args.push("--skip", skip.join(","));
    if (opts.schemaFile) args.push("--schema-file", opts.schemaFile);
    else if (models) args.push("--models", models);
    if (req.body?.continueOnError) args.push("--continue-on-error");
    if (req.body?.withBinaries) args.push("--with-binaries");
    if (maxFileSize) args.push("--max-file-size", maxFileSize);

    if (req.body?.filters) {
      try {
        const validated = validateFilterSpec(req.body.filters);
        // Freeze only when active — empty/custom-without-dates must not throw.
        if (isFilterActive(validated)) {
          const spec = freezeFilterSpec(validated);
          const filterPath = path.join(opts.root, ".catalog-tmp", `ui-export-filter-${Date.now()}.json`);
          writeFilterSpec(filterPath, spec);
          args.push("--filter", filterPath);
        }
      } catch (e) {
        return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }

    const { jobId } = startJob(
      opts.root,
      "export",
      async (run) => {
        const r = await cli(
          args,
          { SOURCE_TENANT: sourceTenant, KIBO_RUN_ID: run.meta.runId },
          (line) => run.logLine(line)
        );
        if (r.status !== 0) throw new Error(`export-all exited ${r.status}`);
      },
      { sourceTenant, argsSummary: args.join(" ") }
    );
    res.json({ jobId, dir: outRel, types: selected });
  });

  // Live job stream (SSE) + snapshot
  app.get("/api/jobs/:id", (req: Request, res: Response) => {
    const snap = getJob(String(req.params.id));
    if (!snap) return res.status(404).json({ error: "Job not found" });
    res.json(snap);
  });

  app.get("/api/jobs/:id/stream", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const snap = getJob(id);
    if (!snap) return res.status(404).json({ error: "Job not found" });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    for (const line of snap.lines) send({ type: "log", line });
    if (snap.progress) send({ type: "progress", ...snap.progress });
    if (snap.status !== "running") {
      send({ type: "done", meta: snap.meta });
      return res.end();
    }
    const unsub = subscribeJob(id, {
      onLog: (line) => send({ type: "log", line }),
      onProgress: (p) => send({ type: "progress", ...p }),
      onDone: (meta) => {
        send({ type: "done", meta });
        unsub();
        res.end();
      },
    });
    req.on("close", () => unsub());
  });

  app.get("/api/logs", (req: Request, res: Response) => {
    const ws = req.query.workstream ? String(req.query.workstream) as Workstream : undefined;
    const logsRoot = defaultLogsRoot(opts.root);
    res.json(listWorkstreamRuns(logsRoot, ws && ["export", "import", "migrate", "purge"].includes(ws) ? ws : undefined));
  });

  app.get("/api/logs/:workstream/:id", (req: Request, res: Response) => {
    const ws = String(req.params.workstream) as Workstream;
    if (!["export", "import", "migrate", "purge"].includes(ws)) return res.status(400).json({ error: "Invalid workstream" });
    const dir = path.join(defaultLogsRoot(opts.root), ws, String(req.params.id));
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Log run not found" });
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    const consoleLog = fs.existsSync(path.join(dir, "console.log"))
      ? fs.readFileSync(path.join(dir, "console.log"), "utf-8")
      : "";
    res.json({ meta, console: consoleLog });
  });

  // List previously exported folders (those holding any artifact sub-dir).
  // Hide Migrate/diag scratch dirs — those belong under .migrate-tmp/, not here.
  const EXPORT_LIST_SKIP = /^(migrate-|run-|_diag)/i;
  app.get("/api/exports", (_req: Request, res: Response) => {
    let dirs: Array<{ dir: string; mtime: string; types: string[] }> = [];
    if (fs.existsSync(exportBase)) {
      dirs = fs.readdirSync(exportBase)
        .filter((name) => !EXPORT_LIST_SKIP.test(name))
        .map((name) => path.join(exportBase, name))
        .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
        .map((p) => ({
          dir: path.posix.join("export", path.basename(p)),
          mtime: fs.statSync(p).mtime.toISOString(),
          types: listExportArtifactLabels(p),
        }))
        .filter((d) => d.types.length > 0)
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
    }
    res.json(dirs);
  });

  // ── Import: import a chosen server folder → target tenant ─────────────────────
  app.post("/api/import", (req: Request, res: Response) => {
    const targetTenant = tenantOf(req.body?.targetTenant, process.env["TARGET_TENANT"] ?? "root");
    if (!targetTenant) return res.status(400).json({ error: "Invalid target tenant id" });
    const dir = safeDir(req.body?.dir);
    if (!dir) return res.status(400).json({ error: "Invalid or missing export folder" });
    // Selection drives the run: empty ids → import everything in the folder;
    // selected ids → planImportSelection (models-only or items + deps).
    const rawIds = Array.isArray(req.body?.selectedIds) ? (req.body.selectedIds as unknown[]).map(String) : [];
    const omittedDepIds = Array.isArray(req.body?.omittedDepIds)
      ? (req.body.omittedDepIds as unknown[]).map(String).filter(Boolean)
      : [];
    let cleanup: (() => void) | null = null;

    const maxFileSizeIm = String(req.body?.maxFileSize ?? "").trim();
    if (maxFileSizeIm && !/^\d+$/.test(maxFileSizeIm)) return res.status(400).json({ error: "Invalid max file size" });

    const { jobId } = startJob(
      opts.root,
      "import",
      async (run) => {
        try {
          const plan = await planImportSelection(dir, rawIds);
          const itemIds =
            plan.mode === "items"
              ? (omittedDepIds.length
                  ? stripOmittedIds(plan.ids, omittedDepIds)
                  : plan.ids)
              : [];
          if (plan.mode === "items" && omittedDepIds.length) {
            run.logLine(`Omitting ${omittedDepIds.length} intentionally unchecked dep(s).`);
          }
          let r: { status: number; output: string };
          const cmsDir = path.join(dir, "cms");
          const hasModelsJson = fs.existsSync(path.join(cmsDir, "models.json"));

          if (plan.mode === "models-only") {
            // Schema only — prefer cms/models.json (offline); else live source provision.
            const t = writeIdsTmp(plan.modelIds);
            cleanup = t.cleanup;
            run.logLine(
              hasModelsJson
                ? `Content Models only (${plan.modelIds.length}) — import from models.json (no entries).`
                : `Content Models only (${plan.modelIds.length}) — live provision from source (no models.json; no entries).`
            );
            const args = ["provision-models", "--select", `@${t.file}`];
            if (hasModelsJson) args.push("--in", cmsDir);
            r = await cli(
              args,
              { SOURCE_TENANT: process.env["SOURCE_TENANT"], TARGET_TENANT: targetTenant, KIBO_RUN_ID: run.meta.runId },
              (line) => run.logLine(line)
            );
            if (r.status !== 0) throw new Error(`provision-models exited ${r.status}`);
            return;
          }

          // Import-all (no selection): packages from what's on disk; offline models first.
          // Selective: packages from dependency-resolved plan (Migrate-style).
          const packages: Pkg[] =
            plan.mode === "items" && plan.packages.length
              ? plan.packages
              : packagesInExport(dir);

          if (plan.mode === "all" && hasModelsJson) {
            let modelIds: string[] = [];
            try {
              const j = JSON.parse(fs.readFileSync(path.join(cmsDir, "models.json"), "utf-8")) as {
                models?: Array<{ modelId?: string }>;
              };
              modelIds = (j.models ?? []).map((m) => String(m.modelId ?? "").trim()).filter(Boolean);
            } catch { /* ignore */ }
            if (modelIds.length) {
              // Dry-run: skip live provision — import-all --dry-run covers models via import-models.
              if (req.body?.dryRun) {
                run.logLine(
                  `Content Models (${modelIds.length}) — dry-run: deferred to import-all --dry-run (no provision-models write).`
                );
              } else {
                run.logLine(`Content Models (${modelIds.length}) — import from models.json before entries/files.`);
                const t = writeIdsTmp(modelIds);
                const prevCleanup = cleanup;
                cleanup = () => { t.cleanup(); if (prevCleanup) prevCleanup(); };
                const mr = await cli(
                  ["provision-models", "--select", `@${t.file}`, "--in", cmsDir],
                  { SOURCE_TENANT: process.env["SOURCE_TENANT"], TARGET_TENANT: targetTenant, KIBO_RUN_ID: run.meta.runId },
                  (line) => run.logLine(line)
                );
                if (mr.status !== 0) throw new Error(`provision-models exited ${mr.status}`);
              }
            }
          }

          if (!packages.length) {
            if (plan.mode === "all" && hasModelsJson) return; // models-only export, already done
            throw new Error("Nothing to import in this export folder.");
          }

          const args = ["import-all", "--in", dir];
          const skip = skipFor(packages);
          if (skip.length) args.push("--skip", skip.join(","));
          if (req.body?.dryRun) args.push("--dry-run");
          if (req.body?.allowFolderMismatch) args.push("--allow-folder-mismatch");
          if (req.body?.allowSchemaMismatch) args.push("--allow-schema-mismatch");
          if (req.body?.continueOnError) args.push("--continue-on-error");
          if (req.body?.manifestOnly) args.push("--manifest-only");
          else if (req.body?.streamBinaries) args.push("--stream-binaries");
          else if (req.body?.uploadBinaries) args.push("--upload-binaries");
          if (maxFileSizeIm) args.push("--max-file-size", maxFileSizeIm);
          // Default as-draft on; only pass --no-as-draft when explicitly false.
          if (req.body?.asDraft === false) args.push("--no-as-draft");

          if (plan.mode === "items") {
            if (plan.addedByDependencies.length) {
              run.logLine(
                `Dependencies: +${plan.addedByDependencies.length} item(s) pulled in (models/files/refs).`
              );
            }
            run.logLine(`Packages: ${packages.join(", ")}`);
            const t = writeIdsTmp(itemIds);
            cleanup = t.cleanup;
            args.push("--select", `@${t.file}`);
          } else {
            run.logLine(`Import all — packages: ${packages.join(", ")}`);
          }
          r = await cli(
            args,
            { TARGET_TENANT: targetTenant, KIBO_RUN_ID: run.meta.runId },
            (line) => run.logLine(line)
          );
          if (r.status !== 0) throw new Error(`import-all exited ${r.status}`);
        } finally {
          if (cleanup) cleanup();
          try {
            const rp = path.resolve(dir);
            const base = path.resolve(importTmpBase);
            if (rp === base || rp.startsWith(base + path.sep)) fs.rmSync(rp, { recursive: true, force: true });
          } catch { /* best-effort */ }
        }
      },
      { targetTenant, argsSummary: rawIds.length ? `import (selective ${rawIds.length} ids)` : "import-all (from export contents)" }
    );
    res.json({ jobId });
  });

  // Read a chosen export folder's contents into a selectable catalog (from disk,
  // no API) so the UI can let the user import a subset — same dependsOn graph as Migrate.
  app.get("/api/import/contents", async (req: Request, res: Response) => {
    try {
      const dir = safeDir(req.query?.dir);
      if (!dir) return res.status(400).json({ error: "Invalid or missing export folder" });
      const catalog = await buildImportCatalog(dir);
      res.json({ sections: catalog.sections });
    } catch (e) {
      res.status(500).json({ error: "Failed to read export contents: " + (e instanceof Error ? e.message : String(e)) });
    }
  });

  // Sweep temp extractions older than 6h (best-effort; keeps disk from filling).
  const sweepImportTmp = () => {
    try {
      if (!fs.existsSync(importTmpBase)) return;
      const cutoff = Date.now() - 6 * 3600 * 1000;
      for (const name of fs.readdirSync(importTmpBase)) {
        const p = path.join(importTmpBase, name);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  };

  // Upload a zipped export from the browser (raw application/zip body), extract
  // to a repo-local temp dir, and return that dir for the normal import flow.
  app.post("/api/import/upload", (req: Request, res: Response) => {
    const ct = String(req.headers["content-type"] || "");
    if (!/zip/i.test(ct)) return res.status(400).json({ error: "Upload must be a .zip archive (content-type application/zip)" });
    sweepImportTmp();
    fs.mkdirSync(importTmpBase, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zipPath = path.join(importTmpBase, `up-${stamp}.zip`);
    const destDir = path.join(importTmpBase, `up-${stamp}`);
    const out = fs.createWriteStream(zipPath);

    req.pipe(out);
    out.on("error", () => res.status(500).json({ error: "Failed to receive upload" }));
    out.on("finish", () => {
      try {
        const zip = new AdmZip(zipPath);
        fs.mkdirSync(destDir, { recursive: true });
        for (const entry of zip.getEntries()) {
          const target = safeZipEntryPath(destDir, entry.entryName);
          if (!target) continue; // zip-slip: skip entries that escape destDir
          if (entry.isDirectory) { fs.mkdirSync(target, { recursive: true }); continue; }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, entry.getData());
        }
        fs.rmSync(zipPath, { force: true });
        res.json({ dir: destDir });
      } catch (e) {
        res.status(400).json({ error: "Not a valid zip archive: " + (e instanceof Error ? e.message : String(e)) });
      }
    });
  });

  // ── Catalog build — env=source (Migrate) or target (Purge) ────────────────────
  app.post("/api/catalog/build", async (req: Request, res: Response) => {
    const env = req.body?.env === "target" ? "target" : "source";
    // For source we inject SOURCE_TENANT; for target we inject TARGET_TENANT but
    // tell catalog-all to read the "target" environment.
    const tenantKey = env === "target" ? "TARGET_TENANT" : "SOURCE_TENANT";
    const tenant = tenantOf(env === "target" ? req.body?.targetTenant : req.body?.sourceTenant, process.env[tenantKey] ?? "root");
    if (!tenant) return res.status(400).json({ error: `Invalid ${env} tenant id` });
    const out = catalogFor(env);
    const args = ["catalog-all", "--env", env, "--out", out];
    if (opts.schemaFile) args.push("--schema-file", opts.schemaFile);
    // Optional type chips from Migrate UI → --skip the rest (same packages as catalog-all).
    const CAT_PKGS = ["file-manager", "cms-entries", "page-builder", "redirects"] as const;
    const rawTypes = Array.isArray(req.body?.types) ? (req.body.types as unknown[]).map(String) : [];
    if (rawTypes.length) {
      const want = new Set<string>();
      for (const t of rawTypes) {
        if (t === "file-manager" || t === "file") want.add("file-manager");
        else if (t === "cms-entries" || t === "cms-models" || t === "cms-entry" || t === "model") want.add("cms-entries");
        else if (t === "page-builder" || t === "page") want.add("page-builder");
        else if (t === "redirects" || t === "redirect") want.add("redirects");
      }
      const skip = CAT_PKGS.filter((p) => !want.has(p));
      if (skip.length === CAT_PKGS.length) {
        return res.status(400).json({ error: "Select at least one artifact type" });
      }
      if (skip.length) args.push("--skip", skip.join(","));
    }
    const modelsFilter =
      typeof req.body?.models === "string" ? req.body.models.trim() : "";
    if (modelsFilter) args.push("--models", modelsFilter);
    if (req.body?.filters) {
      try {
        const validated = validateFilterSpec(req.body.filters);
        if (isFilterActive(validated)) {
          const spec = freezeFilterSpec(validated);
          const filterPath = path.join(opts.root, ".catalog-tmp", `ui-catalog-filter-${Date.now()}.json`);
          writeFilterSpec(filterPath, spec);
          args.push("--filter", filterPath);
        }
      } catch (e) {
        return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }
    const r = await cli(args, { [tenantKey]: tenant });
    if (r.status !== 0) {
      const tail = (r.output || "").trim().slice(-2500);
      return res.status(500).json({
        error: "catalog build failed",
        detail: tail || "catalog-all exited with a non-zero status",
        output: r.output,
      });
    }
    const catalog = loadCatalogFile(out);
    if (!catalog) {
      return res.status(500).json({ error: "catalog build produced no catalog file", detail: out });
    }
    // Optional client refine after load (name/status on already-fetched rows).
    if (req.body?.refine && catalog && req.body?.filters) {
      try {
        const validated = validateFilterSpec(req.body.filters);
        if (isFilterActive(validated)) {
          const spec = freezeFilterSpec(validated);
          for (const sec of catalog.sections) {
            sec.items = sec.items.filter((it) => matchCatalogItem(it, spec, { full: true }));
            sec.total = sec.items.length;
          }
        }
      } catch { /* ignore refine errors — catalog already built */ }
    }
    res.json(catalog);
  });

  app.get("/api/catalog", (_req: Request, res: Response) => {
    const c = loadCatalog();
    return c ? res.json(c) : res.status(404).json({ error: "No catalog yet." });
  });

  app.post("/api/plan", (req: Request, res: Response) => {
    const c = loadCatalog();
    if (!c) return res.status(404).json({ error: "No catalog." });
    res.json(planMigration(c, (req.body?.selectedIds as string[]) ?? []));
  });

  app.post("/api/migrate", (req: Request, res: Response) => {
    const sourceTenant = tenantOf(req.body?.sourceTenant, process.env["SOURCE_TENANT"] ?? "root");
    const targetTenant = tenantOf(req.body?.targetTenant, process.env["TARGET_TENANT"] ?? "root");
    if (!sourceTenant || !targetTenant) return res.status(400).json({ error: "Invalid tenant id" });
    const resume = req.body?.resume ? String(req.body.resume) : "";
    if (resume && !RUNID_RE.test(resume)) return res.status(400).json({ error: "Invalid run id" });

    const ids = resume ? [] : ((req.body?.selectedIds as string[]) ?? []);
    if (!resume && !ids.length) return res.status(400).json({ error: "No ids selected." });
    const dryRun = !!req.body?.dryRun;

    let cleanup: (() => void) | null = null;
    const args: string[] = ["migrate"];
    if (resume) {
      args.push("--resume", resume);
    } else {
      const t = writeIdsTmp(ids);
      cleanup = t.cleanup;
      args.push("--catalog", opts.catalogPath, "--select", `@${t.file}`);
    }
    if (opts.schemaFile) args.push("--schema-file", opts.schemaFile);
    if (dryRun) args.push("--dry-run");
    if (req.body?.skipExport) args.push("--skip-export");
    if (req.body?.allowSchemaMismatch) args.push("--allow-schema-mismatch");
    if (req.body?.allowFolderMismatch) args.push("--allow-folder-mismatch");
    if (req.body?.allowMissingDeps) args.push("--allow-missing-deps");
    if (req.body?.continueOnError) args.push("--continue-on-error");
    if (req.body?.asDraft === false) args.push("--no-as-draft");
    const omitDeps = Array.isArray(req.body?.omittedDepIds)
      ? (req.body.omittedDepIds as string[]).filter((x) => typeof x === "string" && x)
      : [];
    let omitCleanup: (() => void) | null = null;
    if (omitDeps.length && !resume) {
      const ot = writeIdsTmp(omitDeps);
      omitCleanup = ot.cleanup;
      args.push("--omit-deps", `@${ot.file}`);
    }
    const maxFileSizeCp = String(req.body?.maxFileSize ?? "").trim();
    if (maxFileSizeCp && !/^\d+$/.test(maxFileSizeCp)) return res.status(400).json({ error: "Invalid max file size" });
    if (maxFileSizeCp) args.push("--max-file-size", maxFileSizeCp);

    // Dry-run: still async job, but also return a plan preview immediately.
    if (dryRun && !resume) {
      const c = loadCatalog();
      const plan = c ? planMigration(c, ids) : null;
      const preview = plan
        ? plan.steps.flatMap((s) => s.ids.map((id) => ({ type: s.type, id, status: "skipped", action: "would migrate" })))
        : [];
      const { jobId } = startJob(
        opts.root,
        "migrate",
        async (run) => {
          try {
            const r = await cli(
              args,
              { SOURCE_TENANT: sourceTenant, TARGET_TENANT: targetTenant, KIBO_RUN_ID: run.meta.runId },
              (line) => run.logLine(line)
            );
            if (r.status !== 0) throw new Error(`migrate exited ${r.status}`);
          } finally {
            if (cleanup) cleanup();
            if (omitCleanup) omitCleanup();
          }
        },
        { sourceTenant, targetTenant, argsSummary: "migrate --dry-run" }
      );
      return res.json({ jobId, dryRun: true, preview });
    }

    const { jobId } = startJob(
      opts.root,
      "migrate",
      async (run) => {
        try {
          const r = await cli(
            args,
            { SOURCE_TENANT: sourceTenant, TARGET_TENANT: targetTenant, KIBO_RUN_ID: run.meta.runId },
            (line) => run.logLine(line)
          );
          if (r.status !== 0) throw new Error(`migrate exited ${r.status}`);
        } finally {
          if (cleanup) cleanup();
          if (omitCleanup) omitCleanup();
        }
      },
      { sourceTenant, targetTenant, argsSummary: args.join(" ") }
    );
    res.json({ jobId });
  });

  // ── Purge: delete selected artifacts on the target (dry-run unless confirm) ────
  app.post("/api/purge", (req: Request, res: Response) => {
    const targetTenant = tenantOf(req.body?.targetTenant, process.env["TARGET_TENANT"] ?? "root");
    if (!targetTenant) return res.status(400).json({ error: "Invalid target tenant id" });
    const allowSameTenant = !!req.body?.allowSameTenant;
    // Same-tenant guard (mirror the CLI) — never purge the source tenant by accident.
    if (!allowSameTenant && (process.env["SOURCE_TENANT"] ?? "") === targetTenant) {
      return res.status(400).json({ error: `Refusing to purge: target tenant ${targetTenant} equals SOURCE_TENANT. Enable "allow same tenant" only if you truly mean it.` });
    }
    const ids: string[] = Array.isArray(req.body?.selectedIds) ? (req.body.selectedIds as unknown[]).map(String) : [];
    if (!ids.length) return res.status(400).json({ error: "Select at least one item to purge." });

    // Map selected ids → type (+ model for cms) from the last-built target catalog.
    const cat = loadCatalogFile(targetCatalogFile);
    if (!cat) return res.status(400).json({ error: "No target catalog — load the target first." });
    const meta = new Map<string, { type: string; model?: string }>();
    for (const s of cat.sections) for (const it of s.items) {
      meta.set(it.id, { type: s.type, model: (it.metadata as { model?: string } | undefined)?.model });
    }
    const idSet = new Set(ids);
    const byType = new Map<string, { ids: string[]; models: Set<string> }>();
    for (const id of idSet) {
      const m = meta.get(id);
      if (!m) continue;
      const g = byType.get(m.type) ?? { ids: [], models: new Set<string>() };
      g.ids.push(id);
      if (m.model) g.models.add(m.model);
      byType.set(m.type, g);
    }
    if (byType.size === 0) return res.status(400).json({ error: "Selected ids not found in the target catalog — reload the target." });

    const confirm = req.body?.confirm === true;
    const permanent = !!req.body?.permanent;

    // Flatten selection into one ids file; root `purge` groups by type from the catalog.
    const allIds = [...idSet];
    const t = writeIdsTmp(allIds);
    const args = ["purge", "--catalog", targetCatalogFile, "--select", `@${t.file}`];
    if (confirm) args.push("--force");
    if (permanent) args.push("--permanent");
    if (allowSameTenant) args.push("--allow-same-tenant");

    const { jobId } = startJob(
      opts.root,
      "purge",
      async (run) => {
        try {
          const r = await cli(
            args,
            { TARGET_TENANT: targetTenant, KIBO_RUN_ID: run.meta.runId },
            (line) => run.logLine(line)
          );
          if (r.status !== 0) throw new Error(`purge exited ${r.status}`);
        } finally {
          t.cleanup();
        }
      },
      { targetTenant, argsSummary: `purge ${allIds.length} ids` }
    );
    const sections: Array<{ type: string; pkg: string; count: number; exitCode: number | null; output: string }> = [];
    for (const [type, g] of byType) {
      const pkg = PKG_FOR[type];
      if (pkg) sections.push({ type, pkg, count: g.ids.length, exitCode: null, output: "(streaming — see job console)" });
    }
    res.json({ jobId, dryRun: !confirm, permanent, sections });
  });

  const legacyRunsDir = path.join(opts.root, ".runs");
  const ledgerFallbacks = workstreamLedgerDirs(defaultLogsRoot(opts.root), [legacyRunsDir])
    .filter((d) => path.resolve(d) !== path.resolve(runsDir));

  app.get("/api/metrics", (_req: Request, res: Response) => {
    res.json(aggregateMetrics(listRuns(runsDir, ledgerFallbacks)));
  });

  app.get("/api/runs", (_req: Request, res: Response) => {
    res.json(listRuns(runsDir, ledgerFallbacks).map((rn) => ({ id: rn.id, status: rn.status, createdAt: rn.createdAt, environment: rn.environment, summary: runSummary(rn) })));
  });

  app.get("/api/runs/:id", (req: Request, res: Response) => {
    if (!RUNID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid run id" });
    try {
      res.json(loadRunWithFallback(runsDir, req.params.id, ledgerFallbacks));
    } catch { res.status(404).json({ error: "Run not found" }); }
  });

  app.listen(opts.port, () => {
    console.log(`\n  Kibo CMS Import/Export Utility (Express) → http://localhost:${opts.port}`);
    console.log(`  Catalog: ${opts.catalogPath}   Exports: export/   Runs: ${path.relative(opts.root, runsDir)}/`);
    console.log("  Ctrl+C to stop.\n");
  });
}

// ── Embedded single-page UI — Kibo design system (light + dark) ─────────────────
// Self-contained (no assets/CDN/build). Inside this template literal the embedded
// JS avoids backticks and ${...}.
const PAGE = `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kibo CMS Import Export Utility</title>
<style>
  :root{
    --bg:#F4F6F9; --surface:#FFFFFF; --surface2:#EAEDF2; --line:#DCE1E8; --line2:#C4CCD6;
    --ink:#2E343E; --muted:#5A6470; --faint:#8C95A1;
    --brand:#FFCE01; --brand-hover:#F0BF00; --brand-ink:#2B2B2B;
    --src:#1E88A8; --tgt:#9A7400;
    --green:#1F9D6B; --green-bg:#E4F6EE; --red:#D6453D; --red-bg:#FBE9E8;
    --shadow:0 1px 2px rgba(46,52,62,.06),0 4px 14px -6px rgba(46,52,62,.12);
    --shadow-lg:0 8px 30px -10px rgba(46,52,62,.22);
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
    --r:10px; --r-sm:7px;
  }
  html[data-theme="dark"]{
    --bg:#16191D; --surface:#23272E; --surface2:#1C2025; --line:#343B45; --line2:#444C58;
    --ink:#ECEFF3; --muted:#9AA5B1; --faint:#697079;
    --brand:#FFCE01; --brand-hover:#FFD633; --brand-ink:#2B2B2B;
    --src:#4FC3E0; --tgt:#FFCE01;
    --green:#3DDC91; --green-bg:rgba(61,220,145,.12); --red:#FF6B6B; --red-bg:rgba(255,107,107,.12);
    --shadow:0 1px 2px rgba(0,0,0,.4); --shadow-lg:0 10px 34px -12px rgba(0,0,0,.6);
  }
  *{box-sizing:border-box}html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;transition:background .25s,color .25s}
  ::selection{background:var(--brand);color:var(--brand-ink)}
  *::-webkit-scrollbar{width:10px;height:10px}*::-webkit-scrollbar-thumb{background:var(--line2);border-radius:6px}*::-webkit-scrollbar-track{background:transparent}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  .mono{font-family:var(--mono)}

  /* header */
  header{display:flex;align-items:center;gap:14px;padding:0 20px;height:60px;background:var(--surface);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:30}
  .menu{display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);color:var(--muted);cursor:pointer;transition:.18s}
  .menu:hover{color:var(--ink);border-color:var(--line2)}
  .brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:15px;letter-spacing:.01em}
  .logo{width:32px;height:32px;flex:none;object-fit:contain;background:#fff;border-radius:7px;padding:2px}
  .brand .sub{color:var(--muted);font-weight:500}
  .spacer{flex:1}
  .route{display:flex;align-items:center;gap:10px}
  .node{display:flex;flex-direction:column;line-height:1.25;border:1px solid var(--line);border-radius:var(--r-sm);padding:5px 11px;background:var(--surface2)}
  .node .k{font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
  .node .v{font-size:14px;font-weight:700;font-family:var(--mono)}
  .node.src .v{color:var(--src)}.node.tgt .v{color:var(--tgt)}
  .icbtn{display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);color:var(--muted);cursor:pointer;transition:.18s}
  .icbtn:hover{color:var(--ink);border-color:var(--line2)}
  svg{display:block}

  /* layout: sidebar + main */
  .app{display:flex;height:calc(100vh - 60px)}
  .side{width:212px;flex:none;background:var(--surface);border-right:1px solid var(--line);padding:14px 10px;display:flex;flex-direction:column;gap:5px;transition:width .2s;overflow:hidden}
  body.collapsed .side{width:62px}
  .navi{display:flex;align-items:center;gap:13px;padding:11px 12px;border-radius:var(--r-sm);color:var(--muted);cursor:pointer;font-weight:600;font-size:13px;border:1px solid transparent;white-space:nowrap}
  .navi:hover{background:var(--surface2);color:var(--ink)}
  .navi.on{background:color-mix(in srgb,var(--brand) 16%,transparent);color:var(--ink);border-color:color-mix(in srgb,var(--brand) 55%,transparent)}
  .navi svg{flex:none}
  body.collapsed .navi .lab{display:none}
  .side .grp{font-size:9.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);padding:8px 12px 4px}
  body.collapsed .side .grp{visibility:hidden}
  main{flex:1;overflow:auto}
  .wrap{max-width:1100px;margin:0 auto;padding:26px 26px 90px}
  .view{display:none;animation:fade .3s ease}.view.on{display:block}
  @keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1}}
  .vh{font-size:18px;font-weight:800;letter-spacing:.01em;color:var(--ink);margin:0 0 4px;display:flex;align-items:center;gap:10px}
  .vsub{color:var(--muted);font-size:13px;margin:0 0 22px}
  .vsub b{color:var(--ink);font-family:var(--mono)}
  .hint{color:var(--muted);font-size:12.5px;margin:0 0 18px;padding:9px 13px;border-left:3px solid var(--brand);background:var(--surface2);border-radius:0 var(--r-sm) var(--r-sm) 0}
  /* Staged workspaces (Export / Migrate / Purge): Discover → Select → Run */
  .flow-guide,.ex-guide{list-style:none;margin:0 0 22px;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;max-width:920px}
  .flow-guide li,.ex-guide li{margin:0;padding:12px 14px;background:var(--surface2);border:1px solid var(--line);border-radius:var(--r-sm);font-size:12.5px;line-height:1.45;color:var(--muted)}
  .flow-guide li b,.ex-guide li b{display:block;color:var(--ink);font-size:12px;font-weight:700;letter-spacing:.02em;margin-bottom:4px}
  .flow-stage,.ex-stage{margin:0 0 22px;padding:18px 18px 16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
  .flow-stage-h,.ex-stage-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;font-weight:700;color:var(--ink);margin:0 0 6px}
  .flow-stage-h .muted,.ex-stage-h .muted{font-weight:500}
  .flow-stage-n,.ex-stage-n{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--brand);color:var(--brand-ink);font-size:11px;font-weight:800;flex:0 0 auto}
  .flow-stage-sub,.ex-stage-sub{margin:0 0 14px;font-size:12.5px;line-height:1.45;color:var(--muted);max-width:720px}
  .flow-stage-sub .dep-auto,.ex-stage-sub .dep-auto{margin-left:2px;vertical-align:middle}
  .flow-stage .card,.ex-stage .card{margin-bottom:4px}
  .flow-stage .actions,.ex-stage .actions{margin-top:14px}
  .flow-stage .toolbar,.ex-stage .toolbar{margin:4px 0 0}
  .flow-mode,.ex-mode{display:flex;flex-direction:column;gap:4px;margin:0 0 14px;padding:12px 14px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--surface2)}
  .flow-mode.on-sel,.ex-mode.on-sel{border-color:color-mix(in srgb,var(--brand) 55%,var(--line));background:color-mix(in srgb,var(--brand) 10%,var(--surface2))}
  .flow-mode.warn{border-color:color-mix(in srgb,var(--red) 45%,var(--line));background:color-mix(in srgb,var(--red) 8%,var(--surface2))}
  .flow-mode-lab,.ex-mode-lab{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .flow-mode.on-sel .flow-mode-lab,.flow-mode.warn .flow-mode-lab,.ex-mode.on-sel .ex-mode-lab{color:var(--ink)}
  .flow-mode-desc,.ex-mode-desc{font-size:12.5px;line-height:1.45;color:var(--muted)}
  .flow-mode.on-sel .flow-mode-desc,.flow-mode.warn .flow-mode-desc,.ex-mode.on-sel .ex-mode-desc{color:var(--ink)}
  @media (max-width:820px){.flow-guide,.ex-guide{grid-template-columns:1fr}}

  /* buttons + fields */
  .btn{font-family:var(--sans);font-size:13px;font-weight:600;background:var(--surface);color:var(--ink);border:1px solid var(--line2);border-radius:var(--r-sm);padding:10px 18px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:.15s}
  .btn:hover{border-color:var(--ink)}
  .btn.primary{background:var(--brand);color:var(--brand-ink);border-color:var(--brand)}
  .btn.primary:hover{background:var(--brand-hover);border-color:var(--brand-hover)}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn:focus-visible,.icbtn:focus-visible,.menu:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
  .actions{display:flex;gap:12px;align-items:center;margin-top:22px;flex-wrap:wrap}
  .upl{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .link{color:var(--muted);font-size:12.5px;cursor:pointer;background:none;border:0;font-family:var(--sans)}
  .link:hover{color:var(--red)}
  label.fl{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--muted);display:block;margin-bottom:7px}
  input.txt,select.txt{width:100%;background:var(--bg);border:1px solid var(--line2);border-radius:var(--r-sm);color:var(--ink);font-family:var(--mono);font-size:14px;padding:10px 12px;outline:none;transition:.15s}
  input.big{font-size:19px;font-weight:700}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:20px;box-shadow:var(--shadow)}
  .card.src{border-top:3px solid var(--src)}.card.tgt{border-top:3px solid var(--brand)}
  .role{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
  .card.src .role{color:var(--src)}.card.tgt .role{color:var(--tgt)}
  .url{font-size:11.5px;color:var(--muted);margin:6px 0 16px;word-break:break-all;font-family:var(--mono);min-height:18px}

  /* artifact-type chips */
  .types{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 4px}
  .chip{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;border:1px solid var(--line2);border-radius:var(--r-sm);padding:10px 14px;background:var(--surface);transition:.12s;user-select:none}
  .chip:hover{border-color:var(--ink)}
  .chip.on{color:var(--ink);border-color:var(--brand);background:color-mix(in srgb,var(--brand) 11%,transparent)}
  .chip .cb{appearance:none;width:16px;height:16px;border:1.5px solid var(--line2);border-radius:5px;background:var(--surface);position:relative;cursor:pointer}
  .chip.on .cb{background:var(--brand);border-color:var(--brand)}
  .chip.on .cb::after{content:"";position:absolute;left:5px;top:1px;width:4px;height:8px;border:solid var(--brand-ink);border-width:0 2px 2px 0;transform:rotate(45deg)}

  /* toggles */
  .toolbar{display:flex;align-items:center;gap:12px;margin:18px 0;flex-wrap:wrap}
  /* Shared hover/focus tip balloon (toggles, max-file-size, action buttons) */
  .has-tip{position:relative}
  .has-tip > .tip{display:none;position:absolute;left:0;bottom:calc(100% + 8px);z-index:30;width:min(280px,70vw);padding:10px 12px;border-radius:var(--r-sm);background:#2E343E;color:#F4F6F9;font-size:12px;font-weight:500;line-height:1.45;white-space:normal;text-align:left;box-shadow:0 8px 24px rgba(0,0,0,.22);pointer-events:none}
  .has-tip > .tip b{color:var(--brand);font-weight:700}
  .has-tip > .tip::after{content:"";position:absolute;left:18px;top:100%;border:6px solid transparent;border-top-color:#2E343E}
  .has-tip:hover > .tip,.has-tip:focus-within > .tip{display:block}
  .field-inline{display:inline-flex;align-items:center;gap:8px;flex:0 0 auto;white-space:nowrap;border:1px solid var(--line);border-radius:var(--r-sm);padding:7px 12px;background:var(--surface);cursor:help}
  .field-inline label{font-size:12px;font-weight:600;color:var(--muted);margin:0;display:inline;cursor:help}
  .field-inline input.txt{width:64px;padding:5px 8px;font-size:13px;flex:0 0 auto}
  .field-inline .unit{font-size:11.5px;font-weight:600;color:var(--faint);font-family:var(--mono)}
  .tg{display:inline-flex;align-items:center;gap:9px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;border:1px solid var(--line);border-radius:var(--r-sm);padding:9px 13px;background:var(--surface)}
  .tg input{appearance:none;width:30px;height:16px;border-radius:99px;background:var(--line2);position:relative;cursor:pointer;outline:none;transition:.18s;flex:0 0 auto}
  .tg input:checked{background:var(--brand)}.tg input::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:.18s}
  .tg input:checked::after{left:16px}.tg.on{color:var(--ink)}
  .btn.has-tip{position:relative}
  .filt{margin:14px 0 4px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel);max-width:760px}
  .filt summary{cursor:pointer;font-weight:600;font-size:13px;list-style:none;display:flex;align-items:center;gap:10px;user-select:none}
  .filt summary::-webkit-details-marker{display:none}
  .filt-chev{flex:0 0 auto;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);color:var(--muted);transition:transform .15s ease,background .15s ease,color .15s ease}
  .filt-chev svg{display:block}
  .filt summary:hover .filt-chev{border-color:var(--line2);color:var(--ink);background:var(--panel)}
  .filt[open] .filt-chev{transform:rotate(180deg);color:var(--ink);border-color:var(--brand);background:color-mix(in srgb,var(--brand) 12%,var(--surface))}
  .filt-sum-lab{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .filt-stack{display:flex;flex-direction:column;gap:10px;margin-top:14px}
  .filt-stack[hidden]{display:none}
  .filt-row{border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);padding:11px 14px}
  .filt-enable-lab{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:600;cursor:pointer;user-select:none;margin:0}
  .filt-enable-lab input.filt-enable{appearance:none;width:16px;height:16px;margin:0;border:1.5px solid var(--line2);border-radius:5px;background:var(--surface);position:relative;cursor:pointer;flex:0 0 auto}
  .filt-enable-lab input.filt-enable:checked{background:var(--brand);border-color:var(--brand)}
  .filt-enable-lab input.filt-enable:checked::after{content:"";position:absolute;left:4px;top:0;width:4px;height:8px;border:solid var(--brand-ink);border-width:0 2px 2px 0;transform:rotate(45deg)}
  .filt-body{margin-top:11px;padding-top:11px;border-top:1px solid var(--line)}
  .filt-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}
  .filt-fields .span2{grid-column:1/-1}
  .filt-fields .fl{margin:0 0 4px}
  .filt-empty{margin:12px 0 0;font-size:12.5px}
  .filt-err{margin:10px 0 0;font-size:12.5px;color:var(--red)}
  .filt input[type="date"],.filt input[type="datetime-local"],.filt select.txt,
  .filterbar input[type="date"],.filterbar input[type="datetime-local"]{
    min-height:38px;width:100%;max-width:100%;box-sizing:border-box;color-scheme:light dark
  }
  [data-theme="dark"] .filt input[type="date"],[data-theme="dark"] .filt input[type="datetime-local"],
  [data-theme="dark"] .filterbar input[type="date"],[data-theme="dark"] .filterbar input[type="datetime-local"]{color-scheme:dark}
  .filterbar .f input[type="datetime-local"]{min-width:210px}
  .filt-tz-hint{font-size:11px;color:var(--muted);margin:4px 0 0;line-height:1.35}
  @media(max-width:640px){.filt-fields{grid-template-columns:1fr}}
  .filt-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
  .badge-src{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.02em;padding:3px 8px;border-radius:999px;background:rgba(46,184,122,.14);color:#1a7a4c}
  [data-theme="dark"] .badge-src{background:rgba(46,184,122,.22);color:#7ddea8}
  .badge-mix{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:rgba(255,206,1,.18);color:#7a6200}

  /* catalog */
  .bay{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);margin-bottom:14px;box-shadow:var(--shadow);overflow:hidden}
  .bay-h{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line);cursor:pointer}
  .tag{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:99px;border:1px solid}
  .tag.file{color:var(--src);border-color:var(--src);background:color-mix(in srgb,var(--src) 10%,transparent)}
  .tag.cms-entry{color:var(--tgt);border-color:var(--brand);background:color-mix(in srgb,var(--brand) 14%,transparent)}
  .tag.page{color:var(--green);border-color:var(--green);background:var(--green-bg)}
  .tag.redirect{color:#9A4DB8;border-color:#9A4DB8;background:color-mix(in srgb,#9A4DB8 10%,transparent)}
  .tag.model{color:var(--ink);border-color:var(--line2);background:var(--surface2)}
  .bay-h .nm{font-weight:600}.bay-h .ct{margin-left:auto;color:var(--muted);font-family:var(--mono);font-size:12px}
  .selall{font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:var(--r-sm);padding:5px 10px;cursor:pointer}
  .selall:hover{color:var(--src);border-color:var(--line2)}
  .rows{max-height:280px;overflow:auto}
  .note{padding:11px 16px;color:var(--red);font-size:12.5px;background:var(--red-bg)}
  .row{display:grid;grid-template-columns:20px 1fr auto;gap:12px;align-items:start;padding:9px 16px;border-bottom:1px solid var(--line)}
  .row:last-child{border-bottom:0}.row:hover{background:var(--surface2)}.row.sel{background:color-mix(in srgb,var(--brand) 9%,transparent)}
  .cb2{appearance:none;width:17px;height:17px;margin:1px 0 0;border:1.5px solid var(--line2);border-radius:5px;background:var(--surface);cursor:pointer;position:relative;transition:.12s}
  .cb2:hover{border-color:var(--brand)}.cb2:checked{background:var(--brand);border-color:var(--brand)}
  .cb2:checked::after{content:"";position:absolute;left:5px;top:1.5px;width:4px;height:8px;border:solid var(--brand-ink);border-width:0 2px 2px 0;transform:rotate(45deg)}
  .cb2:indeterminate{background:var(--brand);border-color:var(--brand)}
  .cb2:indeterminate::after{content:"";position:absolute;left:3px;top:6.5px;width:8px;height:0;border-top:2px solid var(--brand-ink)}
  .dep{font-size:10px;font-weight:600;color:var(--src);border:1px solid var(--line);border-radius:99px;padding:2px 8px;white-space:nowrap}
  .dep-auto{font-size:10px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 8px;white-space:nowrap;margin-left:6px}
  tr.trow.auto-dep td.cName .sub{color:var(--muted)}
  /* catalog table */
  .ctab{width:100%;border-collapse:collapse;font-size:12.5px}
  .ctab th{text-align:left;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);font-weight:700;padding:8px 10px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface);z-index:1;white-space:nowrap}
  .ctab td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  .ctab tr:last-child td{border-bottom:0}
  .ctab .cbx{width:34px}
  .trow{cursor:pointer}.trow:hover{background:var(--surface2)}.trow.sel{background:color-mix(in srgb,var(--brand) 9%,transparent)}
  .ctab .cName{font-weight:500;max-width:220px;overflow:hidden;text-overflow:ellipsis}
  .ctab .cName .sub{color:var(--faint);font-size:10.5px;font-family:var(--mono);margin-top:2px;font-weight:400}
  .ctab .path{font-family:var(--mono);color:var(--src);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ctab .dt{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
  .ctab .num{font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .ctab th{border-right:1px solid var(--line)}
  .ctab th.srt{cursor:pointer;user-select:none}
  .ctab th.srt:hover{color:var(--muted)}
  .ctab th.srt .ar::after{content:"↕";margin-left:5px;font-size:9px;opacity:.4}
  .ctab th.asc .ar::after{content:"▲";opacity:1;color:var(--brand)}
  .ctab th.desc .ar::after{content:"▼";opacity:1;color:var(--brand)}
  .ctab th .rsz{position:absolute;top:0;right:-1px;width:7px;height:100%;cursor:col-resize;border-right:2px solid transparent}
  .ctab th .rsz:hover{border-right-color:var(--brand)}
  .emptyrow{padding:12px 16px;font-size:12.5px;font-style:italic}
  .s3note{padding:11px 14px;margin:10px 0;border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:0 var(--r-sm) var(--r-sm) 0;background:var(--surface2);font-size:12.5px}
  .lv{font-size:9.5px;font-weight:700;letter-spacing:.03em;padding:2px 8px;border-radius:99px;border:1px solid var(--line2);color:var(--faint)}
  .lv.on{color:var(--green);border-color:var(--green);background:var(--green-bg)}

  /* progress + runs + logs */
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
  .bar{height:10px;background:var(--surface2);border-radius:99px;overflow:hidden;margin:6px 0 18px}
  .bar i{display:block;height:100%;background:var(--green);width:0;border-radius:99px;transition:width .6s cubic-bezier(.2,.7,.2,1)}
  .bar i.err{background:var(--red)}
  .pgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px}
  .stat{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:16px 18px;box-shadow:var(--shadow)}
  .stat .n{font-size:30px;font-weight:800;line-height:1;font-family:var(--mono)}
  .stat .u{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-top:7px}
  .stat.ok .n{color:var(--green)}.stat.err .n{color:var(--red)}.stat.tot .n{color:var(--ink)}
  .items{max-height:330px;overflow:auto}
  .lg-fold{margin:14px 0 0;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);box-shadow:var(--shadow);overflow:hidden}
  .lg-fold>summary{cursor:pointer;font-weight:600;font-size:13px;list-style:none;display:flex;align-items:center;gap:10px;user-select:none;padding:12px 14px;color:var(--ink);background:var(--panel)}
  .lg-fold>summary::-webkit-details-marker{display:none}
  .lg-fold[open]>summary{border-bottom:1px solid var(--line)}
  .lg-fold>summary:hover .filt-chev{border-color:var(--line2);color:var(--ink);background:var(--surface)}
  .lg-fold[open] .filt-chev{transform:rotate(180deg);color:var(--ink);border-color:var(--brand);background:color-mix(in srgb,var(--brand) 12%,var(--surface))}
  .lg-fold .panel{border:0;border-radius:0;box-shadow:none}
  .lg-console{margin:0;overflow:hidden}
  .lg-console pre.console{margin:0;max-height:280px;overflow:auto;white-space:pre-wrap;padding:12px;font-size:12px;border:0;border-radius:0;background:var(--surface2)}
  .lg-fold .items{max-height:330px}
  .it{display:flex;align-items:center;gap:11px;padding:9px 15px;border-bottom:1px solid var(--line);font-size:13px}
  .it:last-child{border-bottom:0}.it .m{width:18px;height:18px;display:grid;place-items:center;border-radius:50%;flex:none}
  .it.ok .m{background:var(--green-bg);color:var(--green)}.it.err .m{background:var(--red-bg);color:var(--red)}.it.skip .m{color:var(--faint)}
  .it .id{color:var(--muted);font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .it .act{margin-left:auto;color:var(--faint);font-size:11px;font-weight:600;text-transform:uppercase;white-space:nowrap}
  details{margin-top:18px}summary{cursor:pointer;color:var(--muted);font-size:12px;font-weight:600}
  pre{background:var(--surface2);border:1px solid var(--line);border-radius:var(--r-sm);padding:13px;font-family:var(--mono);font-size:12px;color:var(--ink);white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;margin-top:10px}
  .runrow{display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid var(--line);border-radius:var(--r-sm);margin-bottom:8px;cursor:pointer;background:var(--surface);transition:.12s}
  .runrow:hover{border-color:var(--line2);box-shadow:var(--shadow)}
  .pill{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:99px;border:1px solid}
  .pill.complete{color:var(--green);border-color:var(--green);background:var(--green-bg)}
  .pill.failed{color:var(--red);border-color:var(--red);background:var(--red-bg)}
  .pill.in-progress{color:var(--tgt);border-color:var(--brand);background:color-mix(in srgb,var(--brand) 14%,transparent)}
  .muted{color:var(--muted)}.faint{color:var(--faint)}
  .glitch{color:var(--red);padding:16px;border:1px solid var(--red);border-radius:var(--r-sm);background:var(--red-bg)}
  .spin{width:14px;height:14px;border:2px solid var(--line2);border-top-color:var(--brand);border-radius:50%;animation:sp .7s linear infinite;display:inline-block;vertical-align:-3px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .sectt{font-size:12px;font-weight:700;color:var(--ink);margin:28px 0 13px}
  .filterbar{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px}
  .filterbar .f{display:flex;flex-direction:column}
  .ok-msg{color:var(--green);font-weight:600}
  .btn.danger{background:var(--red);color:#fff;border-color:var(--red)}.btn.danger:hover{filter:brightness(1.05)}.btn.danger:disabled{opacity:.5}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:grid;place-items:center;z-index:100;padding:16px}
  .modal-box{background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--red);border-radius:var(--r);padding:22px;max-width:480px;width:92%;box-shadow:var(--shadow-lg)}
  .modal-box.warn{border-top-color:var(--brand)}
  .modal-h{font-size:15px;font-weight:800;color:var(--red);margin-bottom:10px}
  .modal-box.warn .modal-h{color:var(--ink)}
  .modal-body{font-size:13px;color:var(--ink);margin-bottom:16px;line-height:1.55}
  .modal-body b{font-family:var(--mono)}
  .modal-body .warn-list{margin:10px 0 0;padding-left:18px}
  .modal-body .warn-list li{margin:4px 0}
  .modal-foot{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px}

  /* import wizard */
  .wiz-steps{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 22px;padding:4px;background:var(--surface2);border:1px solid var(--line);border-radius:var(--r);max-width:720px}
  .wiz-step{flex:1;min-width:110px;font-family:var(--sans);font-size:12px;font-weight:700;color:var(--faint);background:transparent;border:1px solid transparent;border-radius:var(--r-sm);padding:10px 12px;cursor:default;text-align:left;transition:.12s}
  .wiz-step .n{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;border:1.5px solid var(--line2);font-size:11px;margin-right:8px;vertical-align:middle}
  .wiz-step.on{color:var(--ink);background:var(--surface);border-color:var(--brand);box-shadow:var(--shadow);cursor:default}
  .wiz-step.on .n{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
  .wiz-step.done{color:var(--ink);cursor:pointer}
  .wiz-step.done:hover{border-color:var(--line2);background:var(--surface)}
  .wiz-step.done .n{border-color:var(--green);color:var(--green)}
  .wiz-step:disabled{opacity:.45;cursor:not-allowed}
  .wiz-panel{display:none;animation:fade .25s ease}
  .wiz-panel.on{display:block}
  .seg{display:inline-flex;gap:4px;padding:4px;background:var(--surface2);border:1px solid var(--line);border-radius:var(--r-sm);margin-bottom:16px}
  .seg-btn{font-family:var(--sans);font-size:12.5px;font-weight:600;color:var(--muted);background:transparent;border:1px solid transparent;border-radius:6px;padding:9px 16px;cursor:pointer}
  .seg-btn.on{color:var(--ink);background:var(--surface);border-color:var(--brand)}
  .dropzone{border:2px dashed var(--line2);border-radius:var(--r);padding:36px 20px;text-align:center;background:var(--surface);cursor:pointer;transition:.15s;max-width:560px}
  .dropzone:hover,.dropzone.drag{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 8%,transparent)}
  .dropzone .dz-t{font-weight:700;font-size:14px;margin:0 0 6px}
  .dropzone .dz-s{color:var(--muted);font-size:12.5px;margin:0}
  .exlist{display:flex;flex-direction:column;gap:8px;max-width:640px;max-height:360px;overflow:auto;margin-top:12px}
  .excard{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);cursor:pointer;text-align:left;width:100%;font-family:var(--sans);color:var(--ink);transition:.12s}
  .excard:hover{border-color:var(--line2);box-shadow:var(--shadow)}
  .excard.on{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 10%,transparent)}
  .excard .ex-name{font-weight:700;font-size:13px;font-family:var(--mono)}
  .excard .ex-meta{font-size:11.5px;color:var(--muted);margin-top:3px}
  .excard .ex-types{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
  .exchip{font-size:10px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:2px 7px;border-radius:99px;border:1px solid var(--line2);color:var(--muted)}
  .review{max-width:640px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;box-shadow:var(--shadow)}
  .review dl{display:grid;grid-template-columns:140px 1fr;gap:10px 14px;margin:0;font-size:13px}
  .review dt{color:var(--muted);font-weight:600}.review dd{margin:0;font-family:var(--mono);word-break:break-all}
  .ws-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}
  .ws-chip{font-family:var(--sans);font-size:12px;font-weight:600;color:var(--muted);background:var(--surface);border:1px solid var(--line2);border-radius:var(--r-sm);padding:8px 12px;cursor:pointer}
  .ws-chip.on{color:var(--ink);border-color:var(--brand);background:color-mix(in srgb,var(--brand) 11%,transparent)}
  .ws-badge{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:99px;border:1px solid var(--line2);color:var(--muted);background:var(--surface2);flex:none}
  .ws-badge.export{color:var(--src);border-color:var(--src)}
  .ws-badge.import{color:var(--tgt);border-color:var(--brand)}
  .ws-badge.migrate{color:var(--green);border-color:var(--green)}
  .ws-badge.purge{color:var(--red);border-color:var(--red)}
  .ws-badge.ledger{color:var(--ink);border-color:var(--line2)}
  .lg-head{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;margin-bottom:14px;box-shadow:var(--shadow)}
  .lg-head .row1{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px}
  .lg-head .meta{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:14px}
  .lg-head .meta b{color:var(--ink);font-family:var(--mono);font-weight:600}
</style></head>
<body>
<header>
  <button class="menu" id="menuBtn" aria-label="Toggle navigation" title="Toggle navigation"></button>
  <div class="brand">
    <img class="logo" src="/logo.png" alt="Kibo">
    KIBO CMS <span class="sub">Import Export Utility</span>
  </div>
  <div class="spacer"></div>
  <div class="route" id="route" style="visibility:hidden">
    <div class="node src"><span class="k">Source</span><span class="v" id="rSrc">—</span></div>
    <span class="flow faint" id="flowIc"></span>
    <div class="node tgt"><span class="k">Target</span><span class="v" id="rTgt">—</span></div>
  </div>
  <button class="icbtn" id="theme" aria-label="Toggle light or dark theme" title="Toggle theme"></button>
</header>
<div class="app">
  <nav class="side" id="side">
    <div class="grp">Workspace</div>
    <div class="navi on" data-v="export" tabindex="0"><span id="ni-export"></span><span class="lab">Export</span></div>
    <div class="navi" data-v="import" tabindex="0"><span id="ni-import"></span><span class="lab">Import</span></div>
    <div class="navi" data-v="copy" tabindex="0"><span id="ni-copy"></span><span class="lab">Migrate</span></div>
    <div class="navi" data-v="purge" tabindex="0"><span id="ni-purge"></span><span class="lab">Purge</span></div>
    <div class="navi" data-v="logs" tabindex="0"><span id="ni-logs"></span><span class="lab">Logs</span></div>
  </nav>
  <main><div class="wrap">

    <!-- EXPORT -->
    <section class="view on" id="v-export">
      <p class="vh"><span id="h-export"></span>Export artifacts</p>
      <p class="vsub">Read from a source tenant into a folder on this machine. Nothing on the source is modified.</p>
      <ol class="ex-guide" aria-label="How export works">
        <li><b>1 · Discover</b> Types and filters narrow what you browse — not what deps can be included.</li>
        <li><b>2 · Select</b> Tick a page or entry; its files and content model are auto-checked even if Filters hid them.</li>
        <li><b>3 · Export</b> After the catalog loads: with ticks → Export selected; with none → Export all.</li>
      </ol>

      <div class="ex-stage" id="exStageDiscover">
        <div class="ex-stage-h"><span class="ex-stage-n" aria-hidden="true">1</span> Discover</div>
        <p class="ex-stage-sub">Choose artifact types and optional filters, then load the catalog. Select and Export appear after load.</p>
      <div class="card src" style="max-width:520px">
        <div class="role">Source · read-only</div><div class="url" id="exSrcUrl">—</div>
        <label class="fl" for="exTenant">Source tenant id</label>
        <input id="exTenant" class="txt big" spellcheck="false" aria-label="Source tenant id">
      </div>
      <div class="types" id="exTypes" style="margin-top:14px"></div>
      <details class="filt" id="exFilt">
        <summary>
          <span class="filt-chev" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
          <span class="filt-sum-lab">Filters <span class="muted" style="font-weight:400">(discovery only)</span> <span id="exFiltBadge" class="muted" style="font-weight:400"></span></span>
        </summary>
        <p class="muted filt-empty" id="exFiltEmpty">Select an artifact above to see filter options.</p>
        <p class="filt-err" id="exFiltErr" hidden></p>
        <div class="filt-stack" id="exFiltStack" hidden>
          <div class="filt-row" id="exFiltRow-model" data-artifact="model" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="exFiltOn-model"> Filter Content Models</label>
            <div class="filt-body" id="exFiltBody-model" hidden>
              <div class="filt-fields">
                <div class="span2 has-tip" id="exModelsWrap">
                  <label class="fl" for="exModels">Model names</label>
                  <input id="exModels" class="txt" spellcheck="false" placeholder="PromoBanner, Homepage Layout">
                  <span class="tip" role="tooltip">Limits which Content Models are exported, and narrows Content Entries to those models too. Add a value, or turn Filter off.</span>
                </div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="exFiltRow-cms-entry" data-artifact="cms-entry" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="exFiltOn-cms-entry"> Filter Content Entries</label>
            <div class="filt-body" id="exFiltBody-cms-entry" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="exDateField-cms-entry">Date field</label>
                  <select id="exDateField-cms-entry" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="exDatePreset-cms-entry">Date range</label>
                  <select id="exDatePreset-cms-entry" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="exTimezone-cms-entry">Timezone</label>
                  <select id="exTimezone-cms-entry" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="exDateCustom-cms-entry" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="exDateFrom-cms-entry">From</label><input id="exDateFrom-cms-entry" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="exDateTo-cms-entry">To</label><input id="exDateTo-cms-entry" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="span2 has-tip" id="exNameEntriesWrap">
                  <label class="fl" for="exNameEntries">Entry title contains</label>
                  <input id="exNameEntries" class="txt" spellcheck="false" placeholder="hero, banner">
                  <span class="tip" role="tooltip">Matches each model’s title field. Add a value, or turn Filter off.</span>
                </div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="exFiltRow-file" data-artifact="file" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="exFiltOn-file"> Filter Files</label>
            <div class="filt-body" id="exFiltBody-file" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="exDateField-file">Date field</label>
                  <select id="exDateField-file" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="exDatePreset-file">Date range</label>
                  <select id="exDatePreset-file" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="exTimezone-file">Timezone</label>
                  <select id="exTimezone-file" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="exDateCustom-file" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="exDateFrom-file">From</label><input id="exDateFrom-file" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="exDateTo-file">To</label><input id="exDateTo-file" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="has-tip"><label class="fl" for="exNameFiles">Name contains</label>
                  <input id="exNameFiles" class="txt" spellcheck="false" placeholder="logo, icon">
                  <span class="tip" role="tooltip">File name filter. Add a value, or turn Filter off.</span></div>
                <div><label class="fl" for="exTagsFiles">Tags</label>
                  <input id="exTagsFiles" class="txt" spellcheck="false" placeholder="hero, promo"></div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="exFiltRow-page" data-artifact="page" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="exFiltOn-page"> Filter Pages</label>
            <div class="filt-body" id="exFiltBody-page" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="exDateField-page">Date field</label>
                  <select id="exDateField-page" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="exDatePreset-page">Date range</label>
                  <select id="exDatePreset-page" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="exTimezone-page">Timezone</label>
                  <select id="exTimezone-page" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="exDateCustom-page" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="exDateFrom-page">From</label><input id="exDateFrom-page" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="exDateTo-page">To</label><input id="exDateTo-page" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="span2 has-tip"><label class="fl" for="exNamePages">Title / path contains</label>
                  <input id="exNamePages" class="txt" spellcheck="false" placeholder="/home, checkout">
                  <span class="tip" role="tooltip">Matches page title or path. Add a value, or turn Filter off.</span></div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="exFiltRow-redirect" data-artifact="redirect" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="exFiltOn-redirect"> Filter Redirects</label>
            <div class="filt-body" id="exFiltBody-redirect" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="exDateField-redirect">Date field</label>
                  <select id="exDateField-redirect" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="exDatePreset-redirect">Date range</label>
                  <select id="exDatePreset-redirect" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="exTimezone-redirect">Timezone</label>
                  <select id="exTimezone-redirect" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="exDateCustom-redirect" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="exDateFrom-redirect">From</label><input id="exDateFrom-redirect" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="exDateTo-redirect">To</label><input id="exDateTo-redirect" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="span2 has-tip"><label class="fl" for="exNameRedirects">From path contains</label>
                  <input id="exNameRedirects" class="txt" spellcheck="false" placeholder="/old, /legacy">
                  <span class="tip" role="tooltip">Matches the redirect “from” path. Add a value, or turn Filter off.</span></div>
              </div>
            </div>
          </div>
        </div>
        <div class="filt-actions" id="exFiltActions">
          <select id="exPresetSel" class="txt" style="max-width:180px" aria-label="Saved filter presets"></select>
          <button type="button" class="btn" id="exSavePreset">Save preset</button>
        </div>
      </details>
      <div class="actions">
        <button class="btn primary" id="exLoad">Load source catalog</button>
        <button class="btn" id="exReload" type="button" style="display:none">Reload with filters</button>
        <span id="exLoadMsg" class="muted"></span>
      </div>
      </div>

      <div class="ex-stage" id="exSelect" style="display:none">
        <div class="ex-stage-h"><span class="ex-stage-n" aria-hidden="true">2</span> Select items <span id="exSelN" class="muted" style="font-weight:400">(0 selected)</span></div>
        <p class="ex-stage-sub">Selecting a page or entry auto-includes its files and content model <span class="dep-auto">dep</span> — even when Filters hid them. Clear the selection to switch back to Export all.</p>
        <div id="exCatalog" class="muted">—</div>
      </div>

      <div class="ex-stage" id="exStageRun" style="display:none">
        <div class="ex-stage-h"><span class="ex-stage-n" aria-hidden="true">3</span> Export</div>
        <div class="ex-mode" id="exMode" aria-live="polite">
          <span class="ex-mode-lab" id="exModeLab">Export all</span>
          <span class="ex-mode-desc" id="exModeDesc">No items selected — exports every item of the types above (Filters apply).</span>
        </div>
      <div class="toolbar">
        <label class="tg on has-tip" id="tgExCont"><input type="checkbox" id="exCont" checked>continue on error<span class="tip" role="tooltip">If one artifact type fails (e.g. files “Not authorized”), keep exporting the rest. Off = stop at the first failure.</span></label>
        <label class="tg has-tip" id="tgExBin"><input type="checkbox" id="exBin">include binaries<span class="tip" role="tooltip">Also download file binaries into the export folder (resumable). File Manager only.</span></label>
        <span class="field-inline has-tip">
          <label for="exMaxMb">Max file size</label>
          <input id="exMaxMb" class="txt" inputmode="numeric" placeholder="0" aria-label="Maximum file size in megabytes; 0 means no limit">
          <span class="unit">MB</span>
          <span class="tip" role="tooltip">Skip downloading file binaries larger than this many megabytes. Use <b>0</b> or leave blank for no limit. Applies only when exporting File Manager binaries.</span>
        </span>
      </div>
      <div class="actions">
        <button class="btn primary" id="exGoSel" style="display:none">Export selected</button>
        <button class="btn primary" id="exGo">Export all</button>
        <button class="link" id="exClr" type="button" style="display:none">clear selection</button>
        <span id="exMsg" class="muted"></span>
      </div>
      <div id="exResult" style="display:none">
        <p class="sectt" style="margin-top:18px">Result</p>
        <div class="panel" style="padding:14px 16px;margin-bottom:10px"><span class="muted">Saved to</span> <b class="mono" id="exDir"></b></div>
        <details open><summary>Console output</summary><pre id="exOut"></pre></details>
      </div>
      </div>
    </section>

    <!-- IMPORT (guided wizard) -->
    <section class="view" id="v-import">
      <p class="vh"><span id="h-import"></span>Import</p>
      <p class="vsub">Bring a previously exported folder into a target tenant — pick a source, set options, choose items, then run.</p>
      <div class="wiz-steps" id="imSteps" role="navigation" aria-label="Import steps">
        <button type="button" class="wiz-step on" data-step="1" id="imStepTab1"><span class="n">1</span>Source</button>
        <button type="button" class="wiz-step" data-step="2" id="imStepTab2" disabled><span class="n">2</span>Target</button>
        <button type="button" class="wiz-step" data-step="3" id="imStepTab3" disabled><span class="n">3</span>Items</button>
        <button type="button" class="wiz-step" data-step="4" id="imStepTab4" disabled><span class="n">4</span>Run</button>
      </div>
      <input type="hidden" id="imDir" value="">

      <div class="wiz-panel on" id="imStep1">
        <p class="sectt" style="margin-top:0">Where is the export?</p>
        <div class="seg" id="imSrcMode" role="tablist">
          <button type="button" class="seg-btn on" data-mode="server" id="imModeServer">This server</button>
          <button type="button" class="seg-btn" data-mode="upload" id="imModeUpload">Upload zip</button>
        </div>
        <div id="imSrcServer">
          <div style="display:flex;gap:10px;align-items:flex-end;max-width:640px;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <label class="fl" for="imExportQ">Filter exports</label>
              <input id="imExportQ" class="txt" placeholder="Search by folder name…" spellcheck="false">
            </div>
            <button class="btn" type="button" id="imRefresh">Refresh</button>
          </div>
          <div id="imExportList" class="exlist"><span class="muted">Loading exports…</span></div>
        </div>
        <div id="imSrcUpload" style="display:none">
          <div class="dropzone" id="imDrop" tabindex="0" role="button" aria-label="Upload export zip">
            <p class="dz-t">Drop a .zip export here</p>
            <p class="dz-s">or click to browse — must contain cms/, files/, pages/, and/or redirects/</p>
          </div>
          <input type="file" id="imZip" accept=".zip,application/zip" hidden>
          <p id="imZipMsg" class="muted" style="margin-top:10px"></p>
        </div>
        <div class="actions">
          <button class="btn primary" type="button" id="imNext1" disabled>Continue</button>
          <span id="imSrcMsg" class="muted"></span>
        </div>
      </div>

      <div class="wiz-panel" id="imStep2">
        <div class="card tgt" style="max-width:520px">
          <div class="role">Target · destination</div><div class="url" id="imTgtUrl">—</div>
          <label class="fl" for="imTenant">Target tenant id</label>
          <input id="imTenant" class="txt big" spellcheck="false" aria-label="Target tenant id">
        </div>
        <p class="sectt">Options</p>
        <div class="toolbar">
          <label class="tg on has-tip" id="tgImDry"><input type="checkbox" id="imDry" checked>dry-run<span class="tip" role="tooltip">Preview only — runs the full import plan but writes nothing to the target. Turn off to actually import.</span></label>
          <label class="tg on has-tip" id="tgImAsDraft"><input type="checkbox" id="imAsDraft" checked>import as draft<span class="tip" role="tooltip">Land content entries and pages as draft revisions on the target. Turn off to publish after import only when the source artifact was published.</span></label>
          <label class="tg has-tip" id="tgImCont"><input type="checkbox" id="imCont">continue on error<span class="tip" role="tooltip">If one artifact type fails, keep importing the rest. Off = stop at the first failure.</span></label>
        </div>
        <details style="margin-top:8px;max-width:640px">
          <summary>Advanced options</summary>
          <div class="toolbar" style="margin-top:12px">
            <label class="tg has-tip" id="tgImFolder"><input type="checkbox" id="imFolder">allow folder mismatch<span class="tip" role="tooltip">Import even if a folder couldn’t be recreated on the target. Affected items land in the root folder instead of failing the import.</span></label>
            <label class="tg has-tip" id="tgImSchema"><input type="checkbox" id="imSchema">allow schema mismatch<span class="tip" role="tooltip">Import entries even when the target model’s fields differ from the source. Missing models are still auto-created. Existing models are never altered.</span></label>
            <label class="tg has-tip" id="tgImUpload"><input type="checkbox" id="imUpload">upload binaries (from folder)<span class="tip" role="tooltip">Upload binaries from the export folder’s <b>files/binaries/</b> cache to the target. File Manager only.</span></label>
            <label class="tg has-tip" id="tgImManifest"><input type="checkbox" id="imManifest">manifest only<span class="tip" role="tooltip">Don’t transfer any file bytes — emit an S3 copy manifest instead for manual <b>aws s3 cp</b>.</span></label>
            <span class="field-inline has-tip">
              <label for="imMaxMb">Max file size</label>
              <input id="imMaxMb" class="txt" inputmode="numeric" placeholder="0" aria-label="Maximum file size in megabytes; 0 means no limit">
              <span class="unit">MB</span>
              <span class="tip" role="tooltip">Skip transferring file binaries larger than this many megabytes. Oversized files are listed in the S3 copy manifest for manual copy. Use <b>0</b> or leave blank for no limit. File Manager only.</span>
            </span>
          </div>
        </details>
        <div class="actions">
          <button class="btn" type="button" id="imBack2">Back</button>
          <button class="btn primary" type="button" id="imNext2">Continue</button>
          <span id="imTgtMsg" class="muted"></span>
        </div>
      </div>

      <div class="wiz-panel" id="imStep3">
        <p class="sectt" style="margin-top:0">Items <span id="imSelN" class="muted" style="font-weight:400">(0 selected — import everything in this export)</span></p>
        <p class="hint">Select nothing to import the whole export. Select models only for schemas. Selecting an entry pulls in its content model and referenced files from <b>this export folder</b> (Export selected must have included them). Uncheck a required dep to get a warning.</p>
        <div id="imContents" class="muted">Choose a source first.</div>
        <div class="actions">
          <button class="btn" type="button" id="imBack3">Back</button>
          <button class="btn primary" type="button" id="imNext3">Continue</button>
          <span id="imItemsMsg" class="muted"></span>
        </div>
      </div>

      <div class="wiz-panel" id="imStep4">
        <p class="sectt" style="margin-top:0">Review &amp; run</p>
        <div class="review" id="imReview"></div>
        <div class="actions">
          <button class="btn" type="button" id="imBack4">Back</button>
          <button class="btn primary" type="button" id="imGo">Start import</button>
          <span id="imMsg" class="muted"></span>
        </div>
        <div id="imProgress" style="display:none">
          <p class="sectt">Result</p>
          <div class="panel" id="imBanner" style="padding:13px 16px;margin-bottom:10px"></div>
          <details open><summary>Console output</summary><pre id="imOut"></pre></details>
        </div>
      </div>
    </section>

    <!-- COPY -->
    <section class="view" id="v-copy">
      <p class="vh"><span id="h-copy"></span>Migrate source → target</p>
      <p class="vsub">Direct tenant-to-tenant migration: browse the source, pick components, migrate in dependency order.</p>
      <ol class="flow-guide" aria-label="How migrate works">
        <li><b>1 · Discover</b> Types and filters narrow what you browse — not what deps can be included.</li>
        <li><b>2 · Select</b> Tick a page or entry; its files and content model are auto-checked even if Filters hid them.</li>
        <li><b>3 · Migrate</b> After the catalog loads: run dry-run or real migrate for the selection (deps included).</li>
      </ol>

      <div class="flow-stage" id="cpStageDiscover">
        <div class="flow-stage-h"><span class="flow-stage-n" aria-hidden="true">1</span> Discover</div>
        <p class="flow-stage-sub">Set source and target, choose types and optional filters, then load the source catalog. Select and Migrate appear after load.</p>
      <div class="grid2" style="max-width:760px">
        <div class="card src"><div class="role">Source · read-only</div><div class="url" id="cpSrcUrl">—</div>
          <label class="fl" for="cpSrc">Source tenant id</label><input id="cpSrc" class="txt big" spellcheck="false"></div>
        <div class="card tgt"><div class="role">Target · destination</div><div class="url" id="cpTgtUrl">—</div>
          <label class="fl" for="cpTgt">Target tenant id</label><input id="cpTgt" class="txt big" spellcheck="false"></div>
      </div>
      <div class="types" id="cpTypes" style="margin-top:14px"></div>
      <details class="filt" id="cpFilt">
        <summary>
          <span class="filt-chev" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
          <span class="filt-sum-lab">Filters <span class="muted" style="font-weight:400">(discovery only)</span> <span id="cpFiltBadge" class="muted" style="font-weight:400"></span></span>
        </summary>
        <p class="muted filt-empty" id="cpFiltEmpty">Select an artifact above to see filter options.</p>
        <p class="filt-err" id="cpFiltErr" hidden></p>
        <div class="filt-stack" id="cpFiltStack" hidden>
          <div class="filt-row" id="cpFiltRow-model" data-artifact="model" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="cpFiltOn-model"> Filter Content Models</label>
            <div class="filt-body" id="cpFiltBody-model" hidden>
              <div class="filt-fields">
                <div class="span2 has-tip" id="cpModelsWrap">
                  <label class="fl" for="cpModels">Model names</label>
                  <input id="cpModels" class="txt" spellcheck="false" placeholder="PromoBanner, Homepage Layout">
                  <span class="tip" role="tooltip">Limits which Content Models appear in the catalog, and narrows Content Entries to those models too. Add a value, or turn Filter off.</span>
                </div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="cpFiltRow-cms-entry" data-artifact="cms-entry" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="cpFiltOn-cms-entry"> Filter Content Entries</label>
            <div class="filt-body" id="cpFiltBody-cms-entry" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="cpDateField-cms-entry">Date field</label>
                  <select id="cpDateField-cms-entry" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="cpDatePreset-cms-entry">Date range</label>
                  <select id="cpDatePreset-cms-entry" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="cpTimezone-cms-entry">Timezone</label>
                  <select id="cpTimezone-cms-entry" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="cpDateCustom-cms-entry" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="cpDateFrom-cms-entry">From</label><input id="cpDateFrom-cms-entry" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="cpDateTo-cms-entry">To</label><input id="cpDateTo-cms-entry" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="span2 has-tip" id="cpNameEntriesWrap">
                  <label class="fl" for="cpNameEntries">Entry title contains</label>
                  <input id="cpNameEntries" class="txt" spellcheck="false" placeholder="hero, banner">
                  <span class="tip" role="tooltip">Matches entry titles. Add a value, or turn Filter off.</span>
                </div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="cpFiltRow-file" data-artifact="file" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="cpFiltOn-file"> Filter Files</label>
            <div class="filt-body" id="cpFiltBody-file" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="cpDateField-file">Date field</label>
                  <select id="cpDateField-file" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="cpDatePreset-file">Date range</label>
                  <select id="cpDatePreset-file" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="cpTimezone-file">Timezone</label>
                  <select id="cpTimezone-file" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="cpDateCustom-file" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="cpDateFrom-file">From</label><input id="cpDateFrom-file" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="cpDateTo-file">To</label><input id="cpDateTo-file" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="has-tip"><label class="fl" for="cpNameFiles">Name contains</label>
                  <input id="cpNameFiles" class="txt" spellcheck="false" placeholder="logo, icon">
                  <span class="tip" role="tooltip">File name filter. Add a value, or turn Filter off.</span></div>
                <div><label class="fl" for="cpTagsFiles">Tags</label>
                  <input id="cpTagsFiles" class="txt" spellcheck="false" placeholder="hero, promo"></div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="cpFiltRow-page" data-artifact="page" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="cpFiltOn-page"> Filter Pages</label>
            <div class="filt-body" id="cpFiltBody-page" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="cpDateField-page">Date field</label>
                  <select id="cpDateField-page" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="cpDatePreset-page">Date range</label>
                  <select id="cpDatePreset-page" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="cpTimezone-page">Timezone</label>
                  <select id="cpTimezone-page" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="cpDateCustom-page" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="cpDateFrom-page">From</label><input id="cpDateFrom-page" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="cpDateTo-page">To</label><input id="cpDateTo-page" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="span2 has-tip"><label class="fl" for="cpNamePages">Title / path contains</label>
                  <input id="cpNamePages" class="txt" spellcheck="false" placeholder="/home, checkout">
                  <span class="tip" role="tooltip">Matches page title or path. Dependencies outside the filter can still be pulled in when you select an item.</span></div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="cpFiltRow-redirect" data-artifact="redirect" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="cpFiltOn-redirect"> Filter Redirects</label>
            <div class="filt-body" id="cpFiltBody-redirect" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="cpDateField-redirect">Date field</label>
                  <select id="cpDateField-redirect" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="cpDatePreset-redirect">Date range</label>
                  <select id="cpDatePreset-redirect" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="cpTimezone-redirect">Timezone</label>
                  <select id="cpTimezone-redirect" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="cpDateCustom-redirect" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="cpDateFrom-redirect">From</label><input id="cpDateFrom-redirect" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="cpDateTo-redirect">To</label><input id="cpDateTo-redirect" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="span2 has-tip"><label class="fl" for="cpNameRedirects">From path contains</label>
                  <input id="cpNameRedirects" class="txt" spellcheck="false" placeholder="/old, /legacy">
                  <span class="tip" role="tooltip">Matches the redirect “from” path. Add a value, or turn Filter off.</span></div>
              </div>
            </div>
          </div>
        </div>
        <div class="filt-actions" id="cpFiltActions">
          <select id="cpPresetSel" class="txt" style="max-width:180px" aria-label="Saved filter presets"></select>
          <button type="button" class="btn" id="cpSavePreset">Save preset</button>
        </div>
      </details>
      <div class="actions">
        <button class="btn primary" id="cpLoad">Load source catalog</button>
        <button class="btn" id="cpReload" type="button" style="display:none">Reload with filters</button>
        <button class="btn" id="cpNarrow" type="button" style="display:none" title="Filter the already-loaded catalog without calling the API">Narrow results</button>
        <span id="cpLoadMsg" class="muted"></span>
      </div>
      </div>

      <div class="flow-stage" id="cpSelect" style="display:none">
        <div class="flow-stage-h"><span class="flow-stage-n" aria-hidden="true">2</span> Select items <span id="cpSelN" class="muted" style="font-weight:400">(0 selected)</span></div>
        <p class="flow-stage-sub">Selecting a page or entry auto-includes its files and content model <span class="dep-auto">dep</span> — even when Filters hid them. Uncheck a required dep to get a warning.</p>
        <div id="cpCatalog" class="muted">—</div>
      </div>

      <div class="flow-stage" id="cpStageRun" style="display:none">
        <div class="flow-stage-h"><span class="flow-stage-n" aria-hidden="true">3</span> Migrate</div>
        <div class="flow-mode" id="cpMode" aria-live="polite">
          <span class="flow-mode-lab" id="cpModeLab">Ready</span>
          <span class="flow-mode-desc" id="cpModeDesc">Select at least one item above. Migration runs in dependency order (models → files → entries → pages → redirects).</span>
        </div>
        <div class="toolbar">
          <label class="tg on has-tip" id="tgCpDry"><input type="checkbox" id="cpDry" checked>dry-run<span class="tip" role="tooltip">Preview only — resolves the plan (with dependencies) but writes nothing to the target and records no run. Turn off to migrate for real.</span></label>
          <label class="tg on has-tip" id="tgCpAsDraft"><input type="checkbox" id="cpAsDraft" checked>import as draft<span class="tip" role="tooltip">Land content entries and pages as draft revisions on the target. Turn off to publish after migrate only when the source artifact was published.</span></label>
          <label class="tg has-tip" id="tgCpCont"><input type="checkbox" id="cpCont">continue on error<span class="tip" role="tooltip">If one artifact type fails, keep migrating the rest. Off = stop at the first failure (resume later).</span></label>
        </div>
        <details id="cpAdvanced" style="margin-top:8px;max-width:640px">
          <summary>Advanced options</summary>
          <div class="toolbar" style="margin-top:12px">
            <label class="tg has-tip" id="tgCpSkip"><input type="checkbox" id="cpSkip">skip-export (reuse last export)<span class="tip" role="tooltip">Reuse whatever is already in the staging folder instead of re-exporting from source. Faster, but risky if the folder is stale or wrong-tenant — leave <b>OFF</b> unless you just exported this exact selection.</span></label>
            <label class="tg has-tip" id="tgCpSchema"><input type="checkbox" id="cpSchema">allow schema mismatch<span class="tip" role="tooltip">Import entries even when the target model’s fields differ from the source (missing field or type change). Mismatched fields may fail; existing models are never altered.</span></label>
            <label class="tg has-tip" id="tgCpFolder"><input type="checkbox" id="cpFolder">allow folder mismatch<span class="tip" role="tooltip">Migrate even if a folder couldn’t be recreated on the target. Affected items land in the root folder instead of failing.</span></label>
            <span class="field-inline has-tip">
              <label for="cpMaxMb">Max file size</label>
              <input id="cpMaxMb" class="txt" inputmode="numeric" placeholder="0" aria-label="Maximum file size in megabytes; 0 means no limit">
              <span class="unit">MB</span>
              <span class="tip" role="tooltip">Skip transferring file binaries larger than this many megabytes during migrate. Use <b>0</b> or leave blank for no limit. File Manager only.</span>
            </span>
          </div>
        </details>
        <div class="actions">
          <button class="btn primary" id="cpGo">Start migration</button>
          <button class="link" id="cpClr">clear selection</button>
          <span id="cpGoMsg" class="muted"></span>
        </div>
        <div id="cpProgress" style="display:none">
          <p class="sectt" style="margin-top:18px">Progress</p>
          <div class="bar"><i id="cpBar"></i></div>
          <div class="pgrid">
            <div class="stat ok"><div class="n" id="cpOk">0</div><div class="u">Succeeded</div></div>
            <div class="stat err"><div class="n" id="cpErrN">0</div><div class="u">Failed</div></div>
            <div class="stat tot"><div class="n" id="cpTot">0</div><div class="u">Total</div></div>
          </div>
          <div id="cpS3"></div>
          <div class="panel items" id="cpItems"></div>
          <details><summary>Console output</summary><pre id="cpOut"></pre></details>
        </div>
      </div>
    </section>

    <!-- LOGS -->
    <section class="view" id="v-logs">
      <p class="vh"><span id="h-logs"></span>Logs &amp; history</p>
      <p class="vsub">Console history and per-item ledgers for Export, Import, Migrate, and Purge. Filter by workstream or search.</p>
      <div id="lgBrowse">
        <div class="ws-filters" id="lgWsFilters" role="tablist" aria-label="Workstream filter">
          <button type="button" class="ws-chip on" data-ws="all">All</button>
          <button type="button" class="ws-chip" data-ws="export">Export</button>
          <button type="button" class="ws-chip" data-ws="import">Import</button>
          <button type="button" class="ws-chip" data-ws="migrate">Migrate</button>
          <button type="button" class="ws-chip" data-ws="purge">Purge</button>
          <button type="button" class="ws-chip" data-ws="ledger" id="lgLedgerChip" style="display:none" title="Orphan per-item ledgers with no matching console run">Orphan ledgers</button>
        </div>
        <div class="filterbar">
          <div class="f" style="flex:1;min-width:200px"><label class="fl" for="lgQ">Search (id / status / tenant)</label><input id="lgQ" class="txt" placeholder="type to filter…"></div>
          <div class="f"><label class="fl" for="lgFrom">From</label><input id="lgFrom" class="txt" type="datetime-local" step="60"></div>
          <div class="f"><label class="fl" for="lgTo">To</label><input id="lgTo" class="txt" type="datetime-local" step="60"></div>
          <button class="btn" type="button" id="lgClear">Clear</button>
          <button class="btn" type="button" id="lgReload">Reload</button>
          <span class="muted" id="lgTzHint" style="font-size:11.5px;align-self:center"></span>
        </div>
        <div class="sectt" style="margin-top:6px">Summary <span id="lgMetHdr" class="muted" style="font-weight:400"></span></div>
        <div id="lgMetrics" class="muted"></div>
        <div class="sectt">Runs <span id="lgCount" class="muted" style="font-weight:400"></span></div>
        <div id="lgListWrap">
          <div id="lgRuns" class="muted">—</div>
        </div>
      </div>
      <div id="lgDetail" style="display:none">
        <div class="sectt"><button class="link" id="lgBack" type="button">← back to list</button></div>
        <div class="lg-head" id="lgHead"></div>
        <div id="lgBarWrap" class="bar"><i id="lgBar"></i></div>
        <div class="pgrid" id="lgStats">
          <div class="stat ok"><div class="n" id="lgOk">0</div><div class="u">Done</div></div>
          <div class="stat err"><div class="n" id="lgErr">0</div><div class="u">Error</div></div>
          <div class="stat tot"><div class="n" id="lgTot">0</div><div class="u">Total</div></div>
        </div>
        <details class="lg-fold" id="lgLedgerFold" open style="display:none">
          <summary>
            <span class="filt-chev" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
            <span class="filt-sum-lab">Ledger <span id="lgItemsHdr" class="muted" style="font-weight:400"></span></span>
          </summary>
          <div class="panel items" id="lgItems"></div>
        </details>
        <details class="lg-fold" id="lgConsoleFold" open style="display:none">
          <summary>
            <span class="filt-chev" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
            <span class="filt-sum-lab">Console</span>
          </summary>
          <div id="lgConsolePanel" class="panel lg-console"></div>
        </details>
      </div>
    </section>

    <!-- PURGE -->
    <section class="view" id="v-purge">
      <p class="vh"><span id="h-purge"></span>Purge target tenant</p>
      <p class="vsub">Delete selected artifacts <b>on the target</b>. Preview first; deletion needs an explicit typed confirmation. Entries &amp; pages soft-delete to Trash unless permanent.</p>
      <ol class="flow-guide" aria-label="How purge works">
        <li><b>1 · Discover</b> Load the <b>target</b> catalog — types and filters narrow what you browse.</li>
        <li><b>2 · Select</b> Tick what to delete. A Content Model selection means all of that model’s entries.</li>
        <li><b>3 · Purge</b> After the catalog loads: Preview (dry-run), then Delete with typed confirmation.</li>
      </ol>

      <div class="flow-stage" id="pgStageDiscover">
        <div class="flow-stage-h"><span class="flow-stage-n" aria-hidden="true">1</span> Discover</div>
        <p class="flow-stage-sub">Set the target tenant, choose types and optional filters, then load the target catalog. Select and Purge appear after load.</p>
      <div class="card tgt" style="max-width:520px">
        <div class="role">Target · destructive</div><div class="url" id="pgTgtUrl">—</div>
        <label class="fl" for="pgTenant">Target tenant id</label>
        <input id="pgTenant" class="txt big" spellcheck="false" aria-label="Target tenant id">
      </div>
      <div class="types" id="pgTypes" style="margin-top:14px"></div>
      <details class="filt" id="pgFilt">
        <summary>
          <span class="filt-chev" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
          <span class="filt-sum-lab">Filters <span class="muted" style="font-weight:400">(discovery only)</span> <span id="pgFiltBadge" class="muted" style="font-weight:400"></span></span>
        </summary>
        <p class="muted filt-empty" id="pgFiltEmpty">Select an artifact above to see filter options.</p>
        <p class="filt-err" id="pgFiltErr" hidden></p>
        <div class="filt-stack" id="pgFiltStack" hidden>
          <div class="filt-row" id="pgFiltRow-model" data-artifact="model" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="pgFiltOn-model"> Filter Content Models</label>
            <div class="filt-body" id="pgFiltBody-model" hidden>
              <div class="filt-fields">
                <div class="span2 has-tip" id="pgModelsWrap">
                  <label class="fl" for="pgModels">Model names</label>
                  <input id="pgModels" class="txt" spellcheck="false" placeholder="PromoBanner, Homepage Layout">
                  <span class="tip" role="tooltip">Limits which Content Models appear in the catalog, and narrows Content Entries to those models too. Add a value, or turn Filter off.</span>
                </div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="pgFiltRow-cms-entry" data-artifact="cms-entry" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="pgFiltOn-cms-entry"> Filter Content Entries</label>
            <div class="filt-body" id="pgFiltBody-cms-entry" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="pgDateField-cms-entry">Date field</label>
                  <select id="pgDateField-cms-entry" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="pgDatePreset-cms-entry">Date range</label>
                  <select id="pgDatePreset-cms-entry" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="pgTimezone-cms-entry">Timezone</label>
                  <select id="pgTimezone-cms-entry" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="pgDateCustom-cms-entry" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="pgDateFrom-cms-entry">From</label><input id="pgDateFrom-cms-entry" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="pgDateTo-cms-entry">To</label><input id="pgDateTo-cms-entry" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="span2 has-tip" id="pgNameEntriesWrap">
                  <label class="fl" for="pgNameEntries">Entry title contains</label>
                  <input id="pgNameEntries" class="txt" spellcheck="false" placeholder="hero, banner">
                  <span class="tip" role="tooltip">Matches entry titles. Add a value, or turn Filter off.</span>
                </div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="pgFiltRow-file" data-artifact="file" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="pgFiltOn-file"> Filter Files</label>
            <div class="filt-body" id="pgFiltBody-file" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="pgDateField-file">Date field</label>
                  <select id="pgDateField-file" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="pgDatePreset-file">Date range</label>
                  <select id="pgDatePreset-file" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="pgTimezone-file">Timezone</label>
                  <select id="pgTimezone-file" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="pgDateCustom-file" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="pgDateFrom-file">From</label><input id="pgDateFrom-file" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="pgDateTo-file">To</label><input id="pgDateTo-file" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="has-tip"><label class="fl" for="pgNameFiles">Name contains</label>
                  <input id="pgNameFiles" class="txt" spellcheck="false" placeholder="logo, icon">
                  <span class="tip" role="tooltip">File name filter. Add a value, or turn Filter off.</span></div>
                <div><label class="fl" for="pgTagsFiles">Tags</label>
                  <input id="pgTagsFiles" class="txt" spellcheck="false" placeholder="hero, promo"></div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="pgFiltRow-page" data-artifact="page" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="pgFiltOn-page"> Filter Pages</label>
            <div class="filt-body" id="pgFiltBody-page" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="pgDateField-page">Date field</label>
                  <select id="pgDateField-page" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="pgDatePreset-page">Date range</label>
                  <select id="pgDatePreset-page" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="pgTimezone-page">Timezone</label>
                  <select id="pgTimezone-page" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="pgDateCustom-page" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="pgDateFrom-page">From</label><input id="pgDateFrom-page" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="pgDateTo-page">To</label><input id="pgDateTo-page" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="span2 has-tip"><label class="fl" for="pgNamePages">Title / path contains</label>
                  <input id="pgNamePages" class="txt" spellcheck="false" placeholder="/home, checkout">
                  <span class="tip" role="tooltip">Matches page title or path. Add a value, or turn Filter off.</span></div>
              </div>
            </div>
          </div>
          <div class="filt-row" id="pgFiltRow-redirect" data-artifact="redirect" hidden>
            <label class="filt-enable-lab"><input type="checkbox" class="filt-enable" id="pgFiltOn-redirect"> Filter Redirects</label>
            <div class="filt-body" id="pgFiltBody-redirect" hidden>
              <div class="filt-fields">
                <div><label class="fl" for="pgDateField-redirect">Date field</label>
                  <select id="pgDateField-redirect" class="txt"><option value="createdOn">Created</option><option value="modifiedOn">Modified (savedOn)</option></select></div>
                <div><label class="fl" for="pgDatePreset-redirect">Date range</label>
                  <select id="pgDatePreset-redirect" class="txt">
                    <option value="">Any time</option>
                    <option value="last_24h">Last 24 hours</option>
                    <option value="last_7d">Last 7 days</option>
                    <option value="last_30d">Last 30 days</option>
                    <option value="this_month">This month</option>
                    <option value="previous_month">Previous month</option>
                    <option value="custom">Custom range…</option>
                  </select></div>
                <div class="span2">
                  <label class="fl" for="pgTimezone-redirect">Timezone</label>
                  <select id="pgTimezone-redirect" class="txt" aria-label="Filter timezone"></select>
                  <p class="filt-tz-hint">Relative months and custom from/to use this timezone (converted to UTC for the API).</p>
                </div>
                <div id="pgDateCustom-redirect" class="span2" style="display:none">
                  <div class="filt-fields">
                    <div><label class="fl" for="pgDateFrom-redirect">From</label><input id="pgDateFrom-redirect" class="txt" type="datetime-local" step="60"></div>
                    <div><label class="fl" for="pgDateTo-redirect">To</label><input id="pgDateTo-redirect" class="txt" type="datetime-local" step="60"></div>
                  </div>
                </div>
                <div class="span2 has-tip"><label class="fl" for="pgNameRedirects">From path contains</label>
                  <input id="pgNameRedirects" class="txt" spellcheck="false" placeholder="/old, /legacy">
                  <span class="tip" role="tooltip">Matches the redirect “from” path. Add a value, or turn Filter off.</span></div>
              </div>
            </div>
          </div>
        </div>
        <div class="filt-actions" id="pgFiltActions">
          <select id="pgPresetSel" class="txt" style="max-width:180px" aria-label="Saved filter presets"></select>
          <button type="button" class="btn" id="pgSavePreset">Save preset</button>
        </div>
      </details>
      <div class="actions">
        <button class="btn primary" id="pgLoad">Load target catalog</button>
        <button class="btn" id="pgReload" type="button" style="display:none">Reload with filters</button>
        <button class="btn" id="pgNarrow" type="button" style="display:none" title="Filter the already-loaded catalog without calling the API">Narrow results</button>
        <span id="pgLoadMsg" class="muted"></span>
      </div>
      </div>

      <div class="flow-stage" id="pgSelect" style="display:none">
        <div class="flow-stage-h"><span class="flow-stage-n" aria-hidden="true">2</span> Select what to delete <span id="pgSelN" class="muted" style="font-weight:400">(0 selected)</span></div>
        <p class="flow-stage-sub">Selecting a <b>Content Model</b> deletes <b>all entries</b> for that model on the target — not just the model definition.</p>
        <div id="pgCatalog" class="muted"></div>
      </div>

      <div class="flow-stage" id="pgStageRun" style="display:none">
        <div class="flow-stage-h"><span class="flow-stage-n" aria-hidden="true">3</span> Purge</div>
        <div class="flow-mode warn" id="pgMode" aria-live="polite">
          <span class="flow-mode-lab" id="pgModeLab">Destructive</span>
          <span class="flow-mode-desc" id="pgModeDesc">Select at least one item above. Preview first; Delete requires typing the target tenant id.</span>
        </div>
        <div class="toolbar">
          <label class="tg has-tip" id="tgPgPerm"><input type="checkbox" id="pgPerm">permanent (hard delete)<span class="tip" role="tooltip">Entries &amp; pages: hard delete (skip bin/Trash) — <b>unrecoverable</b>. Off = soft delete (recoverable). Files &amp; redirects are always permanently deleted (no recycle bin).</span></label>
          <label class="tg has-tip" id="tgPgSame"><input type="checkbox" id="pgSame">allow same tenant<span class="tip" role="tooltip">Allow purging when the target tenant equals the source tenant. Off by default — a real purge once wiped a source tenant.</span></label>
        </div>
        <div class="actions">
          <button class="btn has-tip" id="pgPreview" type="button">Preview (dry-run)<span class="tip" role="tooltip">Dry run — shows how many of each type would be deleted; writes nothing.</span></button>
          <button class="btn primary has-tip" id="pgDelete" type="button">Delete selected…<span class="tip" role="tooltip">Opens a confirmation dialog; you must type the target tenant id to proceed.</span></button>
          <button class="link" id="pgClr">clear</button>
          <span id="pgMsg" class="muted"></span>
        </div>
        <div id="pgResult" style="display:none"><p class="sectt" style="margin-top:18px">Result</p><div id="pgResultBody"></div><details><summary>Console output</summary><pre id="pgOut"></pre></details></div>
      </div>
    </section>

  </div></main>
</div>

<!-- Purge confirmation modal -->
<div id="pgModal" class="modal" style="display:none" role="dialog" aria-modal="true" aria-labelledby="pgModalTitle">
  <div class="modal-box">
    <div class="modal-h" id="pgModalTitle">⚠ Confirm purge</div>
    <div class="modal-body" id="pgModalBody"></div>
    <label class="fl" for="pgConfirmInput">Type the target tenant id to confirm</label>
    <input id="pgConfirmInput" class="txt" spellcheck="false" autocomplete="off">
    <div class="modal-foot">
      <button class="btn" id="pgCancel" type="button">Cancel</button>
      <button class="btn danger" id="pgConfirmBtn" type="button" disabled>Delete now</button>
    </div>
  </div>
</div>

<!-- Remove-dependency confirmation (Migrate / Import auto-deps) -->
<div id="depModal" class="modal" style="display:none" role="dialog" aria-modal="true" aria-labelledby="depModalTitle">
  <div class="modal-box warn">
    <div class="modal-h" id="depModalTitle">Remove dependency?</div>
    <div class="modal-body" id="depModalBody"></div>
    <div class="modal-foot">
      <button class="btn" id="depKeep" type="button">Keep selected</button>
      <button class="btn danger" id="depRemove" type="button">Remove anyway</button>
    </div>
  </div>
</div>
<script>
(function(){
  function $(s){return document.querySelector(s);}
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
  function on(el,ev,fn){ if(el) el.addEventListener(ev,fn); }
  // File binaries aren't copied — surface the S3 manifest path from the run output.
  function s3Note(out){ var m=/S3 copy manifest written to:\s*(.+)/.exec(out||""); return m? '<div class="s3note"><b>S3 copy manifest:</b> <span class="mono">'+esc(m[1].trim())+'</span><br>Some files were not transferred (manifest-only mode, or files over the size limit / missing from the local cache) — run these copies to finish.</div>' : ""; }
  var TNAME={"file-manager":"Files","cms-entries":"Content Entries","page-builder":"Pages","redirects":"Redirects"};
  var EX_TNAME={"file-manager":"Files","cms-models":"Content Models","cms-entries":"Content Entries","page-builder":"Pages","redirects":"Redirects"};
  var CTNAME={model:"Content Models",file:"Files","cms-entry":"Content Entries",page:"Pages",redirect:"Redirects"};
  var I={
    check:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    x:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    arrow:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    menu:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
    sun:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M5 5l1.5 1.5M17.5 17.5 19 19M2 12h2M20 12h2M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>',
    moon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
    exp:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 11l4 4 4-4M5 21h14"/></svg>',
    imp:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M8 7l4-4 4 4M5 21h14"/></svg>',
    copy:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    logs:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    purge:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>'
  };
  $("#menuBtn").innerHTML=I.menu; $("#flowIc").innerHTML=I.arrow;
  $("#ni-export").innerHTML=I.exp; $("#ni-import").innerHTML=I.imp; $("#ni-copy").innerHTML=I.copy; $("#ni-logs").innerHTML=I.logs; $("#ni-purge").innerHTML=I.purge;
  $("#h-export").innerHTML=I.exp; $("#h-import").innerHTML=I.imp; $("#h-copy").innerHTML=I.copy; $("#h-logs").innerHTML=I.logs; if($("#h-purge"))$("#h-purge").innerHTML=I.purge;

  // theme + collapse
  var root=document.documentElement;
  function applyTheme(t){ root.setAttribute("data-theme",t); $("#theme").innerHTML=t==="dark"?I.sun:I.moon; try{localStorage.setItem("kibo-theme",t);}catch(e){} }
  applyTheme((function(){try{return localStorage.getItem("kibo-theme")||"light";}catch(e){return "light";}})());
  on($("#theme"),"click",function(){ applyTheme(root.getAttribute("data-theme")==="dark"?"light":"dark"); });
  on($("#menuBtn"),"click",function(){ document.body.classList.toggle("collapsed"); });

  // nav
  function nav(v){
    document.querySelectorAll(".navi").forEach(function(n){ n.classList.toggle("on",n.getAttribute("data-v")===v); });
    document.querySelectorAll(".view").forEach(function(s){ s.classList.toggle("on",s.id==="v-"+v); });
    if(v==="import") loadExports();
    if(v==="logs") loadRuns();
    window.scrollTo(0,0);
  }
  document.querySelectorAll(".navi").forEach(function(n){
    on(n,"click",function(){ nav(n.getAttribute("data-v")); });
    on(n,"keydown",function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); nav(n.getAttribute("data-v")); } });
  });

  // type chips — Export + Migrate use EX_TNAME (Models vs Entries)
  function typeChips(host, checked, names){
    var map=names||TNAME;
    host.innerHTML="";
    Object.keys(map).forEach(function(pk){
      var el=document.createElement("label");
      el.className="chip"+(checked?" on":"");
      el.setAttribute("data-pk",pk);
      el.innerHTML='<span class="cb"></span>'+esc(map[pk]);
      on(el,"click",function(){
        el.classList.toggle("on");
        if(host.id==="exTypes") syncFiltVisibility("ex");
        if(host.id==="cpTypes") syncFiltVisibility("cp");
        if(host.id==="pgTypes") syncFiltVisibility("pg");
      });
      host.appendChild(el);
    });
  }
  function chosen(host){ return Array.prototype.slice.call(host.querySelectorAll(".chip.on")).map(function(c){return c.getAttribute("data-pk");}); }
  /** Selected type-chip value → artifact key used by the filter rows. */
  var PK_TO_ARTIFACT={"cms-models":"model","cms-entries":"cms-entry","file-manager":"file","page-builder":"page",redirects:"redirect"};
  /**
   * Type-chip pks that reveal a given Filter row. The Model row is reachable
   * from either the Models or the Entries chip — Entries-only runs can still
   * narrow by Model name even though the Models Filter toggle owns the input.
   */
  var ART_ROW_PKS={"model":["cms-models","cms-entries"],"cms-entry":["cms-entries"],"file":["file-manager"],page:["page-builder"],redirect:["redirects"]};
  var ARTIFACTS=["model","cms-entry","file","page","redirect"];
  var ARTIFACT_NAME_ID={"cms-entry":"NameEntries",file:"NameFiles",page:"NamePages",redirect:"NameRedirects"};
  /** Reset one artifact's filter draft (inputs) and hide its body — called when its Filter toggle turns off or its chip is deselected. */
  function clearArtifactFilterDraft(pfx,art){
    var body=document.getElementById(pfx+"FiltBody-"+art);
    if(body) body.hidden=true;
    if(art==="model"){
      var m=document.getElementById(pfx+"Models"); if(m) m.value="";
      return;
    }
    var df=document.getElementById(pfx+"DateField-"+art); if(df) df.value="createdOn";
    var dp=document.getElementById(pfx+"DatePreset-"+art); if(dp) dp.value="";
    var dc=document.getElementById(pfx+"DateCustom-"+art); if(dc) dc.style.display="none";
    var dfrom=document.getElementById(pfx+"DateFrom-"+art); if(dfrom) dfrom.value="";
    var dto=document.getElementById(pfx+"DateTo-"+art); if(dto) dto.value="";
    var nameId=ARTIFACT_NAME_ID[art];
    var nameEl=nameId&&document.getElementById(pfx+nameId); if(nameEl) nameEl.value="";
    if(art==="file"){
      var tags=document.getElementById(pfx+"TagsFiles"); if(tags) tags.value="";
    }
  }
  /** Show one Filter row per selected artifact chip; bodies stay hidden until that row's toggle is on. */
  function syncFiltVisibility(pfx){
    var host=$("#"+pfx+"Types"); if(!host) return;
    var selected={}; chosen(host).forEach(function(pk){ selected[pk]=true; });
    var anyRow=false;
    ARTIFACTS.forEach(function(art){
      var row=document.getElementById(pfx+"FiltRow-"+art);
      if(!row) return;
      var show=ART_ROW_PKS[art].some(function(pk){ return !!selected[pk]; });
      row.hidden=!show;
      if(show) anyRow=true;
      var onCb=document.getElementById(pfx+"FiltOn-"+art);
      if(!show){
        if(onCb&&onCb.checked){
          onCb.checked=false;
          clearArtifactFilterDraft(pfx,art);
        }
      }
      var enabled=!!(onCb&&onCb.checked);
      var body=document.getElementById(pfx+"FiltBody-"+art);
      if(body) body.hidden=!show||!enabled;
    });
    var empty=document.getElementById(pfx+"FiltEmpty");
    if(empty) empty.hidden=anyRow;
    var stack=document.getElementById(pfx+"FiltStack");
    if(stack) stack.hidden=!anyRow;
    var actions=document.getElementById(pfx+"FiltActions");
    if(actions) actions.style.display=anyRow?"":"none";
    refreshFilt(pfx);
  }
  function collapseFilt(pfx){
    var el=$("#"+pfx+"Filt");
    if(!el) return;
    el.open=false;
    el.removeAttribute("open");
  }
  /** Wire each artifact's Filter (.filt-enable) toggle: on → reveal body; off → clear draft + hide body. */
  function wireFiltEnableToggles(pfx){
    ARTIFACTS.forEach(function(art){
      var cb=document.getElementById(pfx+"FiltOn-"+art);
      if(!cb) return;
      on(cb,"change",function(){
        var body=document.getElementById(pfx+"FiltBody-"+art);
        if(cb.checked){
          if(body) body.hidden=false;
        }else{
          clearArtifactFilterDraft(pfx,art);
        }
        refreshFilt(pfx);
      });
    });
  }
  /** Wire per-artifact date-preset selects to toggle their own custom range block. */
  function wireArtifactDateControls(pfx){
    ARTIFACTS.filter(function(art){return art!=="model";}).forEach(function(art){
      var presetEl=document.getElementById(pfx+"DatePreset-"+art);
      var customEl=document.getElementById(pfx+"DateCustom-"+art);
      fillTimezoneSelect(document.getElementById(pfx+"Timezone-"+art));
      if(presetEl){
        on(presetEl,"change",function(){
          if(customEl) customEl.style.display=presetEl.value==="custom"?"block":"none";
          refreshFilt(pfx);
        });
      }
      ["DateField-"+art,"DateFrom-"+art,"DateTo-"+art,"Timezone-"+art].forEach(function(idSuf){
        var el=document.getElementById(pfx+idSuf); if(!el) return;
        on(el,"input",function(){ refreshFilt(pfx); });
        on(el,"change",function(){ refreshFilt(pfx); });
      });
    });
  }

  // env
  var ENV=null;
  fetch("/api/env").then(function(r){return r.json();}).then(function(e){
    ENV=e;
    $("#exSrcUrl").textContent=e.source.url||"(source not configured)";
    $("#imTgtUrl").textContent=e.target.url||"(target not configured)";
    $("#cpSrcUrl").textContent=e.source.url||"—"; $("#cpTgtUrl").textContent=e.target.url||"—";
    $("#exTenant").value=e.source.tenant||""; $("#imTenant").value=e.target.tenant||"";
    $("#cpSrc").value=e.source.tenant||""; $("#cpTgt").value=e.target.tenant||"";
    $("#pgTgtUrl").textContent=e.target.url||"(target not configured)"; $("#pgTenant").value=e.target.tenant||"";
    cpRoute();
  });

  // Follow a background job via SSE into a console element.
  function followJob(jobId, outEl, onDone){
    outEl.textContent="";
    var es=new EventSource("/api/jobs/"+encodeURIComponent(jobId)+"/stream");
    es.onmessage=function(ev){
      try{
        var m=JSON.parse(ev.data);
        if(m.type==="log"){ outEl.textContent+=(outEl.textContent?"\\n":"")+m.line; outEl.scrollTop=outEl.scrollHeight; }
        if(m.type==="done"){ es.close(); if(onDone) onDone(m.meta||{}); }
      }catch(e){}
    };
    es.onerror=function(){ es.close(); if(onDone) onDone({status:"error",error:"stream closed"}); };
  }

  // ─── Shared filter bar helpers (Export + Migrate) ─────────
  var FILT_PRESET_KEY="kibo-filt-presets-v1";
  var TZ_COMMON=["UTC","America/New_York","America/Chicago","America/Denver","America/Los_Angeles","America/Toronto","America/Sao_Paulo","Europe/London","Europe/Paris","Europe/Berlin","Europe/Amsterdam","Asia/Kolkata","Asia/Singapore","Asia/Tokyo","Asia/Shanghai","Australia/Sydney","Pacific/Auckland"];
  function browserTimezone(){
    try{ return Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"; }catch(e){ return "UTC"; }
  }
  function fillTimezoneSelect(sel){
    if(!sel||sel.getAttribute("data-filled")) return;
    var local=browserTimezone();
    var zones=TZ_COMMON.slice();
    if(zones.indexOf(local)<0) zones.unshift(local);
    sel.innerHTML=zones.map(function(z){
      var label=z===local?(z+" (local)"):z;
      return '<option value="'+esc(z)+'">'+esc(label)+'</option>';
    }).join("");
    sel.value=local;
    sel.setAttribute("data-filled","1");
  }
  /** ISO / date → value for <input type="datetime-local"> in the given IANA zone. */
  function toDatetimeLocalValue(raw, timeZone){
    if(!raw) return "";
    var s=String(raw).trim();
    if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return s.slice(0,16);
    if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s+"T00:00";
    var d=new Date(s);
    if(isNaN(d.getTime())) return "";
    try{
      var fmt=new Intl.DateTimeFormat("en-CA",{timeZone:timeZone||"UTC",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
      var parts=fmt.formatToParts(d);
      var g=function(t){ var p=parts.find(function(x){return x.type===t;}); return p?p.value:""; };
      return g("year")+"-"+g("month")+"-"+g("day")+"T"+g("hour")+":"+g("minute");
    }catch(e){
      return d.toISOString().slice(0,16);
    }
  }
  function csvParts(s){
    return String(s||"").split(",").map(function(t){return t.trim();}).filter(Boolean);
  }
  function pushNameField(fields, artifact, raw){
    var parts=csvParts(raw);
    if(!parts.length) return;
    fields.push({artifact:artifact,field:"name",op:"contains",value:parts.length===1?parts[0]:parts});
  }
  function idVal(id){ var el=document.getElementById(id); return el?el.value:""; }
  /** Full names (match the Filter row labels) for validation errors. */
  var ARTIFACT_ERR_LABEL={"model":"Content Models","cms-entry":"Content Entries",file:"Files",page:"Pages",redirect:"Redirects"};
  /** Short names for the "Filtered: …" badge. */
  var ARTIFACT_BADGE_LABEL={"model":"Models","cms-entry":"Entries",file:"Files",page:"Pages",redirect:"Redirects"};
  /** True when an enabled artifact row has ≥1 real constraint (date preset/custom-range, name, tags, model names). */
  function artifactConstraintActive(pfx,art){
    if(art==="model") return !!idVal(pfx+"Models").trim();
    var preset=idVal(pfx+"DatePreset-"+art);
    if(preset){
      if(preset!=="custom") return true;
      if(idVal(pfx+"DateFrom-"+art).trim()||idVal(pfx+"DateTo-"+art).trim()) return true;
    }
    var nameId=ARTIFACT_NAME_ID[art];
    if(nameId&&idVal(pfx+nameId).trim()) return true;
    if(art==="file"&&idVal(pfx+"TagsFiles").trim()) return true;
    return false;
  }
  /** True when Custom is selected for an artifact's date row but both From and To are empty. */
  function customRangeBlank(pfx,art){
    return idVal(pfx+"DatePreset-"+art)==="custom"
      && !idVal(pfx+"DateFrom-"+art).trim()
      && !idVal(pfx+"DateTo-"+art).trim();
  }
  /** Build a DateRangeFilter from one artifact row's controls (caller ensures preset is non-empty). */
  function dateFromControls(pfx,art){
    var preset=idVal(pfx+"DatePreset-"+art);
    return {
      field:idVal(pfx+"DateField-"+art)==="modifiedOn"?"modifiedOn":"createdOn",
      mode:preset==="custom"?"absolute":"relative",
      preset:preset,
      from:idVal(pfx+"DateFrom-"+art)||undefined,
      to:idVal(pfx+"DateTo-"+art)||undefined
    };
  }
  /**
   * Flatten opt-in filter rows into an ArtifactFilterSpec (per-artifact "dates" + "dateTimezones",
   * no top-level "date"). Enabled rows with no real constraint block with an inline error instead
   * of silently being skipped.
   */
  function collectFilters(pfx){
    var fields=[];
    var dates={};
    var dateTimezones={};
    var timezone="UTC";
    var errors=[];
    function maybe(art,build){
      var cb=document.getElementById(pfx+"FiltOn-"+art);
      if(!cb||!cb.checked) return;
      if(!artifactConstraintActive(pfx,art)){
        errors.push("Add a constraint for "+ARTIFACT_ERR_LABEL[art]+", or turn Filter off.");
        return;
      }
      build();
    }
    function datedRow(art,pushFields){
      var cb=document.getElementById(pfx+"FiltOn-"+art);
      if(!cb||!cb.checked) return;
      // Custom-without-bounds must block (even when another field like name is filled) —
      // emitting dates[art] here would 400 at freeze time (needs from and/or to).
      if(customRangeBlank(pfx,art)){
        errors.push("Custom date range needs From and/or To for "+ARTIFACT_ERR_LABEL[art]+".");
        return;
      }
      if(!artifactConstraintActive(pfx,art)){
        errors.push("Add a constraint for "+ARTIFACT_ERR_LABEL[art]+", or turn Filter off.");
        return;
      }
      var preset=idVal(pfx+"DatePreset-"+art);
      var tz=idVal(pfx+"Timezone-"+art)||"UTC";
      timezone=tz;
      if(preset){
        dates[art]=dateFromControls(pfx,art);
        dateTimezones[art]=tz;
      }
      pushFields();
    }
    datedRow("cms-entry",function(){ pushNameField(fields,"cms-entry",idVal(pfx+"NameEntries")); });
    datedRow("file",function(){
      pushNameField(fields,"file",idVal(pfx+"NameFiles"));
      var tags=csvParts(idVal(pfx+"TagsFiles"));
      if(tags.length) fields.push({artifact:"file",field:"tags",op:"in",value:tags});
    });
    datedRow("page",function(){ pushNameField(fields,"page",idVal(pfx+"NamePages")); });
    datedRow("redirect",function(){ pushNameField(fields,"redirect",idVal(pfx+"NameRedirects")); });
    maybe("model",function(){ /* models value read separately via modelsFilterValue */ });

    var models=modelsFilterValue(pfx);
    if(errors.length) return {spec:null,models:models,error:errors[0]};

    var hasDates=Object.keys(dates).length>0;
    var spec={timezone:timezone,fields:fields};
    if(hasDates){ spec.dates=dates; spec.dateTimezones=dateTimezones; }
    var active=fields.length>0||hasDates;
    return {spec:active?spec:null,models:models,error:null};
  }
  function filterActive(spec){ return !!spec; }
  /** Map Export/Migrate UI chips → artifact types for badge / scan guard. */
  function typesForBadge(pfx){
    var host=$("#"+pfx+"Types");
    var chips=host?chosen(host):[];
    var out=[];
    chips.forEach(function(c){
      if(c==="cms-entries"||c==="cms-entry") out.push("cms-entry");
      else if(c==="cms-models"||c==="model") out.push("model");
      else if(c==="file-manager"||c==="file") out.push("file");
      else if(c==="page-builder"||c==="page") out.push("page");
      else if(c==="redirects"||c==="redirect") out.push("redirect");
    });
    return out.length?out:["cms-entry","file","page","redirect"];
  }
  /** Enabled+constrained artifact labels for the "Filtered: …" badge, in fixed display order. */
  function activeArtifactLabels(spec,models){
    var artHasField={}, artHasDate={};
    (spec&&spec.fields||[]).forEach(function(f){ if(f.artifact) artHasField[f.artifact]=true; });
    if(spec&&spec.dates) Object.keys(spec.dates).forEach(function(a){ artHasDate[a]=true; });
    var out=[];
    if(models) out.push(ARTIFACT_BADGE_LABEL.model);
    ["cms-entry","file","page","redirect"].forEach(function(art){
      if(artHasField[art]||artHasDate[art]) out.push(ARTIFACT_BADGE_LABEL[art]);
    });
    return out;
  }
  function badgeKind(pfx,spec,models){
    if(!filterActive(spec)&&!models) return "none";
    var types=typesForBadge(pfx);
    var pageName=!!(spec&&spec.fields||[]).some(function(f){return f.field==="name"&&f.artifact==="page";});
    // Page name/path is always residual → Mixed when that field is set and pages are in the run
    if(pageName&&types.indexOf("page")>=0) return "mixed";
    return "source";
  }
  /** Recomputes the current filter spec and refreshes the badge; self-contained (no stale args). */
  function updateFiltBadge(pfx){
    var el=$("#"+pfx+"FiltBadge");
    if(!el) return;
    var cf=collectFilters(pfx);
    var kind=badgeKind(pfx,cf.spec,cf.models);
    if(kind==="none"){ el.textContent="No filters"; return; }
    if(kind==="mixed"){ el.innerHTML='<span class="badge-mix">Mixed (page name residual)</span>'; return; }
    var labels=activeArtifactLabels(cf.spec,cf.models);
    el.innerHTML='<span class="badge-src">'+esc(labels.length?("Filtered: "+labels.join(", ")):"Filtered")+'</span>';
  }
  function setVal(id,v){ var el=document.getElementById(id); if(el) el.value=v; }
  function showFiltErr(pfx,msg){
    var el=document.getElementById(pfx+"FiltErr");
    if(el){ el.textContent=msg; el.hidden=false; }
    var details=document.getElementById(pfx+"Filt");
    if(details) details.open=true;
  }
  function clearFiltErr(pfx){
    var el=document.getElementById(pfx+"FiltErr");
    if(el){ el.hidden=true; el.textContent=""; }
  }
  /** Re-check validation + refresh badge/reload markers; wired to every filter-control change. */
  function refreshFilt(pfx){
    clearFiltErr(pfx);
    updateFiltBadge(pfx);
    if(pfx==="cp") markCpNeedsReload();
    if(pfx==="pg") markPgNeedsReload();
  }
  /** Raw per-artifact UI state for presets (independent of validation). */
  function collectPresetState(pfx){
    var byArtifact={};
    ARTIFACTS.forEach(function(art){
      var cb=document.getElementById(pfx+"FiltOn-"+art);
      var enabled=!!(cb&&cb.checked);
      if(art==="model"){ byArtifact[art]={enabled:enabled}; return; }
      var row={
        enabled:enabled,
        dateField:idVal(pfx+"DateField-"+art)||"createdOn",
        preset:idVal(pfx+"DatePreset-"+art)||"",
        from:idVal(pfx+"DateFrom-"+art)||"",
        to:idVal(pfx+"DateTo-"+art)||"",
        timezone:idVal(pfx+"Timezone-"+art)||"",
        name:idVal(pfx+(ARTIFACT_NAME_ID[art]||""))||""
      };
      if(art==="file") row.tags=idVal(pfx+"TagsFiles")||"";
      byArtifact[art]=row;
    });
    return {version:2,byArtifact:byArtifact,models:idVal(pfx+"Models")||""};
  }
  /** Adapt a legacy {date, fields, timezone} preset into the v2 per-artifact shape (no blocking error). */
  function adaptLegacyPreset(pfx,spec){
    var selected={};
    var host=$("#"+pfx+"Types");
    if(host) chosen(host).forEach(function(pk){ selected[PK_TO_ARTIFACT[pk]]=true; });
    var byArtField={};
    (spec.fields||[]).forEach(function(f){
      if(!f.artifact) return;
      byArtField[f.artifact]=byArtField[f.artifact]||{};
      if(f.field==="name") byArtField[f.artifact].name=Array.isArray(f.value)?f.value.join(", "):String(f.value||"");
      if(f.field==="tags") byArtField[f.artifact].tags=Array.isArray(f.value)?f.value.join(", "):String(f.value||"");
    });
    var tz=spec.timezone||browserTimezone();
    var byArtifact={model:{enabled:false}};
    ARTIFACTS.filter(function(a){return a!=="model";}).forEach(function(art){
      var fld=byArtField[art];
      var applyDate=!!(selected[art]&&spec.date);
      var row={
        enabled:!!(fld||applyDate),
        dateField:(spec.date&&spec.date.field)||"createdOn",
        preset:"",from:"",to:"",timezone:tz,
        name:(fld&&fld.name)||""
      };
      if(applyDate){
        row.preset=spec.date.preset||(spec.date.mode==="absolute"?"custom":"");
        row.from=spec.date.from||"";
        row.to=spec.date.to||"";
      }
      if(art==="file") row.tags=(fld&&fld.tags)||"";
      byArtifact[art]=row;
    });
    return {version:2,byArtifact:byArtifact,models:""};
  }
  /** Hydrate toggles + bodies + inputs from a v2 preset (or adapted legacy preset); no blocking error. */
  function applyFiltersToForm(pfx,state){
    if(!state) return;
    var v2=(state.version===2&&state.byArtifact)?state:adaptLegacyPreset(pfx,state);
    ARTIFACTS.forEach(function(art){
      var row=v2.byArtifact[art]||{enabled:false};
      var cb=document.getElementById(pfx+"FiltOn-"+art);
      if(cb) cb.checked=!!row.enabled;
      if(art==="model") return;
      setVal(pfx+"DateField-"+art,row.dateField||"createdOn");
      setVal(pfx+"DatePreset-"+art,row.preset||"");
      var customEl=document.getElementById(pfx+"DateCustom-"+art);
      if(customEl) customEl.style.display=(row.preset==="custom")?"block":"none";
      setVal(pfx+"DateFrom-"+art,row.from||"");
      setVal(pfx+"DateTo-"+art,row.to||"");
      if(row.timezone) setVal(pfx+"Timezone-"+art,row.timezone);
      var nameId=ARTIFACT_NAME_ID[art];
      if(nameId) setVal(pfx+nameId,row.name||"");
      if(art==="file") setVal(pfx+"TagsFiles",row.tags||"");
    });
    setVal(pfx+"Models",v2.models||"");
    clearFiltErr(pfx);
    // Re-derives row visibility from the current chip selection (independent layer) + refreshes badge.
    syncFiltVisibility(pfx);
  }
  function loadFiltPresets(){
    try{ return JSON.parse(localStorage.getItem(FILT_PRESET_KEY)||"[]"); }catch(e){ return []; }
  }
  function saveFiltPreset(pfx){
    var name=prompt("Preset name?");
    if(!name||!name.trim()) return;
    var list=loadFiltPresets();
    list=list.filter(function(p){return p.name!==name.trim();});
    list.unshift({name:name.trim(),spec:collectPresetState(pfx),savedAt:new Date().toISOString()});
    if(list.length>12) list=list.slice(0,12);
    localStorage.setItem(FILT_PRESET_KEY,JSON.stringify(list));
    refreshFiltPresetSelect(pfx);
  }
  function refreshFiltPresetSelect(pfx){
    var sel=$("#"+pfx+"PresetSel");
    if(!sel) return;
    var list=loadFiltPresets();
    sel.innerHTML='<option value="">Saved presets…</option>'+list.map(function(p,i){
      return '<option value="'+i+'">'+esc(p.name)+'</option>';
    }).join("");
  }
  function wireFilt(pfx){
    wireFiltEnableToggles(pfx);
    wireArtifactDateControls(pfx);
    ["NameEntries","NameFiles","NamePages","NameRedirects","TagsFiles","Models"].forEach(function(id){
      var el=$("#"+pfx+id); if(!el) return;
      on(el,"input",function(){ refreshFilt(pfx); });
      on(el,"change",function(){ refreshFilt(pfx); });
    });
    var saveBtn=$("#"+pfx+"SavePreset");
    if(saveBtn) on(saveBtn,"click",function(){ saveFiltPreset(pfx); });
    var sel=$("#"+pfx+"PresetSel");
    if(sel) on(sel,"change",function(){
      var list=loadFiltPresets(); var p=list[Number(this.value)];
      if(p&&p.spec) applyFiltersToForm(pfx,p.spec);
      this.value="";
    });
    refreshFiltPresetSelect(pfx);
  }
  wireFilt("ex"); wireFilt("cp"); wireFilt("pg");

  // ─── EXPORT ───────────────────────────────────────────────
  typeChips($("#exTypes"), true, EX_TNAME);
  syncFiltVisibility("ex");
  toggleWrap("exCont"); toggleWrap("exBin");
  var exSel=new Set(), exOmittedDeps=new Set(), EX_CAT=null;

  function syncExportButtons(){
    var hasSel=exSel.size>0;
    var selBtn=$("#exGoSel"), allBtn=$("#exGo");
    selBtn.style.display=hasSel?"inline-flex":"none";
    selBtn.disabled=false;
    selBtn.classList.toggle("primary", hasSel);
    allBtn.style.display=hasSel?"none":"inline-flex";
    allBtn.disabled=false;
    allBtn.classList.toggle("primary", !hasSel);
    $("#exClr").style.display=hasSel?"inline-flex":"none";
    var mode=$("#exMode"), lab=$("#exModeLab"), desc=$("#exModeDesc");
    if(mode) mode.classList.toggle("on-sel", hasSel);
    if(lab) lab.textContent=hasSel?"Export selected":"Export all";
    if(desc) desc.textContent=hasSel
      ?("Writes the "+exSel.size+" checked item(s) and their deps — not the full filtered type.")
      :"No items selected — exports every item of the types above (Filters apply).";
  }
  function exSelN(){
    var auto=0;
    if(EX_CAT&&EX_CAT.sections){
      EX_CAT.sections.forEach(function(sec){
        (sec.items||[]).forEach(function(it){
          if(exSel.has(it.id)&&it.metadata&&it.metadata.autoDep) auto++;
        });
      });
    }
    $("#exSelN").textContent=auto
      ?("("+exSel.size+" selected, "+auto+" dep auto-included)")
      :("("+exSel.size+" selected)");
    syncExportButtons();
  }
  function renderExCatalog(){
    if(!EX_CAT||!EX_CAT.sections){ $("#exCatalog").innerHTML='<span class="glitch">No catalog.</span>'; return; }
    renderSelectable("#exCatalog", EX_CAT.sections, exSel, exSelN, {
      autoDeps:true,
      catalog:EX_CAT,
      omitSet:exOmittedDeps,
      onDepsMerged:function(){ renderExCatalog(); }
    });
  }
  function loadExportCatalog(){
    var tenant=$("#exTenant").value.trim(); var types=chosen($("#exTypes"));
    if(!tenant){ $("#exLoadMsg").textContent="Enter a source tenant id."; return; }
    if(!types.length){ $("#exLoadMsg").textContent="Select at least one artifact."; return; }
    var cf=collectFilters("ex");
    if(cf.error){ showFiltErr("ex",cf.error); updateFiltBadge("ex"); return; }
    clearFiltErr("ex");
    var filters=cf.spec;
    updateFiltBadge("ex");
    collapseFilt("ex");
    $("#exLoad").disabled=true; $("#exReload").disabled=true;
    $("#exLoadMsg").innerHTML='<span class="spin"></span> Building catalog…';
    fetch("/api/catalog/build",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sourceTenant:tenant,types:types,models:cf.models||undefined,filters:filterActive(filters)?filters:undefined})})
      .then(function(r){return r.json();}).then(function(c){
        $("#exLoad").disabled=false; $("#exReload").disabled=false;
        $("#exReload").style.display="inline-flex";
        if(c.error){
          var detail=(c.detail||c.output||"").toString().trim();
          var snippet=detail?detail.slice(-900):"";
          $("#exLoadMsg").innerHTML='<span style="color:var(--red)">'+esc(c.error)+'</span>'+
            (snippet?'<pre class="panel" style="margin-top:8px;max-height:180px;overflow:auto;font-size:11px;white-space:pre-wrap">'+esc(snippet)+'</pre>':'');
          return;
        }
        if(types.indexOf("cms-models")>=0&&types.indexOf("cms-entries")<0&&c.sections){
          c.sections=c.sections.filter(function(sec){ return sec.type!=="cms-entry"; });
          c.sections.forEach(function(sec){ sec.total=(sec.items||[]).length; });
        }
        EX_CAT=c; exSel.clear(); exOmittedDeps.clear();
        var n=(c.sections||[]).reduce(function(a,sec){return a+(sec.total||0);},0);
        $("#exLoadMsg").textContent="Catalog: "+n+" item(s). Select pages/entries to export a hydrated closure.";
        $("#exSelect").style.display="block";
        $("#exStageRun").style.display="block";
        renderExCatalog();
        $("#exSelect").scrollIntoView({behavior:"smooth",block:"start"});
      }).catch(function(err){ $("#exLoad").disabled=false; $("#exReload").disabled=false; $("#exLoadMsg").textContent="Request failed: "+err; });
  }
  on($("#exLoad"),"click",loadExportCatalog);
  on($("#exReload"),"click",loadExportCatalog);
  on($("#exClr"),"click",function(){ exSel.clear(); exOmittedDeps.clear(); renderExCatalog(); syncExportButtons(); });
  syncExportButtons();

  function startExportJob(body){
    $("#exGo").disabled=true; $("#exGoSel").disabled=true;
    $("#exMsg").innerHTML='<span class="spin"></span> Exporting… (live log below)';
    $("#exResult").style.display="block"; $("#exOut").textContent="Starting…\\n";
    fetch("/api/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
      .then(function(r){return r.json();}).then(function(d){
        if(d.error){
          syncExportButtons();
          $("#exMsg").innerHTML='<span class="ok-msg" style="color:var(--red)">'+esc(d.error)+'</span>';
          return;
        }
        $("#exDir").textContent=d.dir||"";
        followJob(d.jobId, $("#exOut"), function(meta){
          syncExportButtons();
          var ok=meta.status==="done";
          $("#exMsg").innerHTML=ok?'<span class="ok-msg">'+I.check+' Export complete</span>':'<span style="color:var(--red)">'+I.x+' Export finished with errors</span>';
        });
      }).catch(function(err){
        syncExportButtons();
        $("#exMsg").textContent="Request failed: "+err;
      });
  }
  on($("#exGoSel"),"click",function(){
    var tenant=$("#exTenant").value.trim(); var types=chosen($("#exTypes"));
    if(!tenant){ $("#exMsg").textContent="Enter a source tenant id."; return; }
    if(!types.length){ $("#exMsg").textContent="Select at least one artifact."; return; }
    if(!exSel.size){ $("#exMsg").textContent="Select at least one item, or clear selection to Export all."; return; }
    var cf=collectFilters("ex");
    if(cf.error){ showFiltErr("ex",cf.error); updateFiltBadge("ex"); return; }
    clearFiltErr("ex");
    collapseFilt("ex");
    startExportJob({
      sourceTenant:tenant,types:types,models:cf.models,
      selectedIds:Array.from(exSel), omittedDepIds:Array.from(exOmittedDeps),
      continueOnError:$("#exCont").checked,withBinaries:$("#exBin").checked,maxFileSize:$("#exMaxMb").value,
      filters:filterActive(cf.spec)?cf.spec:undefined
    });
  });
  on($("#exGo"),"click",function(){
    var tenant=$("#exTenant").value.trim(); var types=chosen($("#exTypes"));
    if(!tenant){ $("#exMsg").textContent="Enter a source tenant id."; return; }
    if(!types.length){ $("#exMsg").textContent="Select at least one artifact."; return; }
    var cf=collectFilters("ex");
    if(cf.error){ showFiltErr("ex",cf.error); updateFiltBadge("ex"); return; }
    clearFiltErr("ex");
    var filters=cf.spec;
    updateFiltBadge("ex");
    // Soft guard: pages + name means mixed residual; warn if user might expect cheap filter
    if(filterActive(filters)&&(filters.fields||[]).some(function(f){return f.field==="name"&&f.artifact==="page";})&&typesForBadge("ex").indexOf("page")>=0){
      if(!confirm("Page name/path cannot be filtered at the API — the export will push dates (if set) then match page titles/paths in-process. Continue?")) return;
    }
    collapseFilt("ex");
    startExportJob({sourceTenant:tenant,types:types,models:cf.models,continueOnError:$("#exCont").checked,withBinaries:$("#exBin").checked,maxFileSize:$("#exMaxMb").value,filters:filterActive(filters)?filters:undefined});
  });

  // ─── IMPORT (guided wizard) ───────────────────────────────
  function toggleWrap(id){ var cb=$("#"+id),w=cb.closest(".tg"); function s(){w.classList.toggle("on",cb.checked);} on(cb,"change",s); s(); }
  toggleWrap("imDry"); toggleWrap("imAsDraft"); toggleWrap("imFolder"); toggleWrap("imSchema"); toggleWrap("imCont"); toggleWrap("imUpload"); toggleWrap("imManifest");

  var importSel=new Set();
  var importOmittedDeps=new Set();
  var imSections=[];
  var IM_CAT=null;
  var imStep=1;
  var imMaxReached=1;
  var imExports=[];
  var imSourceTypes=[];
  var imSourceLabel="";
  var imSourceMode="server";
  var imContentsLoadedFor="";

  function relTime(iso){
    if(!iso) return "";
    var t=Date.parse(iso); if(!t) return iso;
    var s=Math.max(0,Math.floor((Date.now()-t)/1000));
    if(s<60) return "just now";
    if(s<3600) return Math.floor(s/60)+"m ago";
    if(s<86400) return Math.floor(s/3600)+"h ago";
    return Math.floor(s/86400)+"d ago";
  }

  function imSelN(){
    if(!importSel.size){ $("#imSelN").textContent="(0 selected — import everything in this export)"; return; }
    var modelIds={};
    (imSections||[]).forEach(function(s){ if(s.type==="model") (s.items||[]).forEach(function(it){ modelIds[it.id]=1; }); });
    var onlyModels=true;
    importSel.forEach(function(id){ if(!modelIds[id]) onlyModels=false; });
    if(onlyModels){
      $("#imSelN").textContent="("+importSel.size+" model(s) — schemas only, no entries)";
      return;
    }
    var auto=0;
    (imSections||[]).forEach(function(sec){
      (sec.items||[]).forEach(function(it){
        if(importSel.has(it.id)&&it.metadata&&it.metadata.autoDep) auto++;
      });
    });
    $("#imSelN").textContent=auto
      ?("("+importSel.size+" selected, "+auto+" dep auto-included)")
      :("("+importSel.size+" selected — deps auto-included)");
  }

  function loadImportContents(force){
    var dir=$("#imDir").value;
    if(!dir){ $("#imContents").innerHTML='<span class="muted">Choose a source first.</span>'; imSelN(); return; }
    if(!force && imContentsLoadedFor===dir) return;
    importSel.clear();
    importOmittedDeps.clear();
    imContentsLoadedFor=dir;
    $("#imContents").innerHTML='<span class="spin"></span> Reading folder…';
    fetch("/api/import/contents?dir="+encodeURIComponent(dir)).then(function(r){return r.json();}).then(function(d){
      if(d.error){ $("#imContents").innerHTML='<span style="color:var(--red)">'+esc(d.error)+'</span>'; return; }
      imSections=d.sections||[];
      IM_CAT={sections:imSections};
      if(!imSourceTypes.length){
        imSourceTypes=imSections.map(function(s){ return CTNAME[s.type]||s.type; })
          .filter(function(v,i,a){ return a.indexOf(v)===i; });
      }
      function paintIm(){
        renderSelectable("#imContents", imSections, importSel, imSelN, {
          autoDeps:true,
          catalog:IM_CAT,
          omitSet:importOmittedDeps,
          onDepsMerged:paintIm
        });
      }
      paintIm();
    }).catch(function(err){ $("#imContents").textContent="Failed to read folder: "+err; });
  }

  function setImSource(dir, types, label){
    var prev=$("#imDir").value;
    $("#imDir").value=dir||"";
    imSourceTypes=types||[];
    imSourceLabel=label||dir||"";
    $("#imNext1").disabled=!dir;
    $("#imSrcMsg").textContent=dir?("Selected: "+imSourceLabel):"";
    if(prev!==dir){
      importSel.clear();
      importOmittedDeps.clear();
      imContentsLoadedFor="";
      imSections=[];
      IM_CAT=null;
    }
  }

  function renderExportCards(){
    var q=($("#imExportQ").value||"").trim().toLowerCase();
    var host=$("#imExportList");
    var list=imExports.filter(function(d){ return !q || (d.dir||"").toLowerCase().indexOf(q)>=0; });
    if(!imExports.length){
      host.innerHTML='<div class="muted" style="padding:12px 0">No server exports yet. Run <b>Export</b> first, or switch to <b>Upload zip</b>.</div>';
      return;
    }
    if(!list.length){ host.innerHTML='<span class="muted">No exports match the filter.</span>'; return; }
    var cur=$("#imDir").value;
    host.innerHTML="";
    list.forEach(function(d){
      var btn=document.createElement("button");
      btn.type="button";
      btn.className="excard"+(cur===d.dir?" on":"");
      btn.setAttribute("data-dir",d.dir);
      var name=(d.dir||"").split("/").pop()||d.dir;
      var chips=(d.types||[]).map(function(t){ return '<span class="exchip">'+esc(t)+'</span>'; }).join("");
      btn.innerHTML='<div style="flex:1"><div class="ex-name">'+esc(name)+'</div>'+
        '<div class="ex-meta">'+esc(relTime(d.mtime))+(d.types&&d.types.length?' · '+d.types.length+' type(s)':'')+'</div>'+
        '<div class="ex-types">'+chips+'</div></div>';
      on(btn,"click",function(){
        host.querySelectorAll(".excard").forEach(function(c){ c.classList.remove("on"); });
        btn.classList.add("on");
        setImSource(d.dir, d.types||[], name);
      });
      host.appendChild(btn);
    });
  }

  function loadExports(){
    fetch("/api/exports").then(function(r){return r.json();}).then(function(list){
      imExports=list||[];
      renderExportCards();
    }).catch(function(){
      $("#imExportList").innerHTML='<span style="color:var(--red)">Failed to list exports.</span>';
    });
  }

  function setImSrcMode(mode){
    imSourceMode=mode;
    $("#imModeServer").classList.toggle("on",mode==="server");
    $("#imModeUpload").classList.toggle("on",mode==="upload");
    $("#imSrcServer").style.display=mode==="server"?"":"none";
    $("#imSrcUpload").style.display=mode==="upload"?"":"none";
  }

  function uploadZipFile(f){
    if(!f){ $("#imZipMsg").textContent="Choose a .zip first."; return; }
    $("#imZipMsg").innerHTML='<span class="spin"></span> Uploading & extracting…';
    $("#imNext1").disabled=true;
    fetch("/api/import/upload",{method:"POST",headers:{"content-type":"application/zip"},body:f})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.error){ $("#imZipMsg").innerHTML='<span style="color:var(--red)">'+esc(d.error)+'</span>'; return; }
        $("#imZipMsg").innerHTML='<span class="ok-msg">'+I.check+' Extracted — ready to continue</span>';
        setImSource(d.dir, [], "(uploaded) "+(f.name||"zip"));
      }).catch(function(err){ $("#imZipMsg").textContent="Upload failed: "+err; });
  }

  function paintImSteps(){
    for(var i=1;i<=4;i++){
      var tab=$("#imStepTab"+i);
      var panel=$("#imStep"+i);
      tab.classList.remove("on","done");
      tab.disabled=i>imMaxReached;
      if(i===imStep) tab.classList.add("on");
      else if(i<=imMaxReached) tab.classList.add("done");
      panel.classList.toggle("on",i===imStep);
    }
  }

  function goImStep(n){
    if(n<1||n>4) return;
    if(n>imMaxReached) return;
    if(n>=2 && !$("#imDir").value){ $("#imSrcMsg").textContent="Select a server export or upload a zip first."; return; }
    if(n>=3 && !$("#imTenant").value.trim()){ $("#imTgtMsg").textContent="Enter a target tenant id."; return; }
    if(n>=3) loadImportContents(false);
    if(n===4) fillImReview();
    imStep=n;
    paintImSteps();
    $("#v-import").scrollIntoView({behavior:"smooth",block:"start"});
  }

  function fillImReview(){
    var tenant=$("#imTenant").value.trim();
    var selN=importSel.size;
    var modelIds={};
    (imSections||[]).forEach(function(s){ if(s.type==="model") (s.items||[]).forEach(function(it){ modelIds[it.id]=1; }); });
    var onlyModels=selN>0; importSel.forEach(function(id){ if(!modelIds[id]) onlyModels=false; });
    if(!selN) onlyModels=false;
    var contents=(imSourceTypes&&imSourceTypes.length)?imSourceTypes.join(", "):"(from folder)";
    var selTxt=selN
      ?(onlyModels?selN+" model(s) — schemas only":selN+" item(s) (deps auto-included)")
      :"everything in export ("+contents+")";
    $("#imReview").innerHTML='<dl>'+
      '<dt>Source</dt><dd>'+esc(imSourceLabel||$("#imDir").value||"—")+'</dd>'+
      '<dt>Path</dt><dd>'+esc($("#imDir").value||"—")+'</dd>'+
      '<dt>Target tenant</dt><dd>'+esc(tenant||"—")+'</dd>'+
      '<dt>Contents</dt><dd>'+esc(contents)+'</dd>'+
      '<dt>Selection</dt><dd>'+esc(selTxt)+'</dd>'+
      '<dt>Mode</dt><dd>'+($("#imDry").checked?"Dry run (no writes)":"Live import")+'</dd>'+
      '</dl>';
  }

  on($("#imModeServer"),"click",function(){ setImSrcMode("server"); });
  on($("#imModeUpload"),"click",function(){ setImSrcMode("upload"); });
  on($("#imExportQ"),"input",renderExportCards);
  on($("#imRefresh"),"click",loadExports);
  on($("#imNext1"),"click",function(){ if($("#imDir").value){ imMaxReached=Math.max(imMaxReached,2); goImStep(2); } });
  on($("#imBack2"),"click",function(){ goImStep(1); });
  on($("#imNext2"),"click",function(){
    if(!$("#imTenant").value.trim()){ $("#imTgtMsg").textContent="Enter a target tenant id."; return; }
    $("#imTgtMsg").textContent="";
    imMaxReached=Math.max(imMaxReached,3);
    goImStep(3);
  });
  on($("#imBack3"),"click",function(){ goImStep(2); });
  on($("#imNext3"),"click",function(){
    if(!(imSections&&imSections.length) && !importSel.size){
      $("#imItemsMsg").textContent="This export has nothing to import."; return;
    }
    $("#imItemsMsg").textContent="";
    imMaxReached=Math.max(imMaxReached,4);
    goImStep(4);
  });
  on($("#imBack4"),"click",function(){ goImStep(3); });
  for(var si=1;si<=4;si++){(function(step){
    on($("#imStepTab"+step),"click",function(){
      if(step<=imMaxReached) goImStep(step);
    });
  })(si);}

  var drop=$("#imDrop");
  on(drop,"click",function(){ $("#imZip").click(); });
  on(drop,"keydown",function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); $("#imZip").click(); } });
  on($("#imZip"),"change",function(){ var f=$("#imZip").files[0]; if(f) uploadZipFile(f); });
  ["dragenter","dragover"].forEach(function(ev){ on(drop,ev,function(e){ e.preventDefault(); drop.classList.add("drag"); }); });
  ["dragleave","drop"].forEach(function(ev){ on(drop,ev,function(e){ e.preventDefault(); drop.classList.remove("drag"); }); });
  on(drop,"drop",function(e){
    var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
    if(f) uploadZipFile(f);
  });

  paintImSteps();

  on($("#imGo"),"click",function(){
    var tenant=$("#imTenant").value.trim(); var dir=$("#imDir").value;
    if(!tenant){ $("#imMsg").textContent="Enter a target tenant id."; return; }
    if(!dir){ $("#imMsg").textContent="Choose an export source."; return; }
    $("#imGo").disabled=true; $("#imMsg").innerHTML='<span class="spin"></span> Importing… (live log below)';
    $("#imProgress").style.display="block"; $("#imOut").textContent="Starting…\\n";
    var dry=$("#imDry").checked;
    fetch("/api/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({targetTenant:tenant,dir:dir,selectedIds:Array.from(importSel),omittedDepIds:Array.from(importOmittedDeps),dryRun:dry,asDraft:$("#imAsDraft").checked,allowFolderMismatch:$("#imFolder").checked,allowSchemaMismatch:$("#imSchema").checked,continueOnError:$("#imCont").checked,uploadBinaries:$("#imUpload").checked,manifestOnly:$("#imManifest").checked,maxFileSize:$("#imMaxMb").value})})
      .then(function(r){return r.json();}).then(function(d){
        if(d.error){ $("#imGo").disabled=false; $("#imMsg").innerHTML='<span style="color:var(--red)">'+esc(d.error)+'</span>'; return; }
        $("#imBanner").innerHTML=(dry?'<b>Dry run</b> — no changes made. ':'')+'Live console below.';
        followJob(d.jobId, $("#imOut"), function(meta){
          $("#imGo").disabled=false;
          var ok=meta.status==="done";
          var okTxt=dry?"Dry run complete — nothing written":"Import complete";
          $("#imMsg").innerHTML=ok?'<span class="ok-msg">'+I.check+' '+okTxt+'</span>':'<span style="color:var(--red)">'+I.x+' Finished with errors</span>';
          if(!dry) $("#imBanner").innerHTML=$("#imBanner").innerHTML+s3Note($("#imOut").textContent);
          loadRuns();
        });
      }).catch(function(err){ $("#imGo").disabled=false; $("#imMsg").textContent="Request failed: "+err; });
  });

  // ─── COPY ─────────────────────────────────────────────────
  var sel=new Set(), omittedDeps=new Set(), CAT=null, CAT_FULL=null, cpLoadedFilters=null, cpLoadedModels="";
  typeChips($("#cpTypes"), true, EX_TNAME);
  syncFiltVisibility("cp");
  function cpRoute(){ var s=$("#cpSrc").value.trim(),t=$("#cpTgt").value.trim(); $("#rSrc").textContent=s||"—"; $("#rTgt").textContent=t||"—"; $("#route").style.visibility=(s&&t)?"visible":"hidden"; }
  on($("#cpSrc"),"input",cpRoute); on($("#cpTgt"),"input",cpRoute);
  toggleWrap("cpDry"); toggleWrap("cpAsDraft"); toggleWrap("cpSkip"); toggleWrap("cpSchema"); toggleWrap("cpFolder"); toggleWrap("cpCont");
  /** #{pfx}Models only counts as a filter value when the Content Models Filter row is on. */
  function modelsFilterValue(pfx){
    var cb=document.getElementById(pfx+"FiltOn-model");
    if(!cb||!cb.checked) return "";
    var el=$("#"+pfx+"Models"); return el?el.value.trim():"";
  }
  function markCpNeedsReload(){
    if(!CAT_FULL) return;
    var cur=collectFilters("cp");
    // Fingerprint every enabled row's date/name/tags/timezone + models so any change (incl. name-only) prompts Reload.
    var pushChanged=JSON.stringify({spec:cur.spec,models:cur.models})!==JSON.stringify({spec:cpLoadedFilters,models:cpLoadedModels});
    if(pushChanged){
      $("#cpReload").style.display="inline-flex";
      $("#cpReload").classList.add("primary");
      $("#cpLoadMsg").textContent="Filters changed — Reload with filters to re-fetch from source.";
    }
    $("#cpNarrow").style.display=CAT_FULL?"inline-flex":"none";
  }
  function cloneCatalog(c){
    return JSON.parse(JSON.stringify(c));
  }
  function matchItemLocal(it,spec){
    if(!filterActive(spec)) return true;
    var m=it.metadata||{};
    var dateSlice=(spec.dates&&spec.dates[it.type])||spec.date;
    if(dateSlice&&dateSlice.from&&dateSlice.to){
      var field=dateSlice.field==="modifiedOn"?"modifiedOn":"createdOn";
      var raw=field==="modifiedOn"?(m.modifiedOn||m.savedOn):(m.createdOn);
      if(raw){
        var ms=Date.parse(raw), from=Date.parse(dateSlice.from), to=Date.parse(dateSlice.to);
        if(!isNaN(ms)&&!isNaN(from)&&!isNaN(to)&&(ms<from||ms>to)) return false;
      }
    }
    for(var i=0;i<(spec.fields||[]).length;i++){
      var f=spec.fields[i];
      if(f.artifact&&f.artifact!==it.type) continue;
      var v=Array.isArray(f.value)?(f.value[0]||""):String(f.value||"");
      v=v.trim(); if(!v) continue;
      var key=f.field.toLowerCase();
      if(key==="name"||key==="title"||key==="path"){
        var needles=(Array.isArray(f.value)?f.value:String(f.value||"").split(",")).map(function(t){return String(t).toLowerCase().trim();}).filter(Boolean);
        var hay=((m.name||it.label||"")+" "+(m.path||"")).toLowerCase();
        if(needles.length&&!needles.some(function(n){return hay.indexOf(n)>=0;})) return false;
      } else if(key==="status"){
        if(String(m.status||"").toLowerCase().indexOf(v.toLowerCase())<0) return false;
      } else if(key==="tags"){
        var want=(Array.isArray(f.value)?f.value:String(f.value||"").split(",")).map(function(t){return String(t).toLowerCase().trim();}).filter(Boolean);
        var have=(m.tags||[]).map(function(t){return String(t).toLowerCase();});
        if(want.length&&have.length&&!want.every(function(t){return have.indexOf(t)>=0;})) return false;
      }
    }
    return true;
  }
  function loadCatalogWithFilters(){
    var s=$("#cpSrc").value.trim(); if(!s){ $("#cpLoadMsg").textContent="Enter a source tenant id."; return; }
    var types=chosen($("#cpTypes"));
    if(!types.length){ $("#cpLoadMsg").textContent="Select at least one artifact."; return; }
    var cf=collectFilters("cp");
    if(cf.error){ showFiltErr("cp",cf.error); updateFiltBadge("cp"); return; }
    clearFiltErr("cp");
    var filters=cf.spec;
    var models=cf.models;
    updateFiltBadge("cp");
    collapseFilt("cp");
    $("#cpLoad").disabled=true; $("#cpReload").disabled=true; $("#cpNarrow").disabled=true;
    $("#cpLoadMsg").innerHTML='<span class="spin"></span> Building catalog…';
    fetch("/api/catalog/build",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sourceTenant:s,types:types,models:models||undefined,filters:filterActive(filters)?filters:undefined})})
      .then(function(r){return r.json();}).then(function(c){
        $("#cpLoad").disabled=false; $("#cpReload").disabled=false; $("#cpNarrow").disabled=false;
        $("#cpReload").style.display="inline-flex"; $("#cpReload").classList.remove("primary");
        $("#cpNarrow").style.display="inline-flex";
        if(c.error){
          var detail=(c.detail||c.output||"").toString().trim();
          var snippet=detail?detail.slice(-900):"";
          $("#cpLoadMsg").innerHTML='<span style="color:var(--red)">'+esc(c.error)+'</span>'+
            (snippet?'<pre class="panel" style="margin-top:8px;max-height:180px;overflow:auto;font-size:11px;white-space:pre-wrap">'+esc(snippet)+'</pre>':'');
          return;
        }
        // Models-only chip: drop entry sections (catalog package still fetched models+entries).
        if(types.indexOf("cms-models")>=0&&types.indexOf("cms-entries")<0&&c.sections){
          c.sections=c.sections.filter(function(sec){ return sec.type!=="cms-entry"; });
          c.sections.forEach(function(sec){ sec.total=(sec.items||[]).length; });
        }
        CAT_FULL=cloneCatalog(c); CAT=c; cpLoadedFilters=filters; cpLoadedModels=models; sel.clear(); omittedDeps.clear();
        var n=(c.sections||[]).reduce(function(a,sec){return a+(sec.total||0);},0);
        $("#cpLoadMsg").textContent=(filterActive(filters)||models)?("Source-filtered catalog: "+n+" item(s). Select a page/entry to auto-include its file/model deps (even outside this filter)."):("Catalog: "+n+" item(s).");
        $("#cpSelect").style.display="block";
        $("#cpStageRun").style.display="block";
        renderCatalog();
        $("#cpSelect").scrollIntoView({behavior:"smooth",block:"start"});
      }).catch(function(err){ $("#cpLoad").disabled=false; $("#cpReload").disabled=false; $("#cpNarrow").disabled=false; $("#cpLoadMsg").textContent="Request failed: "+err; });
  }
  function narrowCatalogLocal(){
    if(!CAT_FULL){ $("#cpLoadMsg").textContent="Load a catalog first."; return; }
    var cf=collectFilters("cp");
    if(cf.error){ showFiltErr("cp",cf.error); updateFiltBadge("cp"); return; }
    clearFiltErr("cp");
    var filters=cf.spec;
    updateFiltBadge("cp");
    collapseFilt("cp");
    var view=cloneCatalog(CAT_FULL);
    view.sections=(view.sections||[]).map(function(sec){
      var items=(sec.items||[]).filter(function(it){return matchItemLocal(it,filters);});
      return Object.assign({},sec,{items:items,total:items.length});
    });
    CAT=view; sel.clear(); omittedDeps.clear();
    var n=view.sections.reduce(function(a,sec){return a+sec.total;},0);
    $("#cpLoadMsg").textContent="Narrowed in browser: "+n+" item(s) (no API call). Use Reload for date/tags pushdown.";
    renderCatalog();
  }
  on($("#cpLoad"),"click",loadCatalogWithFilters);
  on($("#cpReload"),"click",loadCatalogWithFilters);
  on($("#cpNarrow"),"click",narrowCatalogLocal);
  // Short date: "2026-06-15 18:42" from an ISO string.
  function fmtDate(s){ if(!s) return "—"; return String(s).replace("T"," ").slice(0,16); }
  function td(v){ return '<td>'+esc(v==null||v===""?"—":v)+'</td>'; }
  // Bytes → "1.23 MB". null/undefined → "—".
  function fmtMB(b){ return (b==null||b==="")?"—":(Number(b)/1048576).toFixed(2)+" MB"; }

  // Column definitions per section type. Each col: l=label, cls=td class,
  // num=right-align/numeric-sort, h(it,m)=cell inner HTML, s(it,m)=sort key.
  // Name/Path/Size etc. are sortable; the checkbox and Deps columns are not.
  function colsFor(sec){
    var name={l:"Name",cls:"cName",h:function(it,m){return esc(m.name||it.label||it.id)+'<div class="sub">'+esc(it.id)+'</div>';},s:function(it,m){return String(m.name||it.label||it.id||"").toLowerCase();}};
    if(sec.type==="model") return [
      name,
      {l:"Fields",cls:"num",num:true,h:function(it,m){return esc(m.fields==null?"—":m.fields);},s:function(it,m){return Number(m.fields)||0;}},
      {l:"Entries",cls:"num",num:true,h:function(it,m){return esc(m.entries==null?"—":m.entries);},s:function(it,m){return Number(m.entries)||0;}}
    ];
    if(sec.type==="cms-entry") return [
      name,
      {l:"Site",h:function(it,m){return esc(m.siteId==null||m.siteId===""?"—":m.siteId);},s:function(it,m){return String(m.siteId||"").toLowerCase();}},
      {l:"Path",cls:"path",h:function(it,m){return esc(m.path||m.folderPath||"/");},s:function(it,m){return String(m.path||m.folderPath||"/").toLowerCase();}},
      {l:"Author",h:function(it,m){return esc(m.author==null||m.author===""?"—":m.author);},s:function(it,m){return String(m.author||"").toLowerCase();}},
      {l:"Created",cls:"dt",h:function(it,m){return esc(fmtDate(m.createdOn));},s:function(it,m){return String(m.createdOn||"");}},
      {l:"Modified",cls:"dt",h:function(it,m){return esc(fmtDate(m.modifiedOn));},s:function(it,m){return String(m.modifiedOn||"");}},
      {l:"Status",h:function(it,m){return esc(m.status==null||m.status===""?"—":m.status);},s:function(it,m){return String(m.status||"").toLowerCase();}},
      {l:"Live",h:function(it,m){return m.live?'<span class="lv on">Yes</span>':'<span class="lv">No</span>';},s:function(it,m){return m.live?1:0;},num:true},
      {l:"Ver",cls:"dt",h:function(it,m){return m.live?esc(m.version==null?"?":m.version):"—";},s:function(it,m){return Number(m.version)||0;},num:true}
    ];
    if(sec.type==="page") return [
      name,
      {l:"Path",cls:"path",h:function(it,m){return esc(m.path||m.folderPath||"/");},s:function(it,m){return String(m.path||m.folderPath||"/").toLowerCase();}},
      {l:"Author",h:function(it,m){return esc(m.author==null||m.author===""?"—":m.author);},s:function(it,m){return String(m.author||"").toLowerCase();}},
      {l:"Created",cls:"dt",h:function(it,m){return esc(fmtDate(m.createdOn));},s:function(it,m){return String(m.createdOn||"");}},
      {l:"Modified",cls:"dt",h:function(it,m){return esc(fmtDate(m.modifiedOn));},s:function(it,m){return String(m.modifiedOn||"");}},
      {l:"Status",h:function(it,m){return esc(m.status==null||m.status===""?"—":m.status);},s:function(it,m){return String(m.status||"").toLowerCase();}},
      {l:"Live",h:function(it,m){return m.live?'<span class="lv on">Yes</span>':'<span class="lv">No</span>';},s:function(it,m){return m.live?1:0;},num:true},
      {l:"Ver",cls:"dt",h:function(it,m){return m.live?esc(m.version==null?"?":m.version):"—";},s:function(it,m){return Number(m.version)||0;},num:true}
    ];
    if(sec.type==="file") return [
      name,
      {l:"Type",h:function(it,m){return esc(m.mimeType==null||m.mimeType===""?"—":m.mimeType);},s:function(it,m){return String(m.mimeType||"").toLowerCase();}},
      {l:"Tags",h:function(it,m){var t=m.tags; return esc(!t||!t.length?"—":(Array.isArray(t)?t.join(", "):String(t)));},s:function(it,m){return String((m.tags||[]).join(",")||"").toLowerCase();}},
      {l:"Size",cls:"num",num:true,h:function(it,m){return esc(fmtMB(m.size));},s:function(it,m){return Number(m.size)||0;}},
      {l:"Created",cls:"dt",h:function(it,m){return esc(fmtDate(m.createdOn));},s:function(it,m){return String(m.createdOn||"");}},
      {l:"Modified",cls:"dt",h:function(it,m){return esc(fmtDate(m.modifiedOn));},s:function(it,m){return String(m.modifiedOn||"");}}
    ];
    return [{l:"Name",cls:"cName",h:function(it,m){return esc(it.label||it.id);},s:function(it,m){return String(it.label||it.id||"").toLowerCase();}},
      {l:"ID",cls:"path",h:function(it,m){return esc(it.id);},s:function(it){return String(it.id||"").toLowerCase();}}];
  }

  // Build one section's table from colsFor(). Sortable th carry data-col
  // (index into cols) + data-num; cells carry data-sort. Wired up in wireTable.
  function sectionTable(sec,selSet){
    var cols=colsFor(sec);
    var head='<thead><tr><th class="cbx"><input type="checkbox" class="cb2 cball" title="Select all"></th>'+cols.map(function(c,i){
      return '<th class="srt'+(c.num?" num":"")+'" data-col="'+i+'"'+(c.num?' data-num="1"':"")+'>'+esc(c.l)+'<span class="ar"></span><span class="rsz"></span></th>';
    }).join("")+'<th>Deps</th></tr></thead>';
    var body='<tbody>'+sec.items.map(function(it){
      var m=it.metadata||{};
      var dep=(it.dependsOn&&it.dependsOn.length)?'<span class="dep">+'+it.dependsOn.length+'</span>':"";
      var cb='<td class="cbx"><input type="checkbox" class="cb2" '+(selSet.has(it.id)?"checked":"")+'></td>';
      var cells=cols.map(function(c){
        var sv=c.s?c.s(it,m):""; if(typeof sv==="string") sv=sv.replace(/"/g,"&quot;");
        return '<td'+(c.cls?' class="'+c.cls+'"':"")+' data-sort="'+sv+'">'+c.h(it,m)+'</td>';
      }).join("");
      return '<tr class="trow'+(selSet.has(it.id)?" sel":"")+'" data-id="'+esc(it.id)+'">'+cb+cells+'<td>'+dep+'</td></tr>';
    }).join("")+'</tbody>';
    return '<div class="rows"><table class="ctab">'+head+body+'</table></div>';
  }

  // Sort + column-resize for one rendered .ctab. Click a sortable th to sort
  // its column (toggles asc/desc); drag the right edge to resize.
  function wireTable(tbl){
    var tbody=tbl.querySelector("tbody");
    tbl.querySelectorAll("th.srt").forEach(function(th){
      var ci=+th.getAttribute("data-col")+1; // +1 for the checkbox column
      var num=th.hasAttribute("data-num");
      on(th,"click",function(e){
        if(e.target.classList.contains("rsz")) return;
        var asc=!th.classList.contains("asc");
        tbl.querySelectorAll("th").forEach(function(o){o.classList.remove("asc","desc");});
        th.classList.add(asc?"asc":"desc");
        var rows=Array.prototype.slice.call(tbody.querySelectorAll("tr"));
        rows.sort(function(a,b){
          var x=a.cells[ci].getAttribute("data-sort"), y=b.cells[ci].getAttribute("data-sort");
          var r= num ? (parseFloat(x)||0)-(parseFloat(y)||0) : String(x).localeCompare(String(y));
          return asc?r:-r;
        });
        rows.forEach(function(r){tbody.appendChild(r);});
      });
      var grip=th.querySelector(".rsz");
      if(grip) on(grip,"mousedown",function(e){
        e.preventDefault(); e.stopPropagation();
        var x0=e.pageX, w0=th.offsetWidth;
        function mv(ev){ th.style.width=Math.max(40,w0+ev.pageX-x0)+"px"; }
        function up(){ document.removeEventListener("mousemove",mv); document.removeEventListener("mouseup",up); }
        document.addEventListener("mousemove",mv); document.addEventListener("mouseup",up);
      });
    });
  }

  /** Labels of still-checked parents that list depId in dependsOn. */
  function parentsNeeding(depId, selSet, catalog){
    if(!catalog||!catalog.sections) return [];
    var labels=[];
    catalog.sections.forEach(function(sec){
      (sec.items||[]).forEach(function(it){
        if(!selSet.has(it.id)) return;
        var deps=it.dependsOn||[];
        if(deps.indexOf(depId)>=0) labels.push(it.label||it.id);
      });
    });
    return labels;
  }
  function guessDepType(id){
    // Avoid /...\/.../ regex literals inside the PAGE template literal — \/ collapses and breaks the script.
    var s=String(id||"");
    if(s.indexOf("http://")===0||s.indexOf("https://")===0||s.indexOf("/files/")>=0||s.indexOf("/")>=0) return "file";
    return "model";
  }
  /** Merge missing dep ids into a catalog as stub rows (auto-included), check them. */
  function ensureDepRowsInCatalog(selSet, catalog, omitSet){
    catalog=catalog||CAT;
    omitSet=omitSet||omittedDeps;
    if(!catalog||!catalog.sections) return 0;
    var byId={};
    catalog.sections.forEach(function(sec){ (sec.items||[]).forEach(function(it){ byId[it.id]=it; }); });
    var stack=Array.from(selSet), seen=new Set(stack), added=0;
    while(stack.length){
      var id=stack.pop();
      var it=byId[id];
      if(!it||!it.dependsOn) continue;
      it.dependsOn.forEach(function(dep){
        if(seen.has(dep)) return;
        seen.add(dep); stack.push(dep);
        if(omitSet&&omitSet.has(dep)) return; // user intentionally unchecked
        if(!byId[dep]){
          var typ=guessDepType(dep);
          var stub={type:typ,id:dep,label:(dep.split("/").pop()||dep),metadata:{autoDep:true},dependsOn:[]};
          var sec=catalog.sections.find(function(s){return s.type===typ;});
          if(!sec){ sec={type:typ,total:0,items:[]}; catalog.sections.push(sec); }
          sec.items.push(stub); sec.total=sec.items.length; byId[dep]=stub; added++;
        } else {
          // Already on disk / in catalog — still tag as auto-included for badge + summary.
          byId[dep].metadata=byId[dep].metadata||{};
          if(!byId[dep].metadata.autoDep){ byId[dep].metadata.autoDep=true; added++; }
        }
        if(!selSet.has(dep)){ selSet.add(dep); added++; }
      });
    }
    return added;
  }
  /** Drop auto-included deps that no remaining selected parent still references. */
  function pruneOrphanAutoDeps(selSet, catalog){
    if(!catalog||!catalog.sections) return 0;
    var byId={};
    catalog.sections.forEach(function(sec){ (sec.items||[]).forEach(function(it){ byId[it.id]=it; }); });
    var removed=0, changed=true;
    while(changed){
      changed=false;
      Array.from(selSet).forEach(function(id){
        var it=byId[id];
        if(!it||!it.metadata||!it.metadata.autoDep) return;
        if(parentsNeeding(id, selSet, catalog).length) return;
        selSet.delete(id);
        removed++;
        changed=true;
      });
    }
    return removed;
  }
  // Dependency omit modal — same chrome as purge confirm (Keep / Remove anyway).
  var depModalPending=null;
  function closeDepModal(){
    $("#depModal").style.display="none";
    depModalPending=null;
  }
  function openDepRemoveModal(opts){
    var label=opts.depLabel||opts.depId;
    var parents=opts.parents||[];
    var shown=parents.slice(0,3);
    var more=parents.length>3?("<li>and "+(parents.length-3)+" more…</li>"):"";
    $("#depModalBody").innerHTML=
      "<p><b>"+esc(label)+"</b> was auto-included because these selected items reference it:</p>"+
      "<ul class=\\"warn-list\\">"+shown.map(function(p){return "<li>"+esc(p)+"</li>";}).join("")+more+"</ul>"+
      "<p style=\\"margin-top:12px\\">Removing it may migrate without this asset or schema (broken image / missing model on the target).</p>";
    depModalPending=opts;
    $("#depModal").style.display="grid";
    $("#depKeep").focus();
  }
  on($("#depKeep"),"click",function(){
    var p=depModalPending; closeDepModal(); if(p&&p.onKeep) p.onKeep();
  });
  on($("#depRemove"),"click",function(){
    var p=depModalPending; closeDepModal(); if(p&&p.onRemove) p.onRemove();
  });
  on($("#depModal"),"click",function(e){
    if(e.target===$("#depModal")){ var p=depModalPending; closeDepModal(); if(p&&p.onKeep) p.onKeep(); }
  });
  document.addEventListener("keydown",function(e){
    if(e.key!=="Escape") return;
    if($("#depModal").style.display==="grid"){
      var p=depModalPending; closeDepModal(); if(p&&p.onKeep) p.onKeep();
    }
  });

  // Generic selectable catalog renderer — reused by Migrate, Import (and Purge).
  // Renders sections into hostSel, tracks ticks in selSet, calls onCount()
  // after any change. Empty sections render an explicit "none" row.
  // opts: { autoDeps, catalog, onAfterToggle }
  function renderSelectable(hostSel, sections, selSet, onCount, opts){
    opts=opts||{};
    var host=$(hostSel); host.innerHTML="";
    if(!sections || !sections.length){ host.innerHTML='<span class="muted">Nothing to list.</span>'; onCount&&onCount(); return; }
    function tgl(id,onv,cb){
      if(!onv && opts.autoDeps && opts.catalog){
        selSet.delete(id);
        var others=parentsNeeding(id, selSet, opts.catalog);
        if(others.length){
          // Keep checked until the modal decides (same safety as purge confirm).
          selSet.add(id);
          if(cb) cb.checked=true;
          var rKeep=cb&&cb.closest(".trow"); if(rKeep) rKeep.classList.add("sel");
          openDepRemoveModal({
            depId:id,
            depLabel:(id.split("/").pop()||id),
            parents:others,
            onKeep:function(){ onCount&&onCount(); },
            onRemove:function(){
              selSet.delete(id);
              if(opts.omitSet) opts.omitSet.add(id);
              if(cb) cb.checked=false;
              var r=cb&&cb.closest(".trow"); if(r) r.classList.remove("sel");
              onCount&&onCount();
              if(opts.onAfterToggle) opts.onAfterToggle(id,false);
            }
          });
          return;
        }
        // Parent (or orphan dep) unchecked — clear auto-deps nothing still needs.
        var pruned=pruneOrphanAutoDeps(selSet, opts.catalog);
        var rOff=cb&&cb.closest(".trow"); if(rOff) rOff.classList.remove("sel");
        if(pruned>0 && opts.onDepsMerged){ opts.onDepsMerged(); return; }
        onCount&&onCount();
        if(opts.onAfterToggle) opts.onAfterToggle(id,false);
        return;
      } else if(onv){
        selSet.add(id);
        if(opts.omitSet) opts.omitSet.delete(id);
      } else {
        selSet.delete(id);
      }
      var r=cb&&cb.closest(".trow"); if(r) r.classList.toggle("sel", !!selSet.has(id));
      if(onv && opts.autoDeps){
        var n=ensureDepRowsInCatalog(selSet, opts.catalog, opts.omitSet);
        if(n>0 && opts.onDepsMerged){ opts.onDepsMerged(); return; }
      }
      onCount&&onCount();
      if(opts.onAfterToggle) opts.onAfterToggle(id,onv);
    }
    sections.forEach(function(sec){
      if(!sec.items) return;
      var empty = sec.items.length===0;
      var bay=document.createElement("div"); bay.className="bay";
      bay.innerHTML='<div class="bay-h"><span class="tag '+esc(sec.type)+'">'+esc(sec.type)+'</span>'+
        '<span class="nm">'+esc(CTNAME[sec.type]||sec.type)+'</span><span class="ct">'+sec.items.length+'</span>'+
        (empty?'':'<span class="selall">select all</span>')+'</div>'+
        (sec.note?'<div class="note">'+esc(sec.note)+'</div>':'')+
        (empty?'<div class="emptyrow muted">No '+esc(CTNAME[sec.type]||sec.type)+' (0).</div>':sectionTable(sec,selSet));
      host.appendChild(bay);
      if(empty) return;
      var tbl=bay.querySelector(".ctab"); if(tbl) wireTable(tbl);
      var cball=bay.querySelector(".cball");
      // Reflect row state on the header box: checked=all, indeterminate=some.
      function syncAll(){ var cbs=bay.querySelectorAll(".trow .cb2"), n=cbs.length,
        on=Array.prototype.filter.call(cbs,function(c){return c.checked;}).length;
        if(cball){ cball.checked=on===n&&n>0; cball.indeterminate=on>0&&on<n; } }
      function setAll(v){ bay.querySelectorAll(".trow .cb2").forEach(function(cb){ cb.checked=v; tgl(cb.closest(".trow").getAttribute("data-id"),v,cb); }); syncAll(); }
      if(cball) on(cball,"change",function(e){ e.stopPropagation(); setAll(cball.checked); });
      on(bay.querySelector(".selall"),"click",function(){
        var cbs=bay.querySelectorAll(".trow .cb2"); var allOn=Array.prototype.every.call(cbs,function(c){return c.checked;});
        setAll(!allOn);
      });
      bay.querySelectorAll(".trow").forEach(function(r){
        var cb=r.querySelector(".cb2"), id=r.getAttribute("data-id");
        var it=(sec.items||[]).find(function(x){return x.id===id;});
        if(it&&it.metadata&&it.metadata.autoDep){
          r.classList.add("auto-dep");
          var nameCell=r.querySelector("td.cName");
          if(nameCell&&!nameCell.querySelector(".dep-auto")){
            nameCell.insertAdjacentHTML("beforeend",'<span class="dep-auto">dep</span>');
          }
        }
        on(cb,"change",function(e){ e.stopPropagation(); tgl(id,cb.checked,cb); syncAll(); });
        on(r,"click",function(e){ if(e.target===cb) return; cb.checked=!cb.checked; tgl(id,cb.checked,cb); syncAll(); });
      });
      syncAll();
    });
    onCount&&onCount();
  }
  var cpDepAutoCount=0;
  function renderCatalog(){
    if(!CAT||!CAT.sections){ $("#cpCatalog").innerHTML='<span class="glitch">No catalog.</span>'; return; }
    renderSelectable("#cpCatalog", CAT.sections, sel, cpSelN, {
      autoDeps:true,
      catalog:CAT,
      omitSet:omittedDeps,
      onDepsMerged:function(){ renderCatalog(); }
    });
  }
  function syncMigrateMode(){
    var mode=$("#cpMode"), lab=$("#cpModeLab"), desc=$("#cpModeDesc");
    if(!mode) return;
    var hasSel=sel.size>0;
    mode.classList.toggle("on-sel", hasSel);
    if(lab) lab.textContent=hasSel?"Migrate selection":"Ready";
    if(desc) desc.textContent=hasSel
      ?("Migrates "+sel.size+" checked item(s) (deps included) in dependency order. Dry-run writes nothing.")
      :"Select at least one item above. Migration runs in dependency order (models → files → entries → pages → redirects).";
  }
  function cpSelN(){
    var auto=0;
    if(CAT&&CAT.sections){
      CAT.sections.forEach(function(sec){
        (sec.items||[]).forEach(function(it){
          if(sel.has(it.id)&&it.metadata&&it.metadata.autoDep) auto++;
        });
      });
    }
    cpDepAutoCount=auto;
    $("#cpSelN").textContent=auto
      ?("("+sel.size+" selected, "+auto+" dep auto-included)")
      :("("+sel.size+" selected)");
    syncMigrateMode();
  }
  on($("#cpClr"),"click",function(){ sel.clear(); omittedDeps.clear(); renderCatalog(); });
  on($("#cpGo"),"click",function(){
    if(!sel.size){ $("#cpGoMsg").textContent="Select at least one item."; return; }
    var src=$("#cpSrc").value.trim(),tgt=$("#cpTgt").value.trim();
    if(!src||!tgt){ $("#cpGoMsg").textContent="Source and target tenant required."; return; }
    $("#cpGo").disabled=true; $("#cpGoMsg").innerHTML='<span class="spin"></span> Running migration… (live log below)';
    $("#cpProgress").style.display="block"; $("#cpOut").textContent="Starting…\\n";
    var dry=$("#cpDry").checked;
    fetch("/api/migrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      sourceTenant:src,targetTenant:tgt,selectedIds:Array.from(sel),
      omittedDepIds:Array.from(omittedDeps),
      dryRun:dry,asDraft:$("#cpAsDraft").checked,skipExport:$("#cpSkip").checked,allowSchemaMismatch:$("#cpSchema").checked,allowFolderMismatch:$("#cpFolder").checked,continueOnError:$("#cpCont").checked,
      maxFileSize:$("#cpMaxMb").value
    })}).then(function(r){return r.json();}).then(function(d){
      if(d.error){ $("#cpGo").disabled=false; $("#cpGoMsg").innerHTML='<span style="color:var(--red)">'+esc(d.error)+'</span>'; return; }
      var ids={bar:"#cpBar",ok:"#cpOk",err:"#cpErrN",tot:"#cpTot",items:"#cpItems"};
      if(d.dryRun){
        var prev=d.preview||[];
        renderProgress({items:prev},true,ids);
      }
      followJob(d.jobId, $("#cpOut"), function(meta){
        $("#cpGo").disabled=false;
        var ok=meta.status==="done";
        if(dry){
          $("#cpGoMsg").innerHTML='<span class="ok-msg">'+I.check+' Dry run finished</span>';
        } else {
          $("#cpGoMsg").innerHTML=ok?'<span class="ok-msg">'+I.check+' Migration complete</span>':'<span style="color:var(--red)">'+I.x+' Finished with errors</span>';
          fetch("/api/runs").then(function(r){return r.json();}).then(function(rs){
            if(rs&&rs[0]) fetch("/api/runs/"+encodeURIComponent(rs[0].id)).then(function(r){return r.json();}).then(function(run){ renderProgress(run,false,ids); });
          });
          loadRuns();
        }
        $("#cpS3").innerHTML=dry?"":s3Note($("#cpOut").textContent);
      });
      $("#cpProgress").scrollIntoView({behavior:"smooth"});
    }).catch(function(err){ $("#cpGo").disabled=false; $("#cpGoMsg").textContent="Request failed: "+err; });
  });

  // shared progress renderer (run ledger → stats + item list)
  function renderProgress(run,dry,ids){
    if(!run){ $(ids.items).innerHTML='<div class="it muted" style="padding:14px">No run recorded'+(dry?" (dry-run)":"")+'.</div>'; $(ids.ok).textContent="0"; $(ids.err).textContent="0"; $(ids.tot).textContent="0"; $(ids.bar).style.width="0"; return; }
    var items=run.items||[]; var ok=0,err=0;
    items.forEach(function(it){ if(it.status==="done")ok++; else if(it.status==="error")err++; });
    $(ids.ok).textContent=ok; $(ids.err).textContent=err; $(ids.tot).textContent=items.length;
    var bi=$(ids.bar); bi.style.width=items.length?Math.round((ok/items.length)*100)+"%":"0"; bi.classList.toggle("err",err>0&&ok===0);
    var ACT_LABEL={"skipped-large":"skipped (large)","uploaded":"uploaded","registered":"registered"};
    $(ids.items).innerHTML=items.map(function(it){
      var cls=it.status==="done"?"ok":it.status==="error"?"err":"skip";
      var m=it.status==="done"?I.check:it.status==="error"?I.x:"·";
      var actRaw=it.error||it.action||it.status;
      var actLbl=ACT_LABEL[actRaw]||actRaw;
      return '<div class="it '+cls+'"><span class="m">'+m+'</span><span class="tag '+esc(it.type)+'" style="padding:1px 7px">'+esc(it.type)+'</span>'+
        '<span class="id">'+esc(it.id)+'</span><span class="act">'+esc(actLbl)+'</span></div>';
    }).join("")||'<div class="it muted" style="padding:14px">No items.</div>';
  }

  // ─── LOGS ─────────────────────────────────────────────────
  var RUNS=[];
  var lgWsFilter="all";
  var lgListScroll=0;
  var lgWsCount=0;

  function shortId(id){
    if(!id) return "?";
    if(id.length<=28) return id;
    return id.slice(0,12)+"…"+id.slice(-8);
  }

  function loadRuns(){
    Promise.all([
      fetch("/api/metrics").then(function(r){return r.json();}).catch(function(){return null;}),
      fetch("/api/runs").then(function(r){return r.json();}).catch(function(){return [];}),
      fetch("/api/logs").then(function(r){return r.json();}).catch(function(){return [];})
    ]).then(function(triple){
      var a=triple[0];
      // Merge item ledgers into the matching workstream console row (same run id).
      // Orphans (legacy .runs/ with no console) stay as separate ledger rows.
      var ledgerById={};
      (triple[1]||[]).forEach(function(r){ ledgerById[r.id]=r; });
      var ws=(triple[2]||[]).map(function(m){
        var led=ledgerById[m.runId];
        if(led) delete ledgerById[m.runId];
        return {id:m.runId,status:m.status,createdAt:m.startedAt,finishedAt:m.endedAt||null,
          environment:{tenant:m.targetTenant||m.sourceTenant||"?",role:m.workstream},
          summary:led?(led.summary||{}):{},
          _kind:"workstream",_workstream:m.workstream,_hasLedger:!!led,
          sourceTenant:m.sourceTenant||null,targetTenant:m.targetTenant||null,
          argsSummary:m.argsSummary||""};
      });
      var orphans=Object.keys(ledgerById).map(function(id){
        var r=ledgerById[id];
        return {id:r.id,status:r.status,createdAt:r.createdAt,environment:r.environment,summary:r.summary||{},
          _kind:"ledger",_workstream:null,_hasLedger:true,
          sourceTenant:r.environment&&r.environment.tenant,targetTenant:null,finishedAt:null};
      });
      lgWsCount=ws.length;

      var ledgerChip=$("#lgLedgerChip");
      if(ledgerChip){
        ledgerChip.style.display=orphans.length?"":"none";
        if(!orphans.length && lgWsFilter==="ledger"){
          lgWsFilter="all";
          $("#lgWsFilters").querySelectorAll(".ws-chip").forEach(function(c){ c.classList.toggle("on",c.getAttribute("data-ws")==="all"); });
        }
      }

      var wsDone=0, wsErr=0, wsRun=0;
      ws.forEach(function(r){
        if(r.status==="done") wsDone++;
        else if(r.status==="error") wsErr++;
        else wsRun++;
      });
      $("#lgMetHdr").textContent="· "+ws.length+" console run(s)"+(orphans.length?" · "+orphans.length+" orphan ledger(s)":"");
      var html='<div class="pgrid">'+
        '<div class="stat tot"><div class="n">'+ws.length+'</div><div class="u">Runs</div></div>'+
        '<div class="stat ok"><div class="n">'+wsDone+'</div><div class="u">Done</div></div>'+
        '<div class="stat err"><div class="n">'+wsErr+'</div><div class="u">Errors</div></div></div>';
      if(wsRun) html+='<div class="muted" style="margin-top:8px;font-size:12.5px">'+wsRun+' still running</div>';
      if(a && a.items){
        html+='<div class="muted" style="margin-top:8px;font-size:12.5px">Item audit: '+(a.items||0)+' item(s) across '+(a.runs||0)+' ledger(s)'+
          ((a.failedRuns||0)?' · '+(a.failedRuns)+' failed run(s)':'')+'</div>';
      }
      $("#lgMetrics").innerHTML=html;

      RUNS=orphans.concat(ws).sort(function(a,b){return (a.createdAt<b.createdAt?1:-1);});
      filterRuns();
    });
  }

  function lgBoundMs(value){
    if(!value) return null;
    var t=Date.parse(value);
    return isNaN(t)?null:t;
  }
  function filterRuns(){
    var q=$("#lgQ").value.trim().toLowerCase();
    var fromMs=lgBoundMs($("#lgFrom").value), toMs=lgBoundMs($("#lgTo").value);
    var out=RUNS.filter(function(r){
      if(lgWsFilter==="ledger"){ if(r._kind!=="ledger") return false; }
      else if(lgWsFilter!=="all"){ if(r._workstream!==lgWsFilter) return false; }
      var created=Date.parse(r.createdAt||"");
      if(!isNaN(created)){
        if(fromMs!=null&&created<fromMs) return false;
        if(toMs!=null&&created>toMs) return false;
      }
      if(q){
        var hay=(r.id+" "+r.status+" "+(r.environment&&r.environment.tenant||"")+" "+(r._workstream||"ledger")+" "+(r.sourceTenant||"")+" "+(r.targetTenant||"")).toLowerCase();
        if(hay.indexOf(q)<0) return false;
      }
      return true;
    });
    $("#lgCount").textContent="· "+out.length+" of "+RUNS.length;
    var host=$("#lgRuns");
    if(!out.length){ host.innerHTML='<span class="muted">No runs match.</span>'; return; }
    host.innerHTML="";
    out.forEach(function(r){
      var s=r.summary||{}; var st=r.status||"";
      var pill=st==="done"||st.indexOf("complete")>=0?"complete":st==="error"||st.indexOf("fail")>=0||(s.error>0)?"failed":"in-progress";
      var wsLabel=r._kind==="ledger"?"orphan-ledger":(r._workstream||"?");
      var badgeClass=r._kind==="ledger"?"ledger":(r._workstream||"");
      var row=document.createElement("div"); row.className="runrow";
      var stats=r._hasLedger
        ?('<span class="faint" style="font-size:11.5px">done '+(s.done||0)+' · err '+(s.error||0)+' · pend '+(s.pending||0)+'</span>')
        :(r._kind==="ledger"
          ?('<span class="faint" style="font-size:11.5px">done '+(s.done||0)+' · err '+(s.error||0)+'</span>')
          :('<span class="faint" style="font-size:11.5px">console</span>'));
      row.innerHTML='<span class="ws-badge '+esc(badgeClass)+'">'+esc(wsLabel)+'</span>'+
        '<span class="pill '+pill+'">'+esc(st||"?")+'</span>'+
        '<span class="mono" style="font-size:12px" title="'+esc(r.id)+'">'+esc(shortId(r.id))+'</span>'+
        '<span class="muted" style="font-size:12px">'+esc(r.environment&&r.environment.tenant||"?")+'</span>'+
        '<span class="spacer" style="flex:1"></span>'+stats+
        '<span class="faint" style="font-size:11px;margin-left:10px">'+esc((r.createdAt||"").replace("T"," ").slice(0,19))+'</span>';
      on(row,"click",function(){ showRun(r); });
      host.appendChild(row);
    });
  }

  function showRun(r){
    lgListScroll=$("#lgListWrap").scrollTop||0;
    $("#lgBrowse").style.display="none";
    $("#lgDetail").style.display="block";
    var wsLabel=r._kind==="ledger"?"orphan-ledger":(r._workstream||"?");
    var badgeClass=r._kind==="ledger"?"ledger":(r._workstream||"");
    var st=r.status||"?";
    $("#lgHead").innerHTML='<div class="row1">'+
      '<span class="ws-badge '+esc(badgeClass)+'">'+esc(wsLabel)+'</span>'+
      '<span class="pill '+(st==="done"||st.indexOf("complete")>=0?"complete":st==="error"||st.indexOf("fail")>=0?"failed":"in-progress")+'">'+esc(st)+'</span>'+
      '<span class="mono" style="font-size:12.5px">'+esc(r.id)+'</span></div>'+
      '<div class="meta">'+
      (r.sourceTenant?'<span>Source <b>'+esc(r.sourceTenant)+'</b></span>':'')+
      (r.targetTenant?'<span>Target <b>'+esc(r.targetTenant)+'</b></span>':'')+
      (!r.sourceTenant&&!r.targetTenant?'<span>Tenant <b>'+esc(r.environment&&r.environment.tenant||"?")+'</b></span>':'')+
      '<span>Started <b>'+esc((r.createdAt||"").replace("T"," ").slice(0,19)||"—")+'</b></span>'+
      (r.finishedAt?'<span>Finished <b>'+esc(String(r.finishedAt).replace("T"," ").slice(0,19))+'</b></span>':'')+
      (r.argsSummary?'<span>Args <b>'+esc(r.argsSummary)+'</b></span>':'')+
      '</div>';

    if(r._workstream){
      var showLedger=!!r._hasLedger;
      $("#lgStats").style.display=showLedger?"":"none";
      $("#lgBarWrap").style.display=showLedger?"":"none";
      $("#lgLedgerFold").style.display=showLedger?"":"none";
      $("#lgLedgerFold").open=true;
      $("#lgItemsHdr").textContent="";
      $("#lgItems").innerHTML="";
      $("#lgConsoleFold").style.display="";
      $("#lgConsoleFold").open=true;
      $("#lgConsolePanel").innerHTML='<div class="it muted" style="padding:14px"><span class="spin"></span> Loading…</div>';
      var consoleP=fetch("/api/logs/"+encodeURIComponent(r._workstream)+"/"+encodeURIComponent(r.id)).then(function(res){return res.json();});
      var ledgerP=showLedger
        ? fetch("/api/runs/"+encodeURIComponent(r.id)).then(function(res){return res.ok?res.json():null;}).catch(function(){return null;})
        : Promise.resolve(null);
      Promise.all([consoleP, ledgerP]).then(function(pair){
        var d=pair[0], run=pair[1];
        if(d&&!d.error){
          $("#lgConsolePanel").innerHTML='<pre class="console">'+esc(d.console||"(empty)")+'</pre>';
        } else {
          $("#lgConsolePanel").innerHTML='<div class="it muted" style="padding:14px">'+(d&&d.error?esc(d.error):"No console log.")+'</div>';
        }
        if(run){
          $("#lgLedgerFold").style.display="";
          renderProgress(run,false,{bar:"#lgBar",ok:"#lgOk",err:"#lgErr",tot:"#lgTot",items:"#lgItems"});
          var n=(run.items&&run.items.length)||0;
          $("#lgItemsHdr").textContent=n?("· "+n+" item(s)"):"";
        } else if(showLedger){
          $("#lgLedgerFold").style.display="";
          $("#lgItemsHdr").textContent="";
          $("#lgItems").innerHTML='<div class="it muted" style="padding:14px">No item ledger for this run.</div>';
        }
        $("#lgDetail").scrollIntoView({behavior:"smooth"});
      });
      return;
    }
    $("#lgStats").style.display="";
    $("#lgBarWrap").style.display="";
    $("#lgConsoleFold").style.display="none";
    $("#lgConsolePanel").innerHTML="";
    $("#lgLedgerFold").style.display="";
    $("#lgLedgerFold").open=true;
    $("#lgItemsHdr").textContent="";
    $("#lgItems").innerHTML="";
    fetch("/api/runs/"+encodeURIComponent(r.id)).then(function(res){return res.json();}).then(function(run){
      renderProgress(run,false,{bar:"#lgBar",ok:"#lgOk",err:"#lgErr",tot:"#lgTot",items:"#lgItems"});
      var n=(run.items&&run.items.length)||0;
      $("#lgItemsHdr").textContent=n?("· "+n+" item(s)"):"";
      $("#lgDetail").scrollIntoView({behavior:"smooth"});
    });
  }

  on($("#lgBack"),"click",function(){
    $("#lgDetail").style.display="none";
    $("#lgBrowse").style.display="";
    $("#lgListWrap").scrollTop=lgListScroll;
  });
  on($("#lgReload"),"click",loadRuns);
  (function(){
    var hint=$("#lgTzHint");
    if(hint) hint.textContent="Times in "+browserTimezone();
  })();
  on($("#lgClear"),"click",function(){ $("#lgQ").value=""; $("#lgFrom").value=""; $("#lgTo").value=""; lgWsFilter="all";
    $("#lgWsFilters").querySelectorAll(".ws-chip").forEach(function(c){ c.classList.toggle("on",c.getAttribute("data-ws")==="all"); });
    filterRuns();
  });
  on($("#lgQ"),"input",filterRuns);
  on($("#lgFrom"),"input",filterRuns); on($("#lgFrom"),"change",filterRuns);
  on($("#lgTo"),"input",filterRuns); on($("#lgTo"),"change",filterRuns);
  $("#lgWsFilters").querySelectorAll(".ws-chip").forEach(function(chip){
    on(chip,"click",function(){
      lgWsFilter=chip.getAttribute("data-ws")||"all";
      $("#lgWsFilters").querySelectorAll(".ws-chip").forEach(function(c){ c.classList.toggle("on",c===chip); });
      filterRuns();
    });
  });

  // ─── PURGE ────────────────────────────────────────────────
  var purgeSel=new Set(), PG_CAT=null, PG_CAT_FULL=null, pgLoadedFilters=null, pgLoadedModels="";
  typeChips($("#pgTypes"), true, EX_TNAME);
  syncFiltVisibility("pg");
  toggleWrap("pgPerm"); toggleWrap("pgSame");
  function syncPurgeMode(){
    var mode=$("#pgMode"), lab=$("#pgModeLab"), desc=$("#pgModeDesc");
    if(!mode) return;
    var hasSel=purgeSel.size>0;
    mode.classList.toggle("on-sel", hasSel);
    if(lab) lab.textContent=hasSel?"Purge selection":"Destructive";
    if(desc) desc.textContent=hasSel
      ?("Ready to preview or delete "+purgeSel.size+" selected item(s) on the target. Preview writes nothing.")
      :"Select at least one item above. Preview first; Delete requires typing the target tenant id.";
  }
  function pgSelN(){
    $("#pgSelN").textContent="("+purgeSel.size+" selected)";
    syncPurgeMode();
  }
  function pgHideSelect(){
    $("#pgSelect").style.display="none";
    $("#pgStageRun").style.display="none";
    $("#pgResult").style.display="none";
    purgeSel.clear();
    PG_CAT=null; PG_CAT_FULL=null; pgLoadedFilters=null; pgLoadedModels="";
    $("#pgCatalog").innerHTML="";
    $("#pgMsg").textContent="";
    $("#pgReload").style.display="none";
    $("#pgNarrow").style.display="none";
    syncPurgeMode();
  }
  function markPgNeedsReload(){
    if(!PG_CAT_FULL) return;
    var cur=collectFilters("pg");
    // Fingerprint every enabled row's date/name/tags/timezone + models so any change (incl. name-only) prompts Reload.
    var pushChanged=JSON.stringify({spec:cur.spec,models:cur.models})!==JSON.stringify({spec:pgLoadedFilters,models:pgLoadedModels});
    if(pushChanged){
      $("#pgReload").style.display="inline-flex";
      $("#pgReload").classList.add("primary");
      $("#pgLoadMsg").textContent="Filters changed — Reload with filters to re-fetch from target.";
    }
    $("#pgNarrow").style.display=PG_CAT_FULL?"inline-flex":"none";
  }
  function loadPurgeCatalog(){
    var t=$("#pgTenant").value.trim(); if(!t){ $("#pgLoadMsg").textContent="Enter the target tenant id."; return; }
    var types=chosen($("#pgTypes"));
    if(!types.length){ $("#pgLoadMsg").textContent="Select at least one artifact."; return; }
    var cf=collectFilters("pg");
    if(cf.error){ showFiltErr("pg",cf.error); updateFiltBadge("pg"); return; }
    clearFiltErr("pg");
    var filters=cf.spec;
    var models=cf.models;
    updateFiltBadge("pg");
    collapseFilt("pg");
    $("#pgLoad").disabled=true; $("#pgReload").disabled=true; $("#pgNarrow").disabled=true;
    $("#pgLoadMsg").innerHTML='<span class="spin"></span> Cataloging target…';
    fetch("/api/catalog/build",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({env:"target",targetTenant:t,types:types,models:models||undefined,filters:filterActive(filters)?filters:undefined})})
      .then(function(r){return r.json();}).then(function(c){
        $("#pgLoad").disabled=false; $("#pgReload").disabled=false; $("#pgNarrow").disabled=false;
        $("#pgReload").style.display="inline-flex"; $("#pgReload").classList.remove("primary");
        $("#pgNarrow").style.display="inline-flex";
        if(c.error){
          var pgDetail=(c.detail||c.output||"").toString().trim();
          var pgSnippet=pgDetail?pgDetail.slice(-900):"";
          $("#pgLoadMsg").innerHTML='<span style="color:var(--red)">'+esc(c.error)+'</span>'+
            (pgSnippet?'<pre class="panel" style="margin-top:8px;max-height:180px;overflow:auto;font-size:11px;white-space:pre-wrap">'+esc(pgSnippet)+'</pre>':'');
          return;
        }
        if(types.indexOf("cms-models")>=0&&types.indexOf("cms-entries")<0&&c.sections){
          c.sections=c.sections.filter(function(sec){ return sec.type!=="cms-entry"; });
          c.sections.forEach(function(sec){ sec.total=(sec.items||[]).length; });
        }
        PG_CAT_FULL=cloneCatalog(c); PG_CAT=c; pgLoadedFilters=filters; pgLoadedModels=models; purgeSel.clear();
        var n=(c.sections||[]).reduce(function(a,sec){return a+(sec.total||0);},0);
        $("#pgLoadMsg").textContent=(filterActive(filters)||models)?("Filtered catalog: "+n+" item(s)."):("Catalog: "+n+" item(s).");
        $("#pgSelect").style.display="block";
        $("#pgStageRun").style.display="block";
        $("#pgResult").style.display="none";
        renderSelectable("#pgCatalog", (c.sections||[]), purgeSel, pgSelN);
        syncPurgeMode();
        $("#pgSelect").scrollIntoView({behavior:"smooth",block:"start"});
      }).catch(function(err){
        $("#pgLoad").disabled=false; $("#pgReload").disabled=false; $("#pgNarrow").disabled=false;
        $("#pgLoadMsg").textContent="Request failed: "+err;
      });
  }
  function narrowPurgeCatalog(){
    if(!PG_CAT_FULL){ $("#pgLoadMsg").textContent="Load a catalog first."; return; }
    var cf=collectFilters("pg");
    if(cf.error){ showFiltErr("pg",cf.error); updateFiltBadge("pg"); return; }
    clearFiltErr("pg");
    var filters=cf.spec;
    updateFiltBadge("pg");
    collapseFilt("pg");
    var view=cloneCatalog(PG_CAT_FULL);
    view.sections=(view.sections||[]).map(function(sec){
      var items=(sec.items||[]).filter(function(it){return matchItemLocal(it,filters);});
      return Object.assign({},sec,{items:items,total:items.length});
    });
    PG_CAT=view; purgeSel.clear();
    var n=view.sections.reduce(function(a,sec){return a+sec.total;},0);
    $("#pgLoadMsg").textContent="Narrowed in browser: "+n+" item(s) (no API call). Use Reload for date/tags.";
    renderSelectable("#pgCatalog", (view.sections||[]), purgeSel, pgSelN);
  }
  on($("#pgTenant"),"input",pgHideSelect);
  on($("#pgLoad"),"click",loadPurgeCatalog);
  on($("#pgReload"),"click",loadPurgeCatalog);
  on($("#pgNarrow"),"click",narrowPurgeCatalog);
  on($("#pgClr"),"click",function(){ purgeSel.clear(); $("#pgCatalog").querySelectorAll(".cb2").forEach(function(cb){cb.checked=false;cb.closest(".trow").classList.remove("sel");}); pgSelN(); });

  function pgRun(confirm){
    var t=$("#pgTenant").value.trim();
    return fetch("/api/purge",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      targetTenant:t, selectedIds:Array.from(purgeSel), permanent:$("#pgPerm").checked, allowSameTenant:$("#pgSame").checked, confirm:confirm
    })}).then(function(r){return r.json();});
  }
  function pgRenderResult(d){
    if(d.error){ $("#pgMsg").innerHTML='<span style="color:var(--red)">'+esc(d.error)+'</span>'; return; }
    $("#pgResult").style.display="block";
    var rows=(d.sections||[]).map(function(s){
      return '<div class="it"><span class="m">·</span><span class="tag '+esc(s.type)+'">'+esc(s.type)+'</span><span class="id">'+s.count+' selected</span><span class="act">queued</span></div>';
    }).join("")||'<div class="it muted" style="padding:12px">Nothing matched.</div>';
    var statusEl='<p id="pgJobStatus" class="muted" style="margin-top:8px">'+(d.dryRun?"Dry-run — nothing deleted. Use “Delete selected…” to execute.":"Purge job started"+(d.permanent?" (permanent)":" (soft)")+" — waiting for result…")+'</p>';
    $("#pgResultBody").innerHTML='<div class="panel">'+rows+'</div>'+statusEl;
    $("#pgMsg").textContent="";
    if(d.jobId){
      $("#pgOut").textContent="Starting…\\n";
      followJob(d.jobId, $("#pgOut"), function(meta){
        var ok=meta.status==="done";
        $("#pgMsg").innerHTML=ok?'<span class="ok-msg">'+I.check+' Purge finished</span>':'<span style="color:var(--red)">'+I.x+' Purge finished with errors</span>';
        var st=$("#pgJobStatus");
        if(st){ st.className=ok?"ok-msg":""; st.style.color=ok?"":"var(--red)"; st.innerHTML=(ok?I.check+" Purge finished":I.x+" Purge finished with errors")+(d.permanent?" (permanent)":" (soft)"); }
        loadRuns();
      });
    }
  }
  on($("#pgPreview"),"click",function(){
    if(!purgeSel.size){ $("#pgMsg").textContent="Select at least one item."; return; }
    $("#pgPreview").disabled=true; $("#pgMsg").innerHTML='<span class="spin"></span> Previewing…';
    pgRun(false).then(function(d){ $("#pgPreview").disabled=false; pgRenderResult(d); }).catch(function(err){ $("#pgPreview").disabled=false; $("#pgMsg").textContent="Request failed: "+err; });
  });

  // Delete → typed-confirmation modal
  function pgCloseModal(){ $("#pgModal").style.display="none"; $("#pgConfirmInput").value=""; $("#pgConfirmBtn").disabled=true; }
  on($("#pgDelete"),"click",function(){
    if(!purgeSel.size){ $("#pgMsg").textContent="Select at least one item."; return; }
    var t=$("#pgTenant").value.trim(); var perm=$("#pgPerm").checked;
    $("#pgModalBody").innerHTML='About to delete <b>'+purgeSel.size+'</b> selected item(s) on tenant <b>'+esc(t)+'</b>.<br>'+
      (perm?'<span style="color:var(--red)">PERMANENT hard delete — unrecoverable.</span>':'Soft delete — entries/pages go to the bin/Trash (recoverable).')+
      '<br>Deleting a content model also removes all its entries (unrecoverable).';
    $("#pgModal").style.display="grid"; $("#pgConfirmInput").focus();
  });
  on($("#pgConfirmInput"),"input",function(){ $("#pgConfirmBtn").disabled = $("#pgConfirmInput").value.trim()!==$("#pgTenant").value.trim(); });
  on($("#pgCancel"),"click",pgCloseModal);
  on($("#pgConfirmBtn"),"click",function(){
    $("#pgConfirmBtn").disabled=true; $("#pgConfirmBtn").innerHTML='<span class="spin"></span> Deleting…';
    pgRun(true).then(function(d){ pgCloseModal(); $("#pgConfirmBtn").textContent="Delete now"; pgRenderResult(d); })
      .catch(function(err){ pgCloseModal(); $("#pgConfirmBtn").textContent="Delete now"; $("#pgMsg").textContent="Request failed: "+err; });
  });
})();
</script>
</body></html>`;

