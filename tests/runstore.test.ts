import { describe, it, expect } from "vitest";
import {
  createRun, createEmptyRun, createRunFromItems, applyResults, runSummary, pendingItems,
  synthesizePurgeResults, workstreamLedgerDirs,
} from "../src/shared/runstore";
import type { MigrationPlan } from "../src/shared/plan";
import path from "path";

const plan: MigrationPlan = {
  steps: [{ type: "cms-entry", ids: ["e1", "e2"] }],
  selectedCount: 2, resolvedCount: 2, addedByDependencies: [], unknownIds: [],
};
const env = { role: "source", tenant: "t", locale: "en-US" };

describe("runstore", () => {
  it("creates a run with all items pending", () => {
    const r = createRun("r1", env, plan, "2026-01-01T00:00:00Z");
    expect(r.items.length).toBe(2);
    expect(runSummary(r).pending).toBe(2);
    expect(r.status).toBe("in-progress");
  });

  it("applies per-item results and recomputes status + pending", () => {
    const r = createRun("r1", env, plan, "t0");
    applyResults(r, [
      { type: "cms-entry", id: "e1", status: "done", action: "created" },
      { type: "cms-entry", id: "e2", status: "error", error: "boom" },
    ], "t1");
    const s = runSummary(r);
    expect(s.done).toBe(1);
    expect(s.error).toBe(1);
    expect(r.status).toBe("failed");
    expect(pendingItems(r, "cms-entry").map((i) => i.id)).toEqual(["e2"]); // done item skipped on resume
  });

  it("marks complete when all done/skipped", () => {
    const r = createRun("r1", env, plan, "t0");
    applyResults(r, [
      { type: "cms-entry", id: "e1", status: "done" },
      { type: "cms-entry", id: "e2", status: "skipped" },
    ], "t1");
    expect(r.status).toBe("complete");
  });

  it("upserts unknown items so export/import can grow an empty ledger", () => {
    const r = createEmptyRun("r1", env, "t0");
    applyResults(r, [
      { type: "file", id: "https://cdn/a.png", status: "done", action: "exported" },
      { type: "cms-entry", id: "e1", status: "done", action: "exported" },
    ], "t1");
    expect(r.items.length).toBe(2);
    expect(r.status).toBe("complete");
  });

  it("seeds purge selection and synthesizes dry-run outcomes", () => {
    const r = createRunFromItems("p1", env, [
      { type: "page", id: "p1" },
      { type: "page", id: "p2" },
    ], "t0");
    applyResults(r, synthesizePurgeResults("page", ["p1", "p2"], true), "t1");
    expect(runSummary(r).skipped).toBe(2);
    expect(r.items.every((i) => i.action === "would-delete")).toBe(true);
  });

  it("lists workstream ledger dirs under logs root", () => {
    const dirs = workstreamLedgerDirs("/repo/.logs", ["/repo/.runs"]);
    expect(dirs).toEqual([
      path.join("/repo/.logs", "migrate"),
      path.join("/repo/.logs", "import"),
      path.join("/repo/.logs", "export"),
      path.join("/repo/.logs", "purge"),
      "/repo/.runs",
    ]);
  });
});
