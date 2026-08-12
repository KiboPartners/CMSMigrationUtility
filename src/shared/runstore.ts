/**
 * Persistent run state — the audit ledger for migrations.
 *
 * Each migration is a MigrationRun saved under a runs directory
 * (default `.logs/migrate/`). Layout per run:
 *   <runsDir>/<runId>/ledger.json
 * Legacy flat files (`<runsDir>/<runId>.json` under `.runs/`) are still readable.
 *
 * A run is:
 *   - resumable  — re-run only items not yet `done`
 *   - idempotent — skip items already `done`
 *   - auditable  — the ledger is the structured record of what happened
 */

import fs from "fs";
import path from "path";
import { ArtifactType } from "./catalog";
import { MigrationPlan } from "./plan";

export type RunItemStatus = "pending" | "done" | "skipped" | "error";

export interface RunItem {
  type: ArtifactType;
  id: string;
  status: RunItemStatus;
  action?: string;      // created | updated | skipped | published | …
  error?: string;
  attempts: number;
  updatedAt: string | null;
}

export type RunStatus = "in-progress" | "complete" | "failed";

export interface MigrationRun {
  id: string;
  createdAt: string | null;
  updatedAt: string | null;
  environment: { role: string; tenant: string; locale: string };
  status: RunStatus;
  items: RunItem[];
}

/** Per-item outcome reported by an import step (read from its --result file). */
export interface ItemResult {
  type: ArtifactType;
  id: string;
  status: RunItemStatus;
  action?: string;
  error?: string;
}

export interface ResultFile {
  items: ItemResult[];
}

/** Nested ledger path (current layout). */
export function ledgerPath(dir: string, id: string): string {
  return path.join(dir, id, "ledger.json");
}

/** Legacy flat ledger path (pre-streamline `.runs/<id>.json`). */
export function legacyLedgerPath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function resolveExistingLedger(dir: string, id: string): string | null {
  const nested = ledgerPath(dir, id);
  if (fs.existsSync(nested)) return nested;
  const flat = legacyLedgerPath(dir, id);
  if (fs.existsSync(flat)) return flat;
  return null;
}

/** Build a new run from a plan. All items start `pending`. */
export function createRun(
  id: string,
  environment: MigrationRun["environment"],
  plan: MigrationPlan,
  now: string
): MigrationRun {
  const items: RunItem[] = [];
  for (const step of plan.steps) {
    for (const itemId of step.ids) {
      items.push({ type: step.type, id: itemId, status: "pending", attempts: 0, updatedAt: null });
    }
  }
  return { id, createdAt: now, updatedAt: now, environment, status: "in-progress", items };
}

/** Empty ledger (items added later via applyResults upsert) — used by export/import-all. */
export function createEmptyRun(
  id: string,
  environment: MigrationRun["environment"],
  now: string
): MigrationRun {
  return { id, createdAt: now, updatedAt: now, environment, status: "in-progress", items: [] };
}

/** Ledger seeded from known ids (purge selection, etc.). All items start `pending`. */
export function createRunFromItems(
  id: string,
  environment: MigrationRun["environment"],
  seeds: Array<{ type: ArtifactType; id: string }>,
  now: string
): MigrationRun {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    environment,
    status: "in-progress",
    items: seeds.map((s) => ({ type: s.type, id: s.id, status: "pending" as const, attempts: 0, updatedAt: null })),
  };
}

/** Workstream dirs under `.logs/` that may hold `ledger.json` (plus optional legacy `.runs`). */
export const WORKSTREAM_LEDGER_NAMES = ["migrate", "import", "export", "purge"] as const;

/** Resolve `<logsRoot>/{migrate,import,export,purge}` (+ optional extra fallbacks like `.runs`). */
export function workstreamLedgerDirs(logsRoot: string, extra: string[] = []): string[] {
  return [...WORKSTREAM_LEDGER_NAMES.map((ws) => path.join(logsRoot, ws)), ...extra];
}

export function saveRun(dir: string, run: MigrationRun): void {
  const runDir = path.join(dir, run.id);
  fs.mkdirSync(runDir, { recursive: true });
  // Atomic write: a crash mid-write must not leave a truncated run file.
  const f = ledgerPath(dir, run.id);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2), "utf-8");
  fs.renameSync(tmp, f);
}

export function loadRun(dir: string, id: string): MigrationRun {
  const f = resolveExistingLedger(dir, id);
  if (!f) throw new Error(`Run not found: ${id} (looked in ${dir})`);
  return JSON.parse(fs.readFileSync(f, "utf-8")) as MigrationRun;
}

/**
 * Load a run from `dir`, falling back to each path in `fallbackDirs`
 * (e.g. legacy `.runs/` when the default is `.logs/migrate/`).
 */
