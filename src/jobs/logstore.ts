/**
 * Workstream log store — one directory per run under
 *   .logs/{export,import,migrate,purge}/<runId>/
 */

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { Logger, consoleLogger, setLogger } from "../shared/logger";

export type Workstream = "export" | "import" | "migrate" | "purge";

export interface RunMeta {
  runId: string;
  workstream: Workstream;
  status: "running" | "done" | "error";
  startedAt: string;
  endedAt?: string;
  sourceTenant?: string;
  targetTenant?: string;
  argsSummary?: string;
  error?: string;
}

export interface LogStoreEvents {
  log: (line: string, level: "log" | "warn" | "error" | "write") => void;
  progress: (p: { done: number; total: number; label: string; artifact?: string }) => void;
  status: (meta: RunMeta) => void;
}

export class WorkstreamRun extends EventEmitter {
  readonly dir: string;
  readonly meta: RunMeta;
  private consolePath: string;
  private eventsPath: string;
  private closed = false;

  /**
   * @param opts.attach — reopen an existing run dir (UI parent already created it).
   *   Preserves startedAt/status; does not reset the run to "running".
   */
  constructor(
    logsRoot: string,
    workstream: Workstream,
    runId: string,
    init: Partial<RunMeta> = {},
    opts: { attach?: boolean } = {}
  ) {
    super();
    this.dir = path.join(logsRoot, workstream, runId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.consolePath = path.join(this.dir, "console.log");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    const metaPath = path.join(this.dir, "meta.json");
    if (opts.attach && fs.existsSync(metaPath)) {
      this.meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as RunMeta;
      for (const key of ["sourceTenant", "targetTenant", "argsSummary"] as const) {
        if (init[key] !== undefined) this.meta[key] = init[key];
      }
      this.closed = this.meta.status !== "running";
      this.writeMeta();
    } else {
      this.meta = {
        runId,
        workstream,
        status: "running",
        startedAt: new Date().toISOString(),
        ...init,
      };
      this.writeMeta();
    }
  }

  private writeMeta(): void {
    fs.writeFileSync(path.join(this.dir, "meta.json"), JSON.stringify(this.meta, null, 2), "utf-8");
  }

  /** Re-read meta.json (e.g. after a child CLI finished the same run on disk). */
  reloadMeta(): void {
    const metaPath = path.join(this.dir, "meta.json");
    if (!fs.existsSync(metaPath)) return;
    const onDisk = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as RunMeta;
    Object.assign(this.meta, onDisk);
    this.closed = this.meta.status !== "running";
  }

  appendConsole(text: string): void {
    fs.appendFileSync(this.consolePath, text.endsWith("\n") ? text : text + "\n", "utf-8");
  }

  /** Append a console line and notify SSE subscribers. */
  logLine(text: string, level: "log" | "warn" | "error" = "log"): void {
    this.appendConsole(text);
    this.emit("log", text, level);
  }

  emitEvent(type: string, data?: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, runId: this.meta.runId, data });
    fs.appendFileSync(this.eventsPath, line + "\n", "utf-8");
  }

  reportProgress(p: { done: number; total: number; label: string; artifact?: string }): void {
    this.emitEvent("progress", p);
    this.emit("progress", p);
  }

  finish(status: "done" | "error", error?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.meta.status = status;
    this.meta.endedAt = new Date().toISOString();
    if (error) this.meta.error = error;
    this.writeMeta();
    this.emitEvent("run.end", { status, error });
    this.emit("status", this.meta);
  }

  writeErrors(errors: unknown): void {
    fs.writeFileSync(path.join(this.dir, "errors.json"), JSON.stringify(errors, null, 2), "utf-8");
  }

  writeLedger(ledger: unknown): void {
    fs.writeFileSync(path.join(this.dir, "ledger.json"), JSON.stringify(ledger, null, 2), "utf-8");
  }

  /** Install a logger that tees to console + this run's console.log + SSE listeners. */
  installTeeLogger(): () => void {
    const prev = consoleLogger;
    const tee: Logger = {
      log: (m, ...r) => {
        const text = [m, ...r].filter((x) => x !== undefined).map(String).join(" ");
        prev.log(m, ...r);
        this.appendConsole(text);
        this.emit("log", text, "log");
      },
      warn: (m, ...r) => {
        const text = [m, ...r].filter((x) => x !== undefined).map(String).join(" ");
        prev.warn(m, ...r);
        this.appendConsole(text);
        this.emit("log", text, "warn");
      },
      error: (m, ...r) => {
        const text = [m, ...r].filter((x) => x !== undefined).map(String).join(" ");
        prev.error(m, ...r);
        this.appendConsole(text);
        this.emit("log", text, "error");
      },
      write: (t) => {
        prev.write(t);
        this.appendConsole(t.endsWith("\n") ? t : t);
        this.emit("log", t, "write");
      },
    };
    setLogger(tee);
    return () => setLogger(prev);
  }
}

export function defaultLogsRoot(repoRoot: string): string {
  return path.join(repoRoot, ".logs");
}

export function newRunId(prefix = "run"): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/** Safe run-id charset (also used by the UI for path segments). */
const RUN_ID_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * When the web UI (or another parent) already opened a workstream run, it sets
 * `KIBO_RUN_ID` so the child CLI attaches to that folder instead of minting a second one.
 */
export function inheritedRunId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = (env["KIBO_RUN_ID"] ?? "").trim();
  return id && RUN_ID_RE.test(id) ? id : null;
}

/**
 * Open a workstream run for a root CLI command.
 * - Under the UI: attach to `KIBO_RUN_ID` (no tee — parent already streams stdout into console.log).
 * - Standalone: create a new run and tee logger → console.log.
 */
export function openCliWorkstream(
  logsRoot: string,
  workstream: Workstream,
  init: Partial<RunMeta> = {}
): { run: WorkstreamRun; restore: () => void; attached: boolean } {
  const inherited = inheritedRunId();
  if (inherited) {
    const run = new WorkstreamRun(logsRoot, workstream, inherited, init, { attach: true });
    return { run, restore: () => {}, attached: true };
  }
  const run = new WorkstreamRun(logsRoot, workstream, newRunId(workstream), init);
  return { run, restore: run.installTeeLogger(), attached: false };
}

export function listWorkstreamRuns(logsRoot: string, workstream?: Workstream): RunMeta[] {
  const streams: Workstream[] = workstream
    ? [workstream]
    : ["export", "import", "migrate", "purge"];
  const out: RunMeta[] = [];
  for (const ws of streams) {
    const dir = path.join(logsRoot, ws);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const metaPath = path.join(dir, name, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(metaPath, "utf-8")) as RunMeta);
      } catch {
        /* skip corrupt */
      }
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function loadRunDir(logsRoot: string, workstream: Workstream, runId: string): string | null {
  const dir = path.join(logsRoot, workstream, runId);
  return fs.existsSync(path.join(dir, "meta.json")) ? dir : null;
}

/** Read legacy `.runs/<id>.json` ledgers for Logs UI fallback. */
export function listLegacyMigrateRuns(runsDir: string): Array<{ runId: string; path: string }> {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir)
    .filter((f) => f.endsWith(".json") && !f.includes(".events"))
    .map((f) => ({ runId: f.replace(/\.json$/, ""), path: path.join(runsDir, f) }));
}
