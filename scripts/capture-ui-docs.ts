/**
 * Capture README UI screenshots with mock tenant ids (no real CMS calls).
 *
 *   npx ts-node -r ./register-shared.js scripts/capture-ui-docs.ts
 *
 * Expects the UI at CAPTURE_URL (default http://127.0.0.1:4318).
 */
import fs from "fs";
import path from "path";
import { chromium, type Page } from "@playwright/test";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "images", "ui");
const BASE = process.env["CAPTURE_URL"] || "http://127.0.0.1:4318";

const MOCK_ENV = {
  source: { url: "https://cms-api.example.test/cms/manage/en-US", tenant: "1000XXX" },
  target: { url: "https://cms-api.example.test/cms/manage/en-US", tenant: "1000YYY" },
};

const MOCK_CATALOG = {
  environment: { role: "source", tenant: "1000XXX", locale: "en-US" },
  generatedAt: new Date().toISOString(),
  sections: [
    {
      type: "model",
      total: 2,
      items: [
        { type: "model", id: "HeroBanner", label: "HeroBanner", dependsOn: [] },
        { type: "model", id: "PromoBanner", label: "PromoBanner", dependsOn: [] },
      ],
    },
    {
      type: "file",
      total: 2,
      items: [
        {
          type: "file",
          id: "https://cdn.example.test/files/demo/hero.png",
          label: "hero.png",
          dependsOn: [],
          metadata: { key: "demo/hero.png", folder: "/Banners" },
        },
        {
          type: "file",
          id: "https://cdn.example.test/files/demo/promo.jpg",
          label: "promo.jpg",
          dependsOn: [],
          metadata: { key: "demo/promo.jpg", folder: "/Banners" },
        },
      ],
    },
    {
      type: "cms-entry",
      total: 2,
      items: [
        {
          type: "cms-entry",
          id: "entry-demo-001",
          label: "Summer Hero",
          dependsOn: ["HeroBanner", "https://cdn.example.test/files/demo/hero.png"],
          metadata: { modelId: "HeroBanner", folder: "/Campaigns" },
        },
        {
          type: "cms-entry",
          id: "entry-demo-002",
          label: "Promo Strip",
          dependsOn: ["PromoBanner"],
          metadata: { modelId: "PromoBanner", folder: "/Campaigns" },
        },
      ],
    },
    {
      type: "page",
      total: 2,
      items: [
        {
          type: "page",
          id: "/home",
          label: "Home",
          dependsOn: ["https://cdn.example.test/files/demo/hero.png"],
          metadata: { path: "/home", folder: "/Site" },
        },
        {
          type: "page",
          id: "/checkout",
          label: "Checkout",
          dependsOn: [],
          metadata: { path: "/checkout", folder: "/Site" },
        },
      ],
    },
    {
      type: "redirect",
      total: 1,
      items: [
        {
          type: "redirect",
          id: "https://shop.example.test/old",
          label: "/old → /home",
          dependsOn: [],
        },
      ],
    },
  ],
};

async function shot(page: Page, name: string): Promise<void> {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log("  wrote", path.relative(ROOT, file));
}

