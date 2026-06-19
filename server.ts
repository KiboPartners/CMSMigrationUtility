/**
 * Local web UI (Express) for the Kibo CMS Import/Export Utility.
 *
 * Single embedded HTML page (no external assets/CDN/build) with a collapsible
 * left nav over four workspaces:
 *   • Export — selectively export artifacts from a source tenant to a server folder
 *   • Import — import a previously exported folder into a target tenant
 *   • Copy   — direct source→target migration (catalog → select → migrate)
 *   • Logs   — browse the run ledger with search + date filtering
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
import { spawnSync } from "child_process";
import { Catalog, planMigration, listRuns, loadRun, runSummary, aggregateMetrics } from "@kibo-cms-clone-tool/shared";

export interface ServeOptions {
  root: string;
  port: number;
  catalogPath: string;
  schemaFile: string;
  runsDir: string;
}

// Artifact type ↔ package mapping shared by export/import selection.
const PKGS = ["file-manager", "cms-entries", "page-builder", "redirects"] as const;
type Pkg = (typeof PKGS)[number];

export function startServer(opts: ServeOptions): void {
  const runsDir = path.isAbsolute(opts.runsDir) ? opts.runsDir : path.join(opts.root, opts.runsDir);
  const catalogFile = path.isAbsolute(opts.catalogPath) ? opts.catalogPath : path.join(opts.root, opts.catalogPath);
  // Target catalog (for the Purge tab) is kept separate so it never clobbers the
  // source catalog the Migrate tab uses.
  const targetCatalogFile = path.join(opts.root, "target-catalog.json");
  const catalogFor = (env: string) => (env === "target" ? targetCatalogFile : catalogFile);
  const exportBase = path.join(opts.root, "export");
  const loadCatalogFile = (f: string): Catalog | null =>
    fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf-8")) as Catalog) : null;
  const loadCatalog = (): Catalog | null => loadCatalogFile(catalogFile);
  const cli = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync("npx", ["ts-node", "index.ts", ...args], { cwd: opts.root, shell: true, encoding: "utf-8", env });
  // Spawn a single package CLI (used for purge, which has no root orchestrator command).
  const pkgCli = (pkg: Pkg, args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync("npx", ["ts-node", "--project", path.join(opts.root, "packages", pkg, "tsconfig.json"), "index.ts", ...args],
      { cwd: path.join(opts.root, "packages", pkg), shell: true, encoding: "utf-8", env });
  // Artifact type → package.
  const PKG_FOR: Record<string, Pkg> = { file: "file-manager", "cms-entry": "cms-entries", page: "page-builder", redirect: "redirects" };

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

  // Input validation: args/env reach a shell (spawn shell:true) and ids build
  // file paths — reject anything outside a safe character set to prevent command
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
  const skipFor = (selected: Pkg[]): string[] => PKGS.filter((p) => !selected.includes(p));
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
  const logoFile = path.join(opts.root, "shared", "img", "Kibo-Icon-Black.png");
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
    const selected = pkgsOf(req.body?.types);
    if (selected.length === 0) return res.status(400).json({ error: "Select at least one artifact type." });
    const models = String(req.body?.models ?? "").trim();
    if (models && !/^[A-Za-z0-9 ,_-]+$/.test(models)) return res.status(400).json({ error: "Invalid models filter" });

    // One timestamped folder per export so imports can pick a specific snapshot.
    // Use an ABSOLUTE --out: export-all forwards `${out}/<sub>` to each package,
    // which spawns with its own cwd — a relative path would scatter output under
    // packages/<pkg>/. Absolute keeps every artifact in one server folder.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outRel = path.posix.join("export", `exp-${sourceTenant}-${stamp}`);
    const outAbs = path.join(exportBase, `exp-${sourceTenant}-${stamp}`);

    const args = ["export-all", "--out", outAbs];
    const skip = skipFor(selected);
    if (skip.length) args.push("--skip", skip.join(","));
    if (opts.schemaFile) args.push("--schema-file", opts.schemaFile);
    else if (models) args.push("--models", models);
    if (req.body?.continueOnError) args.push("--continue-on-error");

    const r = cli(args, { ...process.env, SOURCE_TENANT: sourceTenant });
    res.json({
      exitCode: r.status,
      dir: outRel,
      types: selected,
      output: (r.stdout ?? "") + (r.stderr ?? ""),
    });
  });

  // List previously exported folders (those holding any artifact sub-dir).
  app.get("/api/exports", (_req: Request, res: Response) => {
    let dirs: Array<{ dir: string; mtime: string; types: string[] }> = [];
    if (fs.existsSync(exportBase)) {
      const subdirNames: Record<Pkg, string> = { "file-manager": "files", "cms-entries": "cms", "page-builder": "pages", redirects: "redirects" };
      dirs = fs.readdirSync(exportBase)
        .map((name) => path.join(exportBase, name))
        .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
        .map((p) => {
          const types = PKGS.filter((pk) => fs.existsSync(path.join(p, subdirNames[pk])));
          return { dir: path.posix.join("export", path.basename(p)), mtime: fs.statSync(p).mtime.toISOString(), types };
        })
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
    const selected = pkgsOf(req.body?.types);
    if (selected.length === 0) return res.status(400).json({ error: "Select at least one artifact type." });

    // Optional item-level selection (ids don't collide across types; import-all
    // forwards the same --select to each package, which filters to its own ids).
    const ids = Array.isArray(req.body?.selectedIds) ? (req.body.selectedIds as unknown[]).map(String) : [];
    let cleanup: (() => void) | null = null;

    // Absolute --in for the same reason as export (per-package cwd on spawn).
    const args = ["import-all", "--in", dir];
    const skip = skipFor(selected);
    if (skip.length) args.push("--skip", skip.join(","));
    if (req.body?.dryRun) args.push("--dry-run");
    if (req.body?.allowFolderMismatch) args.push("--allow-folder-mismatch");
    if (req.body?.continueOnError) args.push("--continue-on-error");
    if (ids.length) {
      const t = writeIdsTmp(ids);
      cleanup = t.cleanup;
      args.push("--select", `@${t.file}`);
    }

    const r = cli(args, { ...process.env, TARGET_TENANT: targetTenant });
    if (cleanup) cleanup();
    // import-all does not record a run ledger — return only the console output.
    res.json({ exitCode: r.status, output: (r.stdout ?? "") + (r.stderr ?? "") });
  });

  // Read a chosen export folder's contents into a selectable catalog (from disk,
  // no API) so the UI can let the user import a subset.
  app.get("/api/import/contents", (req: Request, res: Response) => {
    const dir = safeDir(req.query?.dir);
    if (!dir) return res.status(400).json({ error: "Invalid or missing export folder" });
    const sections: Array<{ type: string; total: number; items: Array<{ id: string; label: string; metadata?: Record<string, unknown> }> }> = [];
    const readJson = (p: string): unknown => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };

    // cms-entries: one JSON per model under cms/
    const cmsDir = path.join(dir, "cms");
    if (fs.existsSync(cmsDir)) {
      const items: Array<{ id: string; label: string; metadata?: Record<string, unknown> }> = [];
      for (const f of fs.readdirSync(cmsDir).filter((n) => n.endsWith(".json"))) {
        const j = readJson(path.join(cmsDir, f)) as { modelName?: string; entries?: Array<Record<string, unknown>> } | null;
        for (const e of j?.entries ?? []) {
          const meta = (e["meta"] as { title?: string; status?: string; version?: unknown } | undefined) ?? {};
          const id = String(e["entryId"] ?? e["id"] ?? "");
          const label = String(e["title"] ?? e["name"] ?? e["slug"] ?? meta.title ?? id);
          items.push({ id, label, metadata: { name: label, model: j?.modelName, status: meta.status ?? null, live: meta.status === "published", version: meta.status === "published" ? meta.version ?? null : null } });
        }
      }
      sections.push({ type: "cms-entry", total: items.length, items });
    }
    // pages
    const pagesFile = path.join(dir, "pages", "pages.json");
    if (fs.existsSync(pagesFile)) {
      const j = readJson(pagesFile) as { pages?: Array<Record<string, unknown>> } | null;
      const items = (j?.pages ?? []).map((p) => {
        const props = (p["properties"] as { title?: string; path?: string } | undefined) ?? {};
        const id = String(p["entryId"] ?? p["id"] ?? "");
        const status = (p["status"] as string) ?? null;
        return { id, label: String(props.title ?? props.path ?? id), metadata: { name: props.title ?? id, path: props.path ?? null, status, live: status === "published", version: status === "published" ? p["version"] ?? null : null } };
      });
      sections.push({ type: "page", total: items.length, items });
    }
    // redirects
    const redirFile = path.join(dir, "redirects", "redirects.json");
    if (fs.existsSync(redirFile)) {
      const j = readJson(redirFile) as { redirects?: Array<Record<string, unknown>> } | null;
      const items = (j?.redirects ?? []).map((r) => ({ id: String(r["redirectFrom"] ?? ""), label: String(r["redirectFrom"] ?? ""), metadata: { name: r["redirectFrom"], path: r["redirectTo"] } }));
      sections.push({ type: "redirect", total: items.length, items });
    }
    // files
    const filesFile = path.join(dir, "files", "files.json");
    if (fs.existsSync(filesFile)) {
      const j = readJson(filesFile) as { files?: Array<Record<string, unknown>> } | null;
      const items = (j?.files ?? []).map((f) => ({ id: String(f["src"] ?? f["key"] ?? ""), label: String(f["key"] ?? f["src"] ?? ""), metadata: { name: f["key"] } }));
      sections.push({ type: "file", total: items.length, items });
    }
    res.json({ sections });
  });

  // ── Catalog build — env=source (Migrate) or target (Purge) ────────────────────
  app.post("/api/catalog/build", (req: Request, res: Response) => {
    const env = req.body?.env === "target" ? "target" : "source";
    // For source we inject SOURCE_TENANT; for target we inject TARGET_TENANT but
    // tell catalog-all to read the "target" environment.
    const tenantKey = env === "target" ? "TARGET_TENANT" : "SOURCE_TENANT";
    const tenant = tenantOf(env === "target" ? req.body?.targetTenant : req.body?.sourceTenant, process.env[tenantKey] ?? "root");
    if (!tenant) return res.status(400).json({ error: `Invalid ${env} tenant id` });
    const out = catalogFor(env);
    const args = ["catalog-all", "--env", env, "--out", out];
    if (opts.schemaFile) args.push("--schema-file", opts.schemaFile);
    const r = cli(args, { ...process.env, [tenantKey]: tenant });
    if (r.status !== 0) return res.status(500).json({ error: "catalog build failed", output: (r.stdout ?? "") + (r.stderr ?? "") });
    res.json(loadCatalogFile(out));
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
    if (req.body?.continueOnError) args.push("--continue-on-error");

    const r = cli(args, { ...process.env, SOURCE_TENANT: sourceTenant, TARGET_TENANT: targetTenant });
    if (cleanup) cleanup();

    const output = (r.stdout ?? "") + (r.stderr ?? "");
    // A dry-run records NO run on disk — synthesize a plan preview so the UI shows
    // what *would* migrate instead of falling back to a stale earlier run.
    if (dryRun && !resume) {
      const c = loadCatalog();
      const plan = c ? planMigration(c, ids) : null;
      const preview = plan
        ? plan.steps.flatMap((s) => s.ids.map((id) => ({ type: s.type, id, status: "skipped", action: "would migrate" })))
        : [];
      return res.json({ exitCode: r.status, output, dryRun: true, preview });
    }
    res.json({ exitCode: r.status, output, latestRun: listRuns(runsDir)[0] ?? null });
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
    const cleanups: Array<() => void> = [];
    const sections: Array<{ type: string; pkg: string; count: number; exitCode: number | null; output: string }> = [];

    for (const [type, g] of byType) {
      const pkg = PKG_FOR[type];
      if (!pkg) continue;
      const t = writeIdsTmp(g.ids); cleanups.push(t.cleanup);
      const args = ["purge", "--select", `@${t.file}`];
      if (pkg !== "page-builder") args.push("--all");               // page purge is always all-pages
      if (pkg === "cms-entries" && g.models.size) args.push("--models", [...g.models].join(","));
      if (confirm) args.push("--force");                            // omit → CLI dry-run preview
      if (permanent) args.push("--permanent");
      if (allowSameTenant) args.push("--allow-same-tenant");
      const r = pkgCli(pkg, args, { ...process.env, TARGET_TENANT: targetTenant });
      sections.push({ type, pkg, count: g.ids.length, exitCode: r.status, output: (r.stdout ?? "") + (r.stderr ?? "") });
    }
    cleanups.forEach((c) => c());
    res.json({ dryRun: !confirm, permanent, sections });
  });

  app.get("/api/metrics", (_req: Request, res: Response) => {
    res.json(aggregateMetrics(listRuns(runsDir)));
  });

  app.get("/api/runs", (_req: Request, res: Response) => {
    res.json(listRuns(runsDir).map((rn) => ({ id: rn.id, status: rn.status, createdAt: rn.createdAt, environment: rn.environment, summary: runSummary(rn) })));
  });

  app.get("/api/runs/:id", (req: Request, res: Response) => {
    if (!RUNID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid run id" });
    try { res.json(loadRun(runsDir, req.params.id)); } catch { res.status(404).json({ error: "Run not found" }); }
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

  /* buttons + fields */
  .btn{font-family:var(--sans);font-size:13px;font-weight:600;background:var(--surface);color:var(--ink);border:1px solid var(--line2);border-radius:var(--r-sm);padding:10px 18px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:.15s}
  .btn:hover{border-color:var(--ink)}
  .btn.primary{background:var(--brand);color:var(--brand-ink);border-color:var(--brand)}
  .btn.primary:hover{background:var(--brand-hover);border-color:var(--brand-hover)}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn:focus-visible,.icbtn:focus-visible,.menu:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
  .actions{display:flex;gap:12px;align-items:center;margin-top:22px;flex-wrap:wrap}
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
  .tg{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;border:1px solid var(--line);border-radius:var(--r-sm);padding:9px 13px;background:var(--surface)}
  .tg input{appearance:none;width:30px;height:16px;border-radius:99px;background:var(--line2);position:relative;cursor:pointer;outline:none;transition:.18s}
  .tg input:checked{background:var(--brand)}.tg input::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:.18s}
  .tg input:checked::after{left:16px}.tg.on{color:var(--ink)}
  .tg[title]{cursor:help}.tg[title]::after{content:"ⓘ";margin-left:7px;color:var(--faint);font-size:11px}

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
  .dep{font-size:10px;font-weight:600;color:var(--src);border:1px solid var(--line);border-radius:99px;padding:2px 8px;white-space:nowrap}
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
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:grid;place-items:center;z-index:100}
  .modal-box{background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--red);border-radius:var(--r);padding:22px;max-width:480px;width:92%;box-shadow:var(--shadow-lg)}
  .modal-h{font-size:15px;font-weight:800;color:var(--red);margin-bottom:10px}
  .modal-body{font-size:13px;color:var(--ink);margin-bottom:16px;line-height:1.55}
  .modal-body b{font-family:var(--mono)}
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
      <p class="vsub">Read selected artifacts from a source tenant and write them to a folder on this machine. Nothing on the source is modified.</p>
      <div class="card src" style="max-width:520px">
        <div class="role">Source · read-only</div><div class="url" id="exSrcUrl">—</div>
        <label class="fl" for="exTenant">Source tenant id</label>
        <input id="exTenant" class="txt big" spellcheck="false" aria-label="Source tenant id">
      </div>
      <p class="sectt">Artifacts to export</p>
      <div class="types" id="exTypes"></div>
      <div id="exModelsWrap" style="margin-top:14px;max-width:520px">
        <label class="fl" for="exModels">CMS models filter (optional, comma-separated names — blank = all)</label>
        <input id="exModels" class="txt" spellcheck="false" placeholder="e.g. PromoBanner, Homepage Layout">
      </div>
      <div class="toolbar">
        <label class="tg on" id="tgExCont" title="If one artifact type fails (e.g. files 'Not authorized'), keep exporting the rest. Off = stop at the first failure."><input type="checkbox" id="exCont" checked>continue on error</label>
      </div>
      <div class="actions">
        <button class="btn primary" id="exGo">Export to folder</button>
        <span id="exMsg" class="muted"></span>
      </div>
      <div id="exResult" style="display:none">
        <p class="sectt">Result</p>
        <div class="panel" style="padding:14px 16px;margin-bottom:10px"><span class="muted">Saved to</span> <b class="mono" id="exDir"></b></div>
        <details open><summary>Console output</summary><pre id="exOut"></pre></details>
      </div>
    </section>

    <!-- IMPORT -->
    <section class="view" id="v-import">
      <p class="vh"><span id="h-import"></span>Import a folder</p>
      <p class="vsub">Import a previously exported folder from this machine into a target tenant.</p>
      <div class="card tgt" style="max-width:520px">
        <div class="role">Target · destination</div><div class="url" id="imTgtUrl">—</div>
        <label class="fl" for="imTenant">Target tenant id</label>
        <input id="imTenant" class="txt big" spellcheck="false" aria-label="Target tenant id">
      </div>
      <div style="max-width:520px;margin-top:16px">
        <label class="fl" for="imDir">Export folder</label>
        <select id="imDir" class="txt"></select>
        <span id="imDirMeta" class="faint" style="font-size:11.5px"></span>
      </div>
      <p class="sectt">Artifacts to import</p>
      <div class="types" id="imTypes"></div>
      <p class="sectt">Items <span id="imSelN" class="muted" style="font-weight:400">(0 selected — all of the chosen types will import)</span></p>
      <div id="imContents" class="muted">Choose a folder to list its contents.</div>
      <div class="toolbar">
        <label class="tg on" id="tgImDry" title="Preview only — runs the full import plan but writes nothing to the target. Turn off to actually import."><input type="checkbox" id="imDry" checked>dry-run</label>
        <label class="tg" id="tgImFolder" title="Import even if a folder couldn't be recreated on the target. Affected items land in the root folder instead of failing the import."><input type="checkbox" id="imFolder">allow folder mismatch</label>
        <label class="tg" id="tgImCont" title="If one artifact type fails, keep importing the rest. Off = stop at the first failure."><input type="checkbox" id="imCont">continue on error</label>
      </div>
      <div class="actions">
        <button class="btn primary" id="imGo">Start import</button>
        <button class="btn" id="imRefresh">Refresh folders</button>
        <span id="imMsg" class="muted"></span>
      </div>
      <div id="imProgress" style="display:none">
        <p class="sectt">Result</p>
        <div class="panel" id="imBanner" style="padding:13px 16px;margin-bottom:10px"></div>
        <details open><summary>Console output (per-artifact totals)</summary><pre id="imOut"></pre></details>
      </div>
    </section>

    <!-- COPY -->
    <section class="view" id="v-copy">
      <p class="vh"><span id="h-copy"></span>Migrate source → target</p>
      <p class="vsub">Direct tenant-to-tenant migration: browse the source, pick components, migrate in dependency order.</p>
      <div class="grid2" style="max-width:760px">
        <div class="card src"><div class="role">Source · read-only</div><div class="url" id="cpSrcUrl">—</div>
          <label class="fl" for="cpSrc">Source tenant id</label><input id="cpSrc" class="txt big" spellcheck="false"></div>
        <div class="card tgt"><div class="role">Target · destination</div><div class="url" id="cpTgtUrl">—</div>
          <label class="fl" for="cpTgt">Target tenant id</label><input id="cpTgt" class="txt big" spellcheck="false"></div>
      </div>
      <div class="actions"><button class="btn primary" id="cpLoad">Load source artifacts</button><span id="cpLoadMsg" class="muted"></span></div>

      <div id="cpSelect" style="display:none">
        <p class="sectt">Select artifacts <span id="cpSelN" class="muted" style="font-weight:400">(0 selected)</span></p>
        <p class="hint">Selecting an entry pulls in its content model and any files it references — migrated in the right order.</p>
        <div id="cpCatalog" class="muted">—</div>
        <div class="toolbar">
          <label class="tg on" id="tgCpDry" title="Preview only — resolves the plan (with dependencies) but writes nothing to the target and records no run. Turn off to migrate for real."><input type="checkbox" id="cpDry" checked>dry-run</label>
          <label class="tg" id="tgCpSkip" title="Reuse whatever is already in the export folder instead of re-exporting from source. Faster, but risks a stale or wrong-tenant export — leave OFF unless you just exported this exact selection."><input type="checkbox" id="cpSkip">skip-export (reuse last export)</label>
          <label class="tg" id="tgCpSchema" title="Import entries even when the target model's fields differ from the source (a missing field or a changed type). Mismatched fields may fail; existing models are never altered."><input type="checkbox" id="cpSchema">allow schema mismatch</label>
          <label class="tg" id="tgCpFolder" title="Migrate even if a folder couldn't be recreated on the target. Affected items land in the root folder instead of failing."><input type="checkbox" id="cpFolder">allow folder mismatch</label>
          <label class="tg" id="tgCpCont" title="If one artifact type fails, keep migrating the rest. Off = stop at the first failure (resume later)."><input type="checkbox" id="cpCont">continue on error</label>
        </div>
        <div class="actions">
          <button class="btn primary" id="cpGo">Start migration</button>
          <button class="link" id="cpClr">clear selection</button>
          <span id="cpGoMsg" class="muted"></span>
        </div>
      </div>

      <div id="cpProgress" style="display:none">
        <p class="sectt">Migration</p>
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
    </section>

    <!-- LOGS -->
    <section class="view" id="v-logs">
      <p class="vh"><span id="h-logs"></span>Logs &amp; history</p>
      <p class="vsub">Every export, import and migration is recorded. Search and filter by date.</p>
      <div class="filterbar">
        <div class="f" style="flex:1;min-width:200px"><label class="fl" for="lgQ">Search (id / status / tenant)</label><input id="lgQ" class="txt" placeholder="type to filter…"></div>
        <div class="f"><label class="fl" for="lgFrom">From</label><input id="lgFrom" class="txt" type="date"></div>
        <div class="f"><label class="fl" for="lgTo">To</label><input id="lgTo" class="txt" type="date"></div>
        <button class="btn" id="lgClear">Clear</button>
        <button class="btn" id="lgReload">Reload</button>
      </div>
      <div class="sectt" style="margin-top:6px">Metrics <span id="lgMetHdr" class="muted" style="font-weight:400"></span></div>
      <div id="lgMetrics" class="muted"></div>
      <div class="sectt">Runs <span id="lgCount" class="muted" style="font-weight:400"></span></div>
      <div id="lgRuns" class="muted">—</div>
      <div id="lgDetail" style="display:none">
        <div class="sectt">Run detail <button class="link" id="lgBack">← back to list</button></div>
        <div class="bar"><i id="lgBar"></i></div>
        <div class="pgrid">
          <div class="stat ok"><div class="n" id="lgOk">0</div><div class="u">Done</div></div>
          <div class="stat err"><div class="n" id="lgErr">0</div><div class="u">Error</div></div>
          <div class="stat tot"><div class="n" id="lgTot">0</div><div class="u">Total</div></div>
        </div>
        <div class="panel items" id="lgItems"></div>
      </div>
    </section>

    <!-- PURGE -->
    <section class="view" id="v-purge">
      <p class="vh"><span id="h-purge"></span>Purge target tenant</p>
      <p class="vsub">Delete selected artifacts <b>on the target</b>. Dry-run preview first; deletion needs an explicit typed confirmation. Entries &amp; pages soft-delete to the bin/Trash unless you choose permanent.</p>
      <div class="card tgt" style="max-width:520px">
        <div class="role">Target · destructive</div><div class="url" id="pgTgtUrl">—</div>
        <label class="fl" for="pgTenant">Target tenant id</label>
        <input id="pgTenant" class="txt big" spellcheck="false" aria-label="Target tenant id">
      </div>
      <div class="actions"><button class="btn" id="pgLoad">Fetch All</button><span id="pgLoadMsg" class="muted"></span></div>

      <div id="pgSelect">
        <p class="sectt">Select what to delete <span id="pgSelN" class="muted" style="font-weight:400">(0 selected)</span></p>
        <div id="pgCatalog" class="muted">Load the target catalog above to list items.</div>
        <div class="toolbar">
          <label class="tg" id="tgPgPerm" title="Hard delete — skips the recycle bin/Trash and is UNRECOVERABLE. Off = soft delete (recoverable from the CMS admin)."><input type="checkbox" id="pgPerm">permanent (hard delete)</label>
          <label class="tg" id="tgPgSame" title="Allow purging when the target tenant equals the source tenant. Off by default — a real purge once wiped a source tenant."><input type="checkbox" id="pgSame">allow same tenant</label>
        </div>
        <div class="actions">
          <button class="btn" id="pgPreview" title="Dry run — shows how many of each type would be deleted; writes nothing.">Preview (dry-run)</button>
          <button class="btn primary" id="pgDelete" title="Opens a confirmation dialog; you must type the target tenant id to proceed.">Delete selected…</button>
          <button class="link" id="pgClr">clear</button>
          <span id="pgMsg" class="muted"></span>
        </div>
        <div id="pgResult" style="display:none"><p class="sectt">Result</p><div id="pgResultBody"></div><details><summary>Console output</summary><pre id="pgOut"></pre></details></div>
      </div>
    </section>

  </div></main>
