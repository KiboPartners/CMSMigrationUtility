import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRun, saveRun, loadRun, listRuns } from "../shared/src/runstore";
import type { MigrationPlan } from "../shared/src/plan";

const dir = path.join(os.tmpdir(), `kibo-runstore-test-${process.pid}`);
const env = { role: "source", tenant: "t", locale: "en-US" };
const plan: MigrationPlan = { steps: [{ type: "cms-entry", ids: ["e1"] }], selectedCount: 1, resolvedCount: 1, addedByDependencies: [], unknownIds: [] };

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("runstore fs durability", () => {
  it("saves atomically (no leftover .tmp) and round-trips", () => {
    saveRun(dir, createRun("run-1", env, plan, "2026-01-01T00:00:00Z"));
    const left = fs.readdirSync(dir);
    expect(left).toContain("run-1.json");
    expect(left.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(loadRun(dir, "run-1").items.length).toBe(1);
  });

  it("listRuns skips a corrupt/partial run file instead of throwing", () => {
    saveRun(dir, createRun("run-2", env, plan, "2026-01-02T00:00:00Z"));
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{ this is not json", "utf-8");
    const runs = listRuns(dir);
    expect(runs.map((r) => r.id)).toEqual(["run-2"]);
  });
});
