import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env["E2E_BASE_URL"] || "http://localhost:4317";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  timeout: 10 * 60 * 1000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  outputDir: "e2e-results",
  // Start the Express UI when nothing is already listening (reuse local `npm run serve`).
  webServer: process.env["E2E_BASE_URL"]
    ? undefined
    : {
        command: "npm run serve -- --port 4317",
        url: baseURL,
        reuseExistingServer: !process.env["CI"],
        timeout: 120_000,
      },
});
