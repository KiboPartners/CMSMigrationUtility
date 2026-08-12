import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  WorkstreamRun,
  listWorkstreamRuns,
  newRunId,
  inheritedRunId,
  openCliWorkstream,
} from "../src/jobs/logstore";

describe("workstream logstore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-logs-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env["KIBO_RUN_ID"];
  });

  it("writes meta + console under .logs/<workstream>/<runId>/", () => {
    const id = newRunId("export");
    const run = new WorkstreamRun(tmp, "export", id, { sourceTenant: "t1" });
    run.logLine("hello");
    run.finish("done");

    const meta = JSON.parse(fs.readFileSync(path.join(tmp, "export", id, "meta.json"), "utf-8"));
    expect(meta.status).toBe("done");
    expect(meta.sourceTenant).toBe("t1");
    expect(fs.readFileSync(path.join(tmp, "export", id, "console.log"), "utf-8")).toContain("hello");

    const listed = listWorkstreamRuns(tmp, "export");
    expect(listed.some((m) => m.runId === id)).toBe(true);
  });

  it("inheritedRunId reads a safe KIBO_RUN_ID", () => {
    expect(inheritedRunId({})).toBeNull();
    expect(inheritedRunId({ KIBO_RUN_ID: "export-2026-01-01" })).toBe("export-2026-01-01");
    expect(inheritedRunId({ KIBO_RUN_ID: "../evil" })).toBeNull();
  });

  it("openCliWorkstream attaches to KIBO_RUN_ID instead of minting a second folder", () => {
    const parent = new WorkstreamRun(tmp, "export", "export-parent", { sourceTenant: "t1" });
    const startedAt = parent.meta.startedAt;
    process.env["KIBO_RUN_ID"] = "export-parent";

    const { run, attached, restore } = openCliWorkstream(tmp, "export", { argsSummary: "export-all" });
    expect(attached).toBe(true);
    expect(run.meta.runId).toBe("export-parent");
    expect(run.meta.startedAt).toBe(startedAt);
    expect(run.meta.argsSummary).toBe("export-all");
    run.finish("error", "stopped");
    restore();

    parent.reloadMeta();
    expect(parent.meta.status).toBe("error");
    expect(listWorkstreamRuns(tmp, "export")).toHaveLength(1);
  });
});
