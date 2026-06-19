/**
 * Persistent run state — the audit ledger for migrations.
 *
 * Each migration is a MigrationRun saved as JSON under a runs directory
 * (default .runs/). It records every selected artifact as a RunItem with its
 * status, so a run is:
 *   - resumable  — re-run only items not yet `done`
 *   - idempotent — skip items already `done`
 *   - auditable  — the run file is the structured record of what happened
 *
 * JSON file store (no native deps). A SQLite/Prisma backend can replace this
 * behind the same shape later.
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

function runFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
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

export function saveRun(dir: string, run: MigrationRun): void {
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: a crash mid-write must not leave a truncated run file.
  const f = runFile(dir, run.id);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2), "utf-8");
  fs.renameSync(tmp, f);
}

export function loadRun(dir: string, id: string): MigrationRun {
  const f = runFile(dir, id);
  if (!fs.existsSync(f)) throw new Error(`Run not found: ${id} (looked in ${dir})`);
  return JSON.parse(fs.readFileSync(f, "utf-8")) as MigrationRun;
}

export function listRuns(dir: string): MigrationRun[] {
  if (!fs.existsSync(dir)) return [];
  const runs: MigrationRun[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue; // ignore .events.jsonl, .tmp, etc.
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as MigrationRun);
    } catch {
      /* skip a corrupt/partial run file rather than breaking listing */
    }
  }
  return runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Items for a given type that still need work (not `done`). */
export function pendingItems(run: MigrationRun, type: ArtifactType): RunItem[] {
  return run.items.filter((i) => i.type === type && i.status !== "done");
}

/** Apply per-item results from an import step into the run, bumping attempts. */
export function applyResults(run: MigrationRun, results: ItemResult[], now: string): void {
  const index = new Map<string, RunItem>();
  for (const it of run.items) index.set(`${it.type}::${it.id}`, it);
  for (const r of results) {
    const it = index.get(`${r.type}::${r.id}`);
    if (!it) continue;
    it.status = r.status;
    it.action = r.action;
    it.error = r.error;
    it.attempts += 1;
    it.updatedAt = now;
  }
  run.updatedAt = now;
  run.status = run.items.every((i) => i.status === "done" || i.status === "skipped")
    ? "complete"
    : run.items.some((i) => i.status === "error")
      ? "failed"
      : "in-progress";
}

/** Summary counts by status. */
export function runSummary(run: MigrationRun): Record<RunItemStatus, number> {
  const out: Record<RunItemStatus, number> = { pending: 0, done: 0, skipped: 0, error: 0 };
  for (const i of run.items) out[i.status] += 1;
  return out;
}
