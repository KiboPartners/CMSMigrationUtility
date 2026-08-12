import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRun, saveRun, loadRun, loadRunWithFallback, listRuns } from "../src/shared/runstore";
import type { MigrationPlan } from "../src/shared/plan";

const dir = path.join(os.tmpdir(), `kibo-runstore-test-${process.pid}`);
const legacy = path.join(os.tmpdir(), `kibo-runstore-legacy-${process.pid}`);
const env = { role: "source", tenant: "t", locale: "en-US" };
const plan: MigrationPlan = { steps: [{ type: "cms-entry", ids: ["e1"] }], selectedCount: 1, resolvedCount: 1, addedByDependencies: [], unknownIds: [] };

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(legacy, { recursive: true, force: true });
});

describe("runstore fs durability", () => {
  it("saves nested ledger.json atomically and round-trips", () => {
    saveRun(dir, createRun("run-1", env, plan, "2026-01-01T00:00:00Z"));
    expect(fs.existsSync(path.join(dir, "run-1", "ledger.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "run-1", "ledger.json.tmp"))).toBe(false);
    expect(loadRun(dir, "run-1").items.length).toBe(1);
  });

  it("listRuns skips a corrupt nested ledger instead of throwing", () => {
    saveRun(dir, createRun("run-2", env, plan, "2026-01-02T00:00:00Z"));
    fs.mkdirSync(path.join(dir, "corrupt"), { recursive: true });
    fs.writeFileSync(path.join(dir, "corrupt", "ledger.json"), "{ this is not json", "utf-8");
    const runs = listRuns(dir);
    expect(runs.map((r) => r.id)).toEqual(["run-2"]);
  });

  it("reads legacy flat .runs/<id>.json and merges via fallback", () => {
    fs.mkdirSync(legacy, { recursive: true });
    const run = createRun("run-legacy", env, plan, "2026-01-03T00:00:00Z");
    fs.writeFileSync(path.join(legacy, "run-legacy.json"), JSON.stringify(run), "utf-8");
    expect(loadRunWithFallback(dir, "run-legacy", [legacy]).id).toBe("run-legacy");
    expect(listRuns(dir, [legacy]).map((r) => r.id)).toContain("run-legacy");
  });
});