async function go(page: Page, view: string): Promise<void> {
  await page.locator(`.navi[data-v="${view}"]`).click();
  await page.locator(`#v-${view}`).waitFor({ state: "visible" });
  await page.waitForTimeout(250);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });

  await page.route("**/api/env", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_ENV),
    });
  });

  await page.route("**/api/catalog/build", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_CATALOG),
    });
  });

  await page.route("**/api/catalog", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_CATALOG),
    });
  });

  await page.route("**/api/exports", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          dir: "export/exp-1000XXX-20260810-120000",
          mtime: new Date().toISOString(),
          types: ["files", "cms", "pages", "redirects"],
        },
      ]),
    });
  });

  await page.route("**/api/import/contents**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sections: MOCK_CATALOG.sections }),
    });
  });

  // Mock logs/runs so docs never show real tenant history from the local machine.
  await page.route("**/api/logs", async (route) => {
    if (route.request().url().match(/\/api\/logs\/[^/]+\/[^/]+/)) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          runId: "migrate-2026-08-10T12-00-00-000Z",
          workstream: "migrate",
          status: "done",
          startedAt: "2026-08-10T12:00:00.000Z",
          endedAt: "2026-08-10T12:05:00.000Z",
          sourceTenant: "1000XXX",
          targetTenant: "1000YYY",
          argsSummary: "migrate --select @ids.txt",
        },
        {
          runId: "export-2026-08-10T11-30-00-000Z",
          workstream: "export",
          status: "done",
          startedAt: "2026-08-10T11:30:00.000Z",
          endedAt: "2026-08-10T11:32:00.000Z",
          sourceTenant: "1000XXX",
          targetTenant: null,
          argsSummary: "export-selected",
        },
        {
          runId: "import-2026-08-10T11-40-00-000Z",
          workstream: "import",
          status: "done",
          startedAt: "2026-08-10T11:40:00.000Z",
          endedAt: "2026-08-10T11:48:00.000Z",
          sourceTenant: "1000XXX",
          targetTenant: "1000YYY",
          argsSummary: "import-all --dry-run",
        },
      ]),
    });
  });

  await page.route("**/api/runs", async (route) => {
    if (route.request().url().match(/\/api\/runs\/[^/]+/)) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "migrate-2026-08-10T12-00-00-000Z",
          status: "complete",
          createdAt: "2026-08-10T12:00:00.000Z",
          environment: { tenant: "1000YYY", role: "source" },
          summary: { done: 40, error: 0, skipped: 1, pending: 0 },
        },
      ]),
    });
  });

  await page.route("**/api/metrics", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: 1, items: 41, failedRuns: 0 }),
    });
  });

  console.log("Capturing from", BASE);
  await page.goto(BASE, { waitUntil: "networkidle" });
  // Prefer light theme for docs
  const theme = await page.locator("html").getAttribute("data-theme");
  if (theme === "dark") await page.locator("#theme").click();
  await page.waitForTimeout(200);

  // Ensure mock tenants are visible even if /api/env raced
  await page.locator("#exTenant").fill(MOCK_ENV.source.tenant);
  await page.locator("#exSrcUrl").evaluate((el, url) => { el.textContent = url as string; }, MOCK_ENV.source.url);

  // 1) Export — discover
  await go(page, "export");
  await shot(page, "01-export-discover");

  // 2) Export — after catalog load (select stage)
  await page.locator("#exLoad").click();
  await page.locator("#exSelect").waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, "02-export-select");

  // 3) Import — source picker with mock export card
  await go(page, "import");
  await page.waitForTimeout(400);
  await shot(page, "03-import-source");
  const card = page.locator(".excard").first();
  if (await card.count()) {
    await card.click();
    await page.locator("#imNext1").click();
    await page.locator("#imStep2").waitFor({ state: "visible" });
    await page.locator("#imTenant").fill(MOCK_ENV.target.tenant);
    await page.locator("#imTgtUrl").evaluate((el, url) => { el.textContent = url as string; }, MOCK_ENV.target.url);
    await page.waitForTimeout(200);
    await shot(page, "03b-import-target");
  }

  // 4) Migrate discover
  await go(page, "copy");
  await page.locator("#cpSrc").fill(MOCK_ENV.source.tenant);
  await page.locator("#cpTgt").fill(MOCK_ENV.target.tenant);
  await shot(page, "04-migrate-discover");

  // Load catalog for select view
  await page.locator("#cpLoad").click();
  await page.waitForTimeout(700);
  await shot(page, "05-migrate-select");

  // 5) Purge
  await go(page, "purge");
  await page.locator("#pgTenant").fill(MOCK_ENV.target.tenant);
  await page.locator("#pgTgtUrl").evaluate((el, url) => { el.textContent = url as string; }, MOCK_ENV.target.url);
  await shot(page, "06-purge");

  // 6) Logs
  await go(page, "logs");
  await page.waitForTimeout(400);
  await shot(page, "07-logs");

  await browser.close();
  console.log("Done →", path.relative(ROOT, OUT));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
