/**
 * In-memory job registry for the web UI — starts workstreams async and
 * fans log/progress events out to SSE subscribers.
 */

import { EventEmitter } from "events";
import {
  Workstream,
  WorkstreamRun,
  defaultLogsRoot,
  newRunId,
  RunMeta,
} from "./logstore";

export interface JobSnapshot {
  jobId: string;
  workstream: Workstream;
  status: "running" | "done" | "error";
  lines: string[];
  meta: RunMeta;
  progress?: { done: number; total: number; label: string; artifact?: string };
  error?: string;
}

type JobFn = (run: WorkstreamRun) => Promise<void>;

interface JobRecord {
  run: WorkstreamRun;
  lines: string[];
  progress?: JobSnapshot["progress"];
  bus: EventEmitter;
}

const jobs = new Map<string, JobRecord>();

export function startJob(
  repoRoot: string,
  workstream: Workstream,
  fn: JobFn,
  init: Partial<RunMeta> = {}
): { jobId: string; run: WorkstreamRun } {
  const jobId = newRunId(workstream);
  const run = new WorkstreamRun(defaultLogsRoot(repoRoot), workstream, jobId, init);
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  const rec: JobRecord = { run, lines: [], bus };
  jobs.set(jobId, rec);

  const restore = run.installTeeLogger();
  run.on("log", (line: string) => {
    rec.lines.push(line);
    if (rec.lines.length > 5000) rec.lines.splice(0, rec.lines.length - 4000);
    bus.emit("log", line);
  });
  run.on("progress", (p: JobSnapshot["progress"]) => {
    rec.progress = p;
    bus.emit("progress", p);
  });

  run.emitEvent("run.start", { workstream });

  void (async () => {
    try {
      await fn(run);
      // Child CLI may have finished the same run on disk (KIBO_RUN_ID attach).
      run.reloadMeta();
      if (run.meta.status === "running") run.finish("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      run.reloadMeta();
      if (run.meta.status === "running") {
        run.appendConsole(`ERROR: ${msg}`);
        run.finish("error", msg);
      }
      bus.emit("log", `ERROR: ${msg}`);
    } finally {
      restore();
      bus.emit("status", run.meta);
      bus.emit("done", run.meta);
    }
  })();

  return { jobId, run };
}

export function getJob(jobId: string): JobSnapshot | null {
  const rec = jobs.get(jobId);
  if (!rec) return null;
  return {
    jobId,
    workstream: rec.run.meta.workstream,
    status: rec.run.meta.status,
    lines: rec.lines.slice(),
    meta: rec.run.meta,
    progress: rec.progress,
    error: rec.run.meta.error,
  };
}

export function subscribeJob(
  jobId: string,
  handlers: {
    onLog?: (line: string) => void;
    onProgress?: (p: NonNullable<JobSnapshot["progress"]>) => void;
    onDone?: (meta: RunMeta) => void;
  }
): () => void {
  const rec = jobs.get(jobId);
  if (!rec) return () => {};
  if (handlers.onLog) rec.bus.on("log", handlers.onLog);
  if (handlers.onProgress) rec.bus.on("progress", handlers.onProgress);
  if (handlers.onDone) rec.bus.on("done", handlers.onDone);
  return () => {
    if (handlers.onLog) rec.bus.off("log", handlers.onLog);
    if (handlers.onProgress) rec.bus.off("progress", handlers.onProgress);
    if (handlers.onDone) rec.bus.off("done", handlers.onDone);
  };
}