</div>

<!-- Purge confirmation modal -->
<div id="pgModal" class="modal" style="display:none">
  <div class="modal-box">
    <div class="modal-h">⚠ Confirm purge</div>
    <div class="modal-body" id="pgModalBody"></div>
    <label class="fl" for="pgConfirmInput">Type the target tenant id to confirm</label>
    <input id="pgConfirmInput" class="txt" spellcheck="false" autocomplete="off">
    <div class="actions" style="margin-top:16px">
      <button class="btn" id="pgCancel">Cancel</button>
      <button class="btn danger" id="pgConfirmBtn" disabled>Delete now</button>
    </div>
  </div>
</div>
<script>
(function(){
  function $(s){return document.querySelector(s);}
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
  function on(el,ev,fn){ if(el) el.addEventListener(ev,fn); }
  // File binaries aren't copied — surface the S3 manifest path from the run output.
  function s3Note(out){ var m=/S3 copy manifest written to:\s*(.+)/.exec(out||""); return m? '<div class="s3note"><b>S3 copy manifest:</b> <span class="mono">'+esc(m[1].trim())+'</span><br>Binaries are not copied — share this file with your AWS admin to sync the file objects.</div>' : ""; }
  var TNAME={"file-manager":"Files","cms-entries":"CMS Entries","page-builder":"Pages","redirects":"Redirects"};
  var CTNAME={file:"Files","cms-entry":"Entries",page:"Pages",redirect:"Redirects"};
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

  // type chips
  function typeChips(host, checked){
    host.innerHTML="";
    Object.keys(TNAME).forEach(function(pk){
      var el=document.createElement("label");
      el.className="chip"+(checked?" on":"");
      el.setAttribute("data-pk",pk);
      el.innerHTML='<span class="cb"></span>'+esc(TNAME[pk]);
      on(el,"click",function(){ el.classList.toggle("on"); });
      host.appendChild(el);
    });
  }
  function chosen(host){ return Array.prototype.slice.call(host.querySelectorAll(".chip.on")).map(function(c){return c.getAttribute("data-pk");}); }

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

  // ─── EXPORT ───────────────────────────────────────────────
  typeChips($("#exTypes"), true);
  toggleWrap("exCont");
  on($("#exGo"),"click",function(){
    var tenant=$("#exTenant").value.trim(); var types=chosen($("#exTypes"));
    if(!tenant){ $("#exMsg").textContent="Enter a source tenant id."; return; }
    if(!types.length){ $("#exMsg").textContent="Select at least one artifact."; return; }
    $("#exGo").disabled=true; $("#exMsg").innerHTML='<span class="spin"></span> Exporting… (this can take a while)';
    fetch("/api/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sourceTenant:tenant,types:types,models:$("#exModels").value.trim(),continueOnError:$("#exCont").checked})})
      .then(function(r){return r.json();}).then(function(d){
        $("#exGo").disabled=false;
        if(d.error){ $("#exMsg").innerHTML='<span class="ok-msg" style="color:var(--red)">'+esc(d.error)+'</span>'; return; }
        $("#exMsg").innerHTML=d.exitCode===0?'<span class="ok-msg">'+I.check+' Export complete</span>':'<span style="color:var(--red)">'+I.x+' Export finished with errors (exit '+d.exitCode+')</span>';
        $("#exResult").style.display="block"; $("#exDir").textContent=d.dir; $("#exOut").textContent=d.output||"(no output)";
      }).catch(function(err){ $("#exGo").disabled=false; $("#exMsg").textContent="Request failed: "+err; });
  });

  // ─── IMPORT ───────────────────────────────────────────────
  typeChips($("#imTypes"), true);
  function toggleWrap(id){ var cb=$("#"+id),w=cb.closest(".tg"); function s(){w.classList.toggle("on",cb.checked);} on(cb,"change",s); s(); }
  toggleWrap("imDry"); toggleWrap("imFolder"); toggleWrap("imCont");
  // Item-level import selection (subset of the chosen folder; empty = import all).
  var importSel=new Set();
  function imSelN(){ $("#imSelN").textContent=importSel.size?("("+importSel.size+" selected)"):"(0 selected — all of the chosen types will import)"; }
  function loadImportContents(){
    var dir=$("#imDir").value; importSel.clear();
    if(!dir){ $("#imContents").innerHTML='<span class="muted">Choose a folder to list its contents.</span>'; imSelN(); return; }
    $("#imContents").innerHTML='<span class="spin"></span> Reading folder…';
    fetch("/api/import/contents?dir="+encodeURIComponent(dir)).then(function(r){return r.json();}).then(function(d){
      if(d.error){ $("#imContents").innerHTML='<span style="color:var(--red)">'+esc(d.error)+'</span>'; return; }
      renderSelectable("#imContents", d.sections, importSel, imSelN);
    }).catch(function(err){ $("#imContents").textContent="Failed to read folder: "+err; });
  }
  function loadExports(){
    fetch("/api/exports").then(function(r){return r.json();}).then(function(list){
      var sel=$("#imDir"); sel.innerHTML="";
      if(!list.length){ var o=document.createElement("option"); o.value=""; o.textContent="(no export folders — run an Export first)"; sel.appendChild(o); $("#imDirMeta").textContent=""; return; }
      list.forEach(function(d){
        var o=document.createElement("option"); o.value=d.dir;
        o.textContent=d.dir+"  ·  "+d.types.length+" type(s)";
        o.setAttribute("data-types",d.types.join(","));
        sel.appendChild(o);
      });
      onImDir();
    });
  }
  function imDirMeta(){ var o=$("#imDir").selectedOptions[0]; $("#imDirMeta").textContent=o&&o.getAttribute("data-types")?("contains: "+o.getAttribute("data-types")):""; }
  // Restrict the import type chips to what the chosen folder actually holds —
  // importing a type the folder lacks just aborts the run.
  function syncImTypes(){
    var o=$("#imDir").selectedOptions[0];
    var avail=((o&&o.getAttribute("data-types"))||"").split(",").filter(Boolean);
    $("#imTypes").querySelectorAll(".chip").forEach(function(c){
      var has=avail.indexOf(c.getAttribute("data-pk"))>=0;
      c.classList.toggle("on",has);
      c.style.opacity=has?"":"0.35"; c.style.pointerEvents=has?"":"none";
    });
  }
  function onImDir(){ imDirMeta(); syncImTypes(); loadImportContents(); }
  on($("#imDir"),"change",onImDir);
  on($("#imRefresh"),"click",loadExports);
  on($("#imGo"),"click",function(){
    var tenant=$("#imTenant").value.trim(); var dir=$("#imDir").value; var types=chosen($("#imTypes"));
    if(!tenant){ $("#imMsg").textContent="Enter a target tenant id."; return; }
    if(!dir){ $("#imMsg").textContent="Choose an export folder."; return; }
    if(!types.length){ $("#imMsg").textContent="Select at least one artifact."; return; }
    $("#imGo").disabled=true; $("#imMsg").innerHTML='<span class="spin"></span> Importing…';
    fetch("/api/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({targetTenant:tenant,dir:dir,types:types,selectedIds:Array.from(importSel),dryRun:$("#imDry").checked,allowFolderMismatch:$("#imFolder").checked,continueOnError:$("#imCont").checked})})
      .then(function(r){return r.json();}).then(function(d){
        $("#imGo").disabled=false;
        if(d.error){ $("#imMsg").innerHTML='<span style="color:var(--red)">'+esc(d.error)+'</span>'; return; }
        var dry=$("#imDry").checked;
        var okTxt=dry?"Dry run complete — nothing written":"Import complete";
        $("#imMsg").innerHTML=d.exitCode===0?'<span class="ok-msg">'+I.check+' '+okTxt+'</span>':'<span style="color:var(--red)">'+I.x+' Finished with errors (exit '+d.exitCode+')</span>';
        $("#imProgress").style.display="block";
        $("#imBanner").innerHTML=(dry?'<b>Dry run</b> — no changes made. ':'')+'See per-artifact totals below.'+(dry?"":s3Note(d.output));
        $("#imOut").textContent=d.output||"(no output)";
      }).catch(function(err){ $("#imGo").disabled=false; $("#imMsg").textContent="Request failed: "+err; });
  });

  // ─── COPY ─────────────────────────────────────────────────
  var sel=new Set(), CAT=null;
  function cpRoute(){ var s=$("#cpSrc").value.trim(),t=$("#cpTgt").value.trim(); $("#rSrc").textContent=s||"—"; $("#rTgt").textContent=t||"—"; $("#route").style.visibility=(s&&t)?"visible":"hidden"; }
  on($("#cpSrc"),"input",cpRoute); on($("#cpTgt"),"input",cpRoute);
  toggleWrap("cpDry"); toggleWrap("cpSkip"); toggleWrap("cpSchema"); toggleWrap("cpFolder"); toggleWrap("cpCont");
  on($("#cpLoad"),"click",function(){
    var s=$("#cpSrc").value.trim(); if(!s){ $("#cpLoadMsg").textContent="Enter a source tenant id."; return; }
    $("#cpLoad").disabled=true; $("#cpLoadMsg").innerHTML='<span class="spin"></span> Building catalog…';
    fetch("/api/catalog/build",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sourceTenant:s})})
      .then(function(r){return r.json();}).then(function(c){
        $("#cpLoad").disabled=false;
        if(c.error){ $("#cpLoadMsg").innerHTML='<span style="color:var(--red)">'+esc(c.error)+'</span>'; return; }
        CAT=c; sel.clear(); $("#cpLoadMsg").textContent=""; $("#cpSelect").style.display="block"; renderCatalog();
        $("#cpSelect").scrollIntoView({behavior:"smooth"});
      }).catch(function(err){ $("#cpLoad").disabled=false; $("#cpLoadMsg").textContent="Request failed: "+err; });
  });
  // Short date: "2026-06-15 18:42" from an ISO string.
  function fmtDate(s){ if(!s) return "—"; return String(s).replace("T"," ").slice(0,16); }
  function td(v){ return '<td>'+esc(v==null||v===""?"—":v)+'</td>'; }

  // Build one section's table. cms-entry / page get the rich columns
  // (Name, Path, Author, Created, Modified, Status, Live, Version); other types
  // get a compact Name + ID table.
  function sectionTable(sec,selSet){
    var rich = sec.type==="cms-entry"||sec.type==="page";
    var head = rich
      ? '<tr><th class="cbx"></th><th>Name</th><th>Path</th><th>Author</th><th>Created</th><th>Modified</th><th>Status</th><th>Live</th><th>Ver</th><th>Deps</th></tr>'
      : '<tr><th class="cbx"></th><th>Name</th><th>ID</th><th>Deps</th></tr>';
    var body = sec.items.map(function(it){
      var m=it.metadata||{};
      var dep=(it.dependsOn&&it.dependsOn.length)?'<span class="dep">+'+it.dependsOn.length+'</span>':"";
      var cb='<td class="cbx"><input type="checkbox" class="cb2" '+(selSet.has(it.id)?"checked":"")+'></td>';
      if(rich){
        var live=!!m.live;
        var liveCell=live?'<span class="lv on">Yes</span>':'<span class="lv">No</span>';
        return '<tr class="trow'+(selSet.has(it.id)?" sel":"")+'" data-id="'+esc(it.id)+'">'+cb+
          '<td class="cName">'+esc(m.name||it.label||it.id)+'<div class="sub">'+esc(it.id)+'</div></td>'+
          '<td class="path">'+esc(m.path||m.folderPath||"/")+'</td>'+
          td(m.author)+
          '<td class="dt">'+esc(fmtDate(m.createdOn))+'</td>'+
          '<td class="dt">'+esc(fmtDate(m.modifiedOn))+'</td>'+
          td(m.status)+
          '<td>'+liveCell+'</td>'+
          '<td class="dt">'+(live?esc(m.version==null?"?":m.version):"—")+'</td>'+
          '<td>'+dep+'</td></tr>';
      }
      return '<tr class="trow'+(selSet.has(it.id)?" sel":"")+'" data-id="'+esc(it.id)+'">'+cb+
        '<td class="cName">'+esc(it.label||it.id)+'</td><td class="path">'+esc(it.id)+'</td><td>'+dep+'</td></tr>';
    }).join("");
    return '<div class="rows"><table class="ctab">'+head+body+'</table></div>';
  }

  // Generic selectable catalog renderer — reused by Migrate, Import (and Purge).
  // Renders sections into hostSel, tracks ticks in selSet, calls onCount()
  // after any change. Empty sections render an explicit "none" row.
  function renderSelectable(hostSel, sections, selSet, onCount){
    var host=$(hostSel); host.innerHTML="";
    if(!sections || !sections.length){ host.innerHTML='<span class="muted">Nothing to list.</span>'; onCount&&onCount(); return; }
    function tgl(id,onv,cb){ if(onv)selSet.add(id);else selSet.delete(id); var r=cb&&cb.closest(".trow"); if(r)r.classList.toggle("sel",onv); onCount&&onCount(); }
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
      on(bay.querySelector(".selall"),"click",function(){
        var cbs=bay.querySelectorAll(".cb2"); var allOn=Array.prototype.every.call(cbs,function(c){return c.checked;});
        cbs.forEach(function(cb){ cb.checked=!allOn; tgl(cb.closest(".trow").getAttribute("data-id"),!allOn,cb); });
      });
      bay.querySelectorAll(".trow").forEach(function(r){
        var cb=r.querySelector(".cb2"), id=r.getAttribute("data-id");
        on(cb,"change",function(e){ e.stopPropagation(); tgl(id,cb.checked,cb); });
        on(r,"click",function(e){ if(e.target===cb) return; cb.checked=!cb.checked; tgl(id,cb.checked,cb); });
      });
    });
    onCount&&onCount();
  }
  function renderCatalog(){
    if(!CAT||!CAT.sections){ $("#cpCatalog").innerHTML='<span class="glitch">No catalog.</span>'; return; }
    renderSelectable("#cpCatalog", CAT.sections, sel, cpSelN);
  }
  function cpSelN(){ $("#cpSelN").textContent="("+sel.size+" selected)"; }
  on($("#cpClr"),"click",function(){ sel.clear(); renderCatalog(); });
  on($("#cpGo"),"click",function(){
    if(!sel.size){ $("#cpGoMsg").textContent="Select at least one item."; return; }
    var src=$("#cpSrc").value.trim(),tgt=$("#cpTgt").value.trim();
    if(!src||!tgt){ $("#cpGoMsg").textContent="Source and target tenant required."; return; }
    $("#cpGo").disabled=true; $("#cpGoMsg").innerHTML='<span class="spin"></span> Running migration…';
    fetch("/api/migrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      sourceTenant:src,targetTenant:tgt,selectedIds:Array.from(sel),
      dryRun:$("#cpDry").checked,skipExport:$("#cpSkip").checked,allowSchemaMismatch:$("#cpSchema").checked,allowFolderMismatch:$("#cpFolder").checked,continueOnError:$("#cpCont").checked
    })}).then(function(r){return r.json();}).then(function(d){
      $("#cpGo").disabled=false;
      if(d.error){ $("#cpGoMsg").innerHTML='<span style="color:var(--red)">'+esc(d.error)+'</span>'; return; }
      var ids={bar:"#cpBar",ok:"#cpOk",err:"#cpErrN",tot:"#cpTot",items:"#cpItems"};
      $("#cpProgress").style.display="block";
      if(d.dryRun){
        // No run recorded — preview what WOULD migrate (no stale ledger).
        var prev=d.preview||[];
        $("#cpGoMsg").innerHTML='<span class="ok-msg">'+I.check+' Dry run — '+prev.length+' item(s) would migrate (nothing recorded)</span>';
        renderProgress({items:prev},true,ids);
      } else {
        $("#cpGoMsg").innerHTML=d.exitCode===0?'<span class="ok-msg">'+I.check+' Migration complete</span>':'<span style="color:var(--red)">'+I.x+' Finished with errors (exit '+d.exitCode+')</span>';
        renderProgress(d.latestRun,false,ids);
        loadRuns(); // refresh Logs so the new run shows there
      }
      $("#cpOut").textContent=d.output||"(no output)";
      $("#cpS3").innerHTML=d.dryRun?"":s3Note(d.output);
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
    $(ids.items).innerHTML=items.map(function(it){
      var cls=it.status==="done"?"ok":it.status==="error"?"err":"skip";
      var m=it.status==="done"?I.check:it.status==="error"?I.x:"·";
      return '<div class="it '+cls+'"><span class="m">'+m+'</span><span class="tag '+esc(it.type)+'" style="padding:1px 7px">'+esc(it.type)+'</span>'+
        '<span class="id">'+esc(it.id)+'</span><span class="act">'+esc(it.error||it.action||it.status)+'</span></div>';
    }).join("")||'<div class="it muted" style="padding:14px">No items.</div>';
  }

  // ─── LOGS ─────────────────────────────────────────────────
  var RUNS=[];
  function loadRuns(){
    fetch("/api/metrics").then(function(r){return r.json();}).then(function(a){
      $("#lgMetHdr").textContent="· "+a.runs+" run(s), "+a.failedRuns+" failed";
      var top=(a.topErrors||[]).slice(0,5).map(function(e){return '<div class="it"><span class="id">'+esc(e.error)+'</span><span class="act">'+e.count+"×</span></div>";}).join("");
      $("#lgMetrics").innerHTML='<div class="pgrid"><div class="stat tot"><div class="n">'+a.items+'</div><div class="u">Items</div></div>'+
        '<div class="stat ok"><div class="n">'+a.byStatus.done+'</div><div class="u">Done</div></div>'+
        '<div class="stat err"><div class="n">'+a.byStatus.error+'</div><div class="u">Errors</div></div></div>'+
        (top?'<div class="panel" style="margin-top:6px">'+top+'</div>':"");
    });
    fetch("/api/runs").then(function(r){return r.json();}).then(function(rs){ RUNS=rs; filterRuns(); });
  }
  function filterRuns(){
    var q=$("#lgQ").value.trim().toLowerCase();
    var from=$("#lgFrom").value, to=$("#lgTo").value;
    var out=RUNS.filter(function(r){
      var d=(r.createdAt||"").slice(0,10);
      if(from&&d<from) return false;
      if(to&&d>to) return false;
      if(q){
        var hay=(r.id+" "+r.status+" "+(r.environment&&r.environment.tenant||"")+" "+(r.environment&&r.environment.role||"")).toLowerCase();
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
      var pill=st.indexOf("complete")>=0?"complete":st.indexOf("fail")>=0||(s.error>0)?"failed":"in-progress";
      var row=document.createElement("div"); row.className="runrow";
      row.innerHTML='<span class="pill '+pill+'">'+esc(st||"?")+'</span>'+
        '<span class="mono" style="font-size:12px">'+esc(r.id)+'</span>'+
        '<span class="muted" style="font-size:12px">tenant '+esc(r.environment&&r.environment.tenant||"?")+'</span>'+
        '<span class="spacer" style="flex:1"></span>'+
        '<span class="faint" style="font-size:11.5px">done '+(s.done||0)+' · err '+(s.error||0)+' · pend '+(s.pending||0)+'</span>'+
        '<span class="faint" style="font-size:11px;margin-left:10px">'+esc((r.createdAt||"").replace("T"," ").slice(0,19))+'</span>';
      on(row,"click",function(){ showRun(r.id); });
      host.appendChild(row);
    });
  }
  function showRun(id){
    fetch("/api/runs/"+encodeURIComponent(id)).then(function(r){return r.json();}).then(function(run){
      $("#lgDetail").style.display="block";
      renderProgress(run,false,{bar:"#lgBar",ok:"#lgOk",err:"#lgErr",tot:"#lgTot",items:"#lgItems"});
      $("#lgDetail").scrollIntoView({behavior:"smooth"});
    });
  }
  on($("#lgBack"),"click",function(){ $("#lgDetail").style.display="none"; });
  on($("#lgReload"),"click",loadRuns);
  on($("#lgClear"),"click",function(){ $("#lgQ").value=""; $("#lgFrom").value=""; $("#lgTo").value=""; filterRuns(); });
  on($("#lgQ"),"input",filterRuns); on($("#lgFrom"),"change",filterRuns); on($("#lgTo"),"change",filterRuns);

  // ─── PURGE ────────────────────────────────────────────────
  var purgeSel=new Set();
  toggleWrap("pgPerm"); toggleWrap("pgSame");
  function pgSelN(){ $("#pgSelN").textContent="("+purgeSel.size+" selected)"; }
  on($("#pgLoad"),"click",function(){
    var t=$("#pgTenant").value.trim(); if(!t){ $("#pgLoadMsg").textContent="Enter the target tenant id."; return; }
    $("#pgLoad").disabled=true; $("#pgLoadMsg").innerHTML='<span class="spin"></span> Cataloging target…';
    fetch("/api/catalog/build",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({env:"target",targetTenant:t})})
      .then(function(r){return r.json();}).then(function(c){
        $("#pgLoad").disabled=false;
        if(c.error){ $("#pgLoadMsg").innerHTML='<span style="color:var(--red)">'+esc(c.error)+'</span>'; return; }
        purgeSel.clear(); $("#pgLoadMsg").textContent=""; $("#pgSelect").style.display="block"; $("#pgResult").style.display="none";
        renderSelectable("#pgCatalog", (c.sections||[]), purgeSel, pgSelN);
        $("#pgSelect").scrollIntoView({behavior:"smooth"});
      }).catch(function(err){ $("#pgLoad").disabled=false; $("#pgLoadMsg").textContent="Request failed: "+err; });
  });
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
      var ok=s.exitCode===0;
      return '<div class="it '+(ok?"ok":"err")+'"><span class="m">'+(ok?I.check:I.x)+'</span><span class="tag '+esc(s.type)+'">'+esc(s.type)+'</span><span class="id">'+s.count+' selected</span><span class="act">'+(ok?(d.dryRun?"previewed":"purged"):"exit "+s.exitCode)+'</span></div>';
    }).join("")||'<div class="it muted" style="padding:12px">Nothing matched.</div>';
    $("#pgResultBody").innerHTML='<div class="panel">'+rows+'</div>'+(d.dryRun?'<p class="muted" style="margin-top:8px">Dry-run — nothing deleted. Use “Delete selected…” to execute.</p>':'<p class="ok-msg" style="margin-top:8px">'+I.check+' Purge executed'+(d.permanent?" (permanent)":" (soft — recoverable from the bin/Trash)")+'.</p>');
    $("#pgOut").textContent=(d.sections||[]).map(function(s){return "── "+s.pkg+" ──\\n"+s.output;}).join("\\n");
    $("#pgMsg").textContent="";
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