export function loadRunWithFallback(dir: string, id: string, fallbackDirs: string[] = []): MigrationRun {
  try {
    return loadRun(dir, id);
  } catch {
    for (const fb of fallbackDirs) {
      try {
        return loadRun(fb, id);
      } catch {
        /* try next */
      }
    }
    throw new Error(`Run not found: ${id} (looked in ${[dir, ...fallbackDirs].join(", ")})`);
  }
}

function listRunsInDir(dir: string): MigrationRun[] {
  if (!fs.existsSync(dir)) return [];
  const runs: MigrationRun[] = [];
  const seen = new Set<string>();

  for (const name of fs.readdirSync(dir)) {
    const nested = path.join(dir, name, "ledger.json");
    if (fs.existsSync(nested)) {
      try {
        const run = JSON.parse(fs.readFileSync(nested, "utf-8")) as MigrationRun;
        if (!seen.has(run.id)) {
          seen.add(run.id);
          runs.push(run);
        }
      } catch {
        /* skip corrupt */
      }
      continue;
    }
    // Legacy flat: <id>.json (skip .events.jsonl / .tmp)
    if (!name.endsWith(".json") || name.endsWith(".tmp.json")) continue;
    if (name.includes(".events.")) continue;
    try {
      const run = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as MigrationRun;
      if (run?.id && !seen.has(run.id)) {
        seen.add(run.id);
        runs.push(run);
      }
    } catch {
      /* skip a corrupt/partial run file rather than breaking listing */
    }
  }
  return runs;
}

export function listRuns(dir: string, fallbackDirs: string[] = []): MigrationRun[] {
  const runs = listRunsInDir(dir);
  const seen = new Set(runs.map((r) => r.id));
  for (const fb of fallbackDirs) {
    for (const r of listRunsInDir(fb)) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        runs.push(r);
      }
    }
  }
  return runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Items for a given type that still need work (not `done`). */
export function pendingItems(run: MigrationRun, type: ArtifactType): RunItem[] {
  return run.items.filter((i) => i.type === type && i.status !== "done");
}

/**
 * Apply per-item results into the run, bumping attempts.
 * Unknown `(type, id)` pairs are upserted so export/import-all can grow the
 * ledger as packages report outcomes (unlike migrate, which seeds from a plan).
 */
export function applyResults(run: MigrationRun, results: ItemResult[], now: string): void {
  const index = new Map<string, RunItem>();
  for (const it of run.items) index.set(`${it.type}::${it.id}`, it);
  for (const r of results) {
    let it = index.get(`${r.type}::${r.id}`);
    if (!it) {
      it = { type: r.type, id: r.id, status: "pending", attempts: 0, updatedAt: null };
      run.items.push(it);
      index.set(`${r.type}::${r.id}`, it);
    }
    it.status = r.status;
    it.action = r.action;
    it.error = r.error;
    it.attempts += 1;
    it.updatedAt = now;
  }
  run.updatedAt = now;
  if (run.items.length === 0) {
    run.status = "complete";
    return;
  }
  run.status = run.items.every((i) => i.status === "done" || i.status === "skipped")
    ? "complete"
    : run.items.some((i) => i.status === "error")
      ? "failed"
      : "in-progress";
}

/** Read a `--result` JSON file into ItemResult[]; empty/missing → []. */
export function readResultFile(file: string): ItemResult[] {
  if (!fs.existsSync(file)) return [];
  try {
    const body = JSON.parse(fs.readFileSync(file, "utf-8")) as ResultFile;
    return Array.isArray(body.items) ? body.items : [];
  } catch {
    return [];
  }
}

/**
 * Build ItemResult rows for a selective purge when the package only reports
 * aggregate errors (id keys must match the selection ids).
 */
export function synthesizePurgeResults(
  type: ArtifactType,
  ids: string[],
  dryRun: boolean,
  errors: Array<{ id: string; error: string }> = [],
  stepFailed = false
): ItemResult[] {
  const errById = new Map(errors.map((e) => [e.id, e.error]));
  return ids.map((id) => {
    if (stepFailed) {
      return { type, id, status: "error" as const, error: errById.get(id) || "purge step failed" };
    }
    const err = errById.get(id);
    if (err) return { type, id, status: "error" as const, error: err };
    if (dryRun) return { type, id, status: "skipped" as const, action: "would-delete" };
    return { type, id, status: "done" as const, action: "deleted" };
  });
}

/** Summary counts by status. */
export function runSummary(run: MigrationRun): Record<RunItemStatus, number> {
  const out: Record<RunItemStatus, number> = { pending: 0, done: 0, skipped: 0, error: 0 };
  for (const i of run.items) out[i.status] += 1;
  return out;
}
