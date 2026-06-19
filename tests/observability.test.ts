import { describe, it, expect } from "vitest";
import { computeMetrics, aggregateMetrics } from "../shared/src/observability";
import type { MigrationRun } from "../shared/src/runstore";

const run: MigrationRun = {
  id: "r", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:02.000Z",
  environment: { role: "source", tenant: "t", locale: "en-US" }, status: "failed",
  items: [
    { type: "cms-entry", id: "e1", status: "done", attempts: 1, updatedAt: null },
    { type: "cms-entry", id: "e2", status: "error", error: "boom", attempts: 1, updatedAt: null },
  ],
};

describe("computeMetrics", () => {
  it("counts, error rate, duration, throughput", () => {
    const m = computeMetrics(run);
    expect(m.total).toBe(2);
    expect(m.byStatus.done).toBe(1);
    expect(m.byStatus.error).toBe(1);
    expect(m.errorRate).toBe(0.5);
    expect(m.durationMs).toBe(2000);
    expect(m.itemsPerSec).toBe(0.5); // 1 completed / 2s
  });
});

describe("aggregateMetrics", () => {
  it("aggregates across runs with top errors", () => {
    const a = aggregateMetrics([run]);
    expect(a.runs).toBe(1);
    expect(a.failedRuns).toBe(1);
    expect(a.errors).toBe(1);
    expect(a.topErrors[0]).toEqual({ error: "boom", count: 1 });
  });
});
