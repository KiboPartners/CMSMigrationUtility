/**
 * Observability — structured event logs, run metrics, and error aggregation.
 *
 * Built on the existing hooks: the run ledger (per-item status + timestamps) and
 * the logger. The orchestrator writes a JSONL event stream per run (machine
 * readable, one event per line) alongside the run JSON, and metrics are computed
 * from the ledger. A real sink (Datadog, CloudWatch, OTel) can tail the JSONL or
 * subscribe to emitEvent without changing callers.
 */

import fs from "fs";
import path from "path";
import { MigrationRun, RunItemStatus } from "./runstore";

// ── Structured events ───────────────────────────────────────────────────────

export type EventType =
  | "run.start" | "run.end"
  | "step.start" | "step.end"
  | "item.error";

export interface LogEvent {
  ts: string;
  type: EventType;
  runId: string;
  /** Artifact type / step, when relevant. */
  scope?: string;
  data?: Record<string, unknown>;
}

/** Path of the JSONL event stream for a run. */
export function eventsFile(runsDir: string, runId: string): string {
  return path.join(runsDir, `${runId}.events.jsonl`);
}

/** Append one structured event (JSONL). Best-effort; never throws to the caller. */
export function emitEvent(runsDir: string, ev: LogEvent): void {
  try {
    fs.mkdirSync(runsDir, { recursive: true });
    fs.appendFileSync(eventsFile(runsDir, ev.runId), JSON.stringify(ev) + "\n", "utf-8");
  } catch {
    /* observability must not break the migration */
  }
}

// ── Run metrics ───────────────────────────────────────────────────────────────

export interface RunMetrics {
  total: number;
  byStatus: Record<RunItemStatus, number>;
  errorRate: number;        // errors / total
  durationMs: number | null;
  itemsPerSec: number | null;
}

export function computeMetrics(run: MigrationRun): RunMetrics {
  const byStatus: Record<RunItemStatus, number> = { pending: 0, done: 0, skipped: 0, error: 0 };
  for (const i of run.items) byStatus[i.status] += 1;
  const total = run.items.length;

  let durationMs: number | null = null;
  if (run.createdAt && run.updatedAt) {
    const d = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
    durationMs = Number.isFinite(d) && d >= 0 ? d : null;
  }
  const completed = byStatus.done + byStatus.skipped;
  const itemsPerSec = durationMs && durationMs > 0 ? +(completed / (durationMs / 1000)).toFixed(2) : null;

  return {
    total,
    byStatus,
    errorRate: total ? +(byStatus.error / total).toFixed(3) : 0,
    durationMs,
    itemsPerSec,
  };
}

/** Aggregate metrics across many runs — for an "error tracking" overview. */
export interface AggregateMetrics {
  runs: number;
  items: number;
  errors: number;
  errorRate: number;
  byStatus: Record<RunItemStatus, number>;
  failedRuns: number;
  topErrors: Array<{ error: string; count: number }>;
}

export function aggregateMetrics(runs: MigrationRun[]): AggregateMetrics {
  const byStatus: Record<RunItemStatus, number> = { pending: 0, done: 0, skipped: 0, error: 0 };
  const errorCounts = new Map<string, number>();
  let items = 0, failedRuns = 0;

  for (const run of runs) {
    if (run.status === "failed") failedRuns += 1;
    for (const it of run.items) {
      items += 1;
      byStatus[it.status] += 1;
      if (it.status === "error" && it.error) {
        const key = it.error.slice(0, 120);
        errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const topErrors = [...errorCounts.entries()]
    .map(([error, count]) => ({ error, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    runs: runs.length,
    items,
    errors: byStatus.error,
    errorRate: items ? +(byStatus.error / items).toFixed(3) : 0,
    byStatus,
    failedRuns,
    topErrors,
  };
}
