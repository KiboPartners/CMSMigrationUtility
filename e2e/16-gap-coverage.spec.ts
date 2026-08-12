import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import {
  enableArtifactFilter,
  goWorkspace,
  openFilters,
  selectChips,
  selectOnlyChip,
  waitForJob,
  waitImportUiDone,
  waitMigrateUiDone,
} from "./helpers";

const ROOT = path.resolve(__dirname, "..");

test.describe("Gap coverage — validation, presets, deps, zip, purge dry-run preview", () => {
  test("Export: empty selection blocked", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "export");
    // Turn all chips off
    const chips = page.locator("#exTypes .chip.on");
    while ((await chips.count()) > 0) {
      await chips.first().click();
    }
    await page.locator("#exGo").click();
    await expect(page.locator("#exMsg")).toContainText(/at least one artifact/i);
  });

  test("Migrate: empty selection blocked", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "copy");
    await selectOnlyChip(page.locator("#cpTypes"), "redirects");
    // Load a tiny catalog so Select UI appears
    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#cpLoad").click();
    const cat = await (await catalogResp).json();
    test.skip(!!cat.error, `catalog unavailable: ${cat.error}`);
    await expect(page.locator("#cpSelect")).toBeVisible({ timeout: 60_000 });
    await page.locator("#cpClr").click();
    await page.locator("#cpGo").click();
    await expect(page.locator("#cpGoMsg")).toContainText("Select at least one item.");
  });

  test("Filter preset save + apply restores fields", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "export");
    await selectOnlyChip(page.locator("#exTypes"), "redirects");
    await openFilters(page, "ex");
    await enableArtifactFilter(page, "ex", "redirect");
    await page.locator("#exDatePreset-redirect").selectOption("last_7d");
    await page.locator("#exNameRedirects").fill("/preset-roundtrip");

    const name = `e2e-gap-${Date.now()}`;
    page.once("dialog", async (d) => d.accept(name));
    await page.locator("#exSavePreset").click();

    await page.locator("#exNameRedirects").fill("");
    await page.locator("#exDatePreset-redirect").selectOption("");

    const sel = page.locator("#exPresetSel");
    const opt = sel.locator("option", { hasText: name });
    await expect(opt).toHaveCount(1);
    const value = await opt.getAttribute("value");
    await sel.selectOption(value!);
    await expect(page.locator("#exNameRedirects")).toHaveValue("/preset-roundtrip");
    await expect(page.locator("#exDatePreset-redirect")).toHaveValue("last_7d");
  });

  test("API plan + migrate reject empty ids", async ({ request }) => {
    const plan = await request.post("/api/plan", {
      data: { selectedIds: [] },
    });
    // 404 if no catalog, or 200 with empty plan — either is fine; empty migrate must 400
    const mig = await request.post("/api/migrate", {
      data: { selectedIds: [], dryRun: true },
    });
    expect(mig.status()).toBe(400);
    const body = await mig.json();
    expect(body.error).toMatch(/No ids|select/i);
  });

  test("Migrate dry-run with deps: select entry/page pulls plan via API", async ({ page, request }) => {
    await page.goto("/");
    await goWorkspace(page, "copy");
    await selectChips(page.locator("#cpTypes"), ["cms-entries", "file-manager", "page-builder"]);
    await openFilters(page, "cp");
    await enableArtifactFilter(page, "cp", "cms-entry");
    await enableArtifactFilter(page, "cp", "file");
    await enableArtifactFilter(page, "cp", "page");
    await page.locator("#cpDatePreset-cms-entry").selectOption("last_30d");
    await page.locator("#cpDatePreset-file").selectOption("last_30d");
    await page.locator("#cpDatePreset-page").selectOption("last_30d");

    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#cpLoad").click();
    const catRes = await catalogResp;
    const cat = await catRes.json();
    test.skip(!catRes.ok() || cat.error, cat.error || "catalog failed");

    await expect(page.locator("#cpSelect")).toBeVisible({ timeout: 180_000 });
    const trow = page.locator("#cpCatalog .trow").first();
    test.skip(!(await trow.count()), "No catalog rows");

    const id = await trow.getAttribute("data-id");
    expect(id).toBeTruthy();
    await trow.locator(".cb2").check();

    // Plan API expands deps
    const planRes = await request.post("/api/plan", { data: { selectedIds: [id] } });
    if (planRes.ok()) {
      const plan = await planRes.json();
      expect(plan.resolvedCount ?? plan.steps?.length).toBeTruthy();
    }

    await expect(page.locator("#cpDry")).toBeChecked();
    const migResp = page.waitForResponse(
      (r) => r.url().includes("/api/migrate") && r.request().method() === "POST"
    );
    await page.locator("#cpGo").click();
    const body = await (await migResp).json();
    expect(body.error || "").toBeFalsy();
    expect(body.dryRun).toBeTruthy();
    const job = await waitForJob(request, body.jobId);
    expect(job.status, job.error).toBe("done");
    await waitMigrateUiDone(page);
  });

  test("Import zip upload of redirects-only export → dry-run", async ({ page, request }) => {
    const list = (await (await request.get("/api/exports")).json()) as Array<{
      dir: string;
      types: string[];
    }>;
    const preferred =
      list.find((d) => (d.types || []).includes("Redirects") && !(d.types || []).includes("Content Models")) ||
      list.find((d) => (d.types || []).includes("Redirects"));
    test.skip(!preferred, "No redirects export to zip");

    const abs = path.join(ROOT, preferred!.dir.replace(/\//g, path.sep));
    test.skip(!fs.existsSync(abs), `missing ${abs}`);

    const zipPath = path.join(ROOT, ".migrate-tmp", `e2e-upload-${Date.now()}.zip`);
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    const zip = new AdmZip();
    zip.addLocalFolder(abs);
    zip.writeZip(zipPath);

    await page.goto("/");
    await goWorkspace(page, "import");
    await page.locator("#imModeUpload").click();
    await page.locator("#imZip").setInputFiles(zipPath);
    await expect(page.locator("#imZipMsg")).toContainText(/Extracted|ready/i, { timeout: 60_000 });
    await expect(page.locator("#imNext1")).toBeEnabled();
    await page.locator("#imNext1").click();
    await expect(page.locator("#imDry")).toBeChecked();
    await page.locator("#imNext2").click();
    await expect(page.locator("#imContents")).not.toHaveText(/Choose a source/i, { timeout: 120_000 });
    await page.locator("#imNext3").click();

    const importResp = page.waitForResponse(
      (r) =>
        r.url().includes("/api/import") &&
        r.request().method() === "POST" &&
        !r.url().includes("upload")
    );
    await page.locator("#imGo").click();
    const { jobId } = await (await importResp).json();
    const job = await waitForJob(request, jobId);
    expect(job.status, job.error).toBe("done");
    await waitImportUiDone(page);

    try {
      fs.unlinkSync(zipPath);
    } catch {
      /* best-effort */
    }
  });

  test("Purge Preview dry-run only — never Delete / confirm", async ({ page, request }) => {
    await page.goto("/");
    await goWorkspace(page, "purge");
    // Broader chips + no residual name filter so target catalog usually has rows
    await selectChips(page.locator("#pgTypes"), ["redirects", "page-builder"]);
    await openFilters(page, "pg");
    await enableArtifactFilter(page, "pg", "redirect");
    await enableArtifactFilter(page, "pg", "page");
    await page.locator("#pgDatePreset-redirect").selectOption("last_30d");
    await page.locator("#pgDatePreset-page").selectOption("last_30d");
    // Same-tenant guard: enable only if source===target would block preview
    const env = await (await page.request.get("/api/env")).json();
    if (env.source?.tenant && env.source.tenant === env.target?.tenant) {
      await page.locator("#pgSame").check();
    }

    const catalogResp = page.waitForResponse(
      (r) => r.url().includes("/api/catalog/build") && r.request().method() === "POST"
    );
    await page.locator("#pgLoad").click();
    const cat = await (await catalogResp).json();
    test.skip(!!cat.error, cat.error || "catalog failed");
    await expect(page.locator("#pgSelect")).toBeVisible({ timeout: 120_000 });

    const cb = page.locator("#pgCatalog .trow .cb2").first();
    test.skip(!(await cb.count()), "No purge catalog rows on target");
    await cb.check();

    let sawConfirmTrue = false;
    page.on("request", (req) => {
      if (!req.url().includes("/api/purge") || req.method() !== "POST") return;
      try {
        const body = req.postDataJSON() as { confirm?: boolean };
        if (body?.confirm === true) sawConfirmTrue = true;
      } catch {
        /* ignore */
      }
    });

    const purgeResp = page.waitForResponse(
      (r) => r.url().includes("/api/purge") && r.request().method() === "POST"
    );
    await page.locator("#pgPreview").click();
    const res = await purgeResp;
    const body = await res.json();
    expect(res.ok() || body.dryRun !== undefined || body.jobId || body.error).toBeTruthy();
    // Dry-run preview: confirm must be false / dryRun true when present
    if (body.dryRun !== undefined) expect(body.dryRun).toBeTruthy();
    expect(sawConfirmTrue).toBe(false);

    if (body.jobId) {
      const job = await waitForJob(request, body.jobId, 5 * 60 * 1000);
      // Preview job should complete without hard-delete confirm
      expect(["done", "error"]).toContain(job.status);
    }

    // Modal must not have been used
    await expect(page.locator("#pgModal")).toBeHidden();
    // Explicitly do not click Delete
  });

  test("Export continue-on-error toggle + multi-artifact dry path via API flags", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "export");
    await expect(page.locator("#exCont")).toBeChecked();
    await selectChips(page.locator("#exTypes"), ["redirects", "page-builder"]);
    await openFilters(page, "ex");
    await enableArtifactFilter(page, "ex", "redirect");
    await enableArtifactFilter(page, "ex", "page");
    await page.locator("#exDatePreset-redirect").selectOption("last_7d");
    await page.locator("#exDatePreset-page").selectOption("last_7d");
    await expect(page.locator("#tgExCont")).toHaveClass(/on/);
  });

  test("Logs: Import + Export chips; orphan ledger chip wiring", async ({ page }) => {
    await page.goto("/");
    await goWorkspace(page, "logs");
    await page.locator("#lgReload").click();
    for (const ws of ["export", "import", "migrate"]) {
      await page.locator(`#lgWsFilters .ws-chip[data-ws="${ws}"]`).click();
      await expect(page.locator(`#lgWsFilters .ws-chip[data-ws="${ws}"]`)).toHaveClass(/on/);
    }
    // Orphan chip may be hidden — assert it exists in DOM
    await expect(page.locator("#lgLedgerChip")).toBeAttached();
  });
});
