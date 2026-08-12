import { describe, it, expect } from "vitest";
import { buildCatalog } from "../src/shared/catalog";
import { planMigration } from "../src/shared/plan";
import { rewriteCdnUrls } from "../src/shared/utils";
import { selectUrlMap, KeyRemapRecord } from "../src/shared/keymap";

const FILE_URL = "https://cdn.example.com/files/FID1/pic.png";

const catalog = buildCatalog(
  { role: "source", tenant: "t", locale: "en-US" },
  [
    { type: "file", total: 1, items: [{ id: FILE_URL, type: "file", label: "pic.png", dependsOn: [] }] },
    { type: "page", total: 1, items: [{ id: "PAGE1", type: "page", label: "Home", dependsOn: [FILE_URL] }] },
  ],
  null
);

describe("native file migration", () => {
  it("selecting a page pulls in its referenced file, ordered before the page", () => {
    const plan = planMigration(catalog, ["PAGE1"]);
    const fileStep = plan.steps.find((s) => s.type === "file");
    const pageStep = plan.steps.find((s) => s.type === "page");
    expect(fileStep?.ids).toContain(FILE_URL);
    expect(plan.addedByDependencies).toContain(FILE_URL);
    // file step comes before page step
    expect(plan.steps.indexOf(fileStep!)).toBeLessThan(plan.steps.indexOf(pageStep!));
  });

  it("keymap remap rewrites the page's file URL to the target", () => {
    const records: KeyRemapRecord[] = [{
      sourceTenant: "s", targetTenant: "t", fileId: "FID1",
      sourceUrl: FILE_URL,
      targetUrl: "https://cdn.example.com/files/FID2/pic.png",
      updatedAt: null,
    }];
    const urlMap = selectUrlMap(records, "s", "t");
    const content = { blocks: [{ img: FILE_URL }] };
    const rewritten = rewriteCdnUrls(content, "cdn.example.com", "cdn.example.com", urlMap) as typeof content;
    expect(rewritten.blocks[0].img).toBe("https://cdn.example.com/files/FID2/pic.png");
  });
});
