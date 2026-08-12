import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  enableArtifactFilter,
  goWorkspace,
  openFilters,
  openMigrateAdvanced,
  selectOnlyChip,
  waitForJob,
  waitMigrateUiDone,
} from "./helpers";

const ROOT = path.resolve(__dirname, "..");
const KEYMAP_STORE = path.join(ROOT, ".keymap", "store.json");
/** Prefer a tiny binary so stream/keymap e2e stays bounded. */
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

type CatalogItem = {
  type: string;
  id: string;
  label?: string;
  metadata?: { size?: number | null; fmId?: string; key?: string };
};
type Catalog = {
  sections?: Array<{ type: string; items?: CatalogItem[] }>;
};
type Ledger = {
  id: string;
  status: string;
  items: Array<{ type: string; id: string; status: string; attempts: number; error?: string | null }>;
};
type KeyRemap = {
  sourceTenant: string;
  targetTenant: string;
  fileId: string;
  sourceUrl: string;
  targetUrl: string;
  targetKey?: string;
};

async function envTenants(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get("/api/env");
  expect(res.ok()).toBeTruthy();
  const env = (await res.json()) as {
    source: { tenant: string };
    target: { tenant: string };
  };
  return { sourceTenant: env.source.tenant, targetTenant: env.target.tenant };
}

function pickSmallestFile(cat: Catalog, maxBytes: number): CatalogItem | null {
  const files = (cat.sections || []).find((s) => s.type === "file")?.items || [];
  const sized = files
    .filter((f) => typeof f.metadata?.size === "number" && (f.metadata.size as number) > 0 && (f.metadata.size as number) <= maxBytes)
    .sort((a, b) => (a.metadata!.size as number) - (b.metadata!.size as number));
  return sized[0] || null;
}

function ledgerPath(runId: string): string {
  return path.join(ROOT, ".logs", "migrate", runId, "ledger.json");
}

