import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveStore, resolveImportKeyMap, KeyRemapRecord } from "../src/shared/keymap";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "km-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const rec = (o: Partial<KeyRemapRecord>): KeyRemapRecord => ({
  sourceTenant: "S", targetTenant: "T", fileId: "f1",
  sourceUrl: "https://s/a.png", targetUrl: "https://t/a.png", updatedAt: null, ...o,
});

describe("resolveImportKeyMap", () => {
  it("reads the store slice for the tenant pair", () => {
    saveStore(dir, [
      rec({ sourceUrl: "https://s/a.png", targetUrl: "https://t/a.png" }),
      rec({ targetTenant: "OTHER", sourceUrl: "https://s/x.png", targetUrl: "https://other/x.png" }),
    ]);
    const map = resolveImportKeyMap({ keymapDir: dir, sourceTenant: "S", targetTenant: "T" });
    expect(map).toEqual({ "https://s/a.png": "https://t/a.png" });
  });

  it("merges an explicit --key-map file on top of the store", () => {
    saveStore(dir, [rec({ sourceUrl: "https://s/a.png", targetUrl: "https://t/store.png" })]);
    const explicit = path.join(dir, "explicit.json");
    fs.writeFileSync(explicit, JSON.stringify({ "https://s/a.png": "https://t/explicit.png", "https://s/b.png": "https://t/b.png" }));
    const map = resolveImportKeyMap({ keymapDir: dir, sourceTenant: "S", targetTenant: "T", explicitFile: explicit });
    expect(map["https://s/a.png"]).toBe("https://t/explicit.png"); // explicit wins
    expect(map["https://s/b.png"]).toBe("https://t/b.png");
  });
});