/** Load files catalog (last_30d), pick one small file, migrate live with folder mismatch allowed. */
async function liveMigrateOneSmallFile(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext
): Promise<{ jobId: string; file: CatalogItem }> {
  await page.goto("/");
  await goWorkspace(page, "copy");
  await selectOnlyChip(page.locator("#cpTypes"), "file-manager");
  await openFilters(page, "cp");
  await enableArtifactFilter(page, "cp", "file");
  await page.locator("#cpDatePreset-file").selectOption("last_30d");

  const catalogResp = page.waitForResponse(
    (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
  );
  await page.locator("#cpLoad").click();
  const catRes = await catalogResp;
  const cat = (await catRes.json()) as Catalog & { error?: string };
  test.skip(!catRes.ok() || !!cat.error, cat.error || "catalog failed");

  const file = pickSmallestFile(cat, MAX_STREAM_BYTES);
  test.skip(!file, `No file ≤ ${MAX_STREAM_BYTES} bytes in last_30d catalog`);

  await expect(page.locator("#cpSelect")).toBeVisible({ timeout: 60_000 });
  const rows = page.locator("#cpCatalog .trow");
  const n = await rows.count();
  test.skip(n === 0, "No file rows");
  let checked = false;
  for (let i = 0; i < n; i++) {
    const id = await rows.nth(i).getAttribute("data-id");
    if (id === file!.id) {
      await rows.nth(i).locator(".cb2").check();
      checked = true;
      break;
    }
  }
  if (!checked) await rows.first().locator(".cb2").check();

  await page.locator("#cpDry").uncheck();
  await openMigrateAdvanced(page);
  await page.locator("#cpFolder").check();
  const sizeMb = Math.max(1, Math.ceil(((file!.metadata!.size as number) + 1) / (1024 * 1024)));
  await page.locator("#cpMaxMb").fill(String(sizeMb));

  const migResp = page.waitForResponse(
    (r) => r.url().includes("/api/migrate") && r.request().method() === "POST"
  );
  await page.locator("#cpGo").click();
  const migBody = await (await migResp).json();
  expect(migBody.error || "").toBeFalsy();
  expect(migBody.dryRun).toBeFalsy();
  expect(migBody.jobId).toBeTruthy();

  const job = await waitForJob(request, migBody.jobId, 15 * 60 * 1000);
  expect(job.status, job.error || "file migrate job").not.toBe("error");
  await waitMigrateUiDone(page);

  return { jobId: migBody.jobId as string, file: file! };
}

test.describe("Live migrate, binary stream/keymap, resume", () => {
  test("live migrate one small file (non–dry-run) + keymap store", async ({ page, request }) => {
    const { sourceTenant, targetTenant } = await envTenants(request);

    const beforeStore = fs.existsSync(KEYMAP_STORE)
      ? (JSON.parse(fs.readFileSync(KEYMAP_STORE, "utf-8")) as KeyRemap[])
      : [];
    const beforeCount = beforeStore.filter(
      (r) => r.sourceTenant === sourceTenant && r.targetTenant === targetTenant
    ).length;

    const { jobId } = await liveMigrateOneSmallFile(page, request);

    const ledgerRes = await request.get(`/api/runs/${encodeURIComponent(jobId)}`);
    expect(ledgerRes.ok()).toBeTruthy();
    const ledger = (await ledgerRes.json()) as Ledger;
    expect(ledger.id).toBe(jobId);
    const fileItems = ledger.items.filter((i) => i.type === "file");
    expect(fileItems.length).toBeGreaterThan(0);
    const okFile = fileItems.find((i) => i.status === "done" || i.status === "skipped");
    expect(
      okFile,
      fileItems.map((i) => `${i.status}: ${i.error || ""}`).join(" | ") || "no file items"
    ).toBeTruthy();

    expect(fs.existsSync(KEYMAP_STORE)).toBeTruthy();
    const afterStore = JSON.parse(fs.readFileSync(KEYMAP_STORE, "utf-8")) as KeyRemap[];
    const pair = afterStore.filter(
      (r) => r.sourceTenant === sourceTenant && r.targetTenant === targetTenant
    );
    expect(pair.length >= beforeCount).toBeTruthy();

    const out = await page.locator("#cpOut").textContent();
    expect(out || "").toMatch(/Import|file|key-map|Progress|registered|uploaded|stream/i);
  });

  test("resume re-runs errored ledger item after live file migrate", async ({ page, request }) => {
    const { sourceTenant, targetTenant } = await envTenants(request);
    // Source tenant has 0 redirects — use files for the live+resume path
    const { jobId: runId } = await liveMigrateOneSmallFile(page, request);

    const lp = ledgerPath(runId);
    expect(fs.existsSync(lp)).toBeTruthy();
    const ledger = JSON.parse(fs.readFileSync(lp, "utf-8")) as Ledger;
    const target = ledger.items.find((i) => i.type === "file" && (i.status === "done" || i.status === "skipped"));
    test.skip(!target, "No done/skipped file to force-error for resume");

    const attemptsBefore = target!.attempts;
    target!.status = "error";
    target!.error = "e2e forced failure for resume";
    ledger.status = "failed";
    fs.writeFileSync(lp, JSON.stringify(ledger, null, 2), "utf-8");

    // Successful runs delete auto-staging — resume re-exports. Keep folder mismatch.
    const resumeRes = await request.post("/api/migrate", {
      data: {
        resume: runId,
        sourceTenant,
        targetTenant,
        dryRun: false,
        allowFolderMismatch: true,
      },
    });
    expect(resumeRes.ok(), await resumeRes.text()).toBeTruthy();
    const resumeBody = (await resumeRes.json()) as { jobId: string; error?: string };
    expect(resumeBody.error || "").toBeFalsy();
    expect(resumeBody.jobId).toBeTruthy();
    expect(resumeBody.jobId).not.toBe(runId);

    const job2 = await waitForJob(request, resumeBody.jobId, 15 * 60 * 1000);
    expect(job2.status, job2.error || "resume").not.toBe("error");

    const afterRes = await request.get(`/api/runs/${encodeURIComponent(runId)}`);
    expect(afterRes.ok()).toBeTruthy();
    const after = (await afterRes.json()) as Ledger;
    const item = after.items.find((i) => i.type === target!.type && i.id === target!.id);
    expect(item).toBeTruthy();
    expect(["done", "skipped"]).toContain(item!.status);
    expect(item!.attempts).toBeGreaterThan(attemptsBefore);
  });

  test("export files → import streamBinaries dry-run (API flag)", async ({ request }) => {
    const { sourceTenant, targetTenant } = await envTenants(request);

    // Pure API — avoid UI name-filter residual scans that can hang the Export workspace
    const exportRes = await request.post("/api/export", {
      data: {
        sourceTenant,
        types: ["file-manager"],
        filters: {
          timezone: "UTC",
          fields: [],
          date: { field: "createdOn", mode: "relative", preset: "last_30d" },
        },
      },
    });
    expect(exportRes.ok(), await exportRes.text()).toBeTruthy();
    const expBody = (await exportRes.json()) as { jobId: string; dir: string; error?: string };
    expect(expBody.error || "").toBeFalsy();
    expect(expBody.jobId).toBeTruthy();
    expect(expBody.dir).toBeTruthy();

    const expJob = await waitForJob(request, expBody.jobId, 10 * 60 * 1000);
    expect(expJob.status, expJob.error).toBe("done");

    const contentsRes = await request.get(
      `/api/import/contents?dir=${encodeURIComponent(expBody.dir)}`
    );
    expect(contentsRes.ok()).toBeTruthy();
    const contents = (await contentsRes.json()) as {
      sections?: Array<{ type: string; items?: Array<{ id: string }> }>;
    };
    const fileId = (contents.sections || []).find((s) => s.type === "file")?.items?.[0]?.id;
    test.skip(!fileId, "Export has no file items");

    const streamRes = await request.post("/api/import", {
      data: {
        dir: expBody.dir,
        targetTenant,
        dryRun: true,
        streamBinaries: true,
        allowFolderMismatch: true,
        selectedIds: [fileId],
      },
    });
    expect(streamRes.ok(), await streamRes.text()).toBeTruthy();
    const { jobId } = (await streamRes.json()) as { jobId: string };
    const job = await waitForJob(request, jobId, 10 * 60 * 1000);
    expect(job.status, job.error).toBe("done");
  });
});
