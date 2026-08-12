import { describe, it, expect } from "vitest";
import { binaryResultItems } from "../src/artifacts/file-manager/clone";

const files = [
  { id: "a", key: "a.png", src: "http://x/a.png" },
  { id: "b", key: "b.png", src: "http://x/b.png" },
  { id: "c", key: "c.png", src: "http://x/c.png" },
  { id: "d", key: "d.png", src: "http://x/d.png" },
] as never[];

describe("binaryResultItems", () => {
  it("maps each outcome to the right ledger status/action", () => {
    const items = binaryResultItems(
      files,
      new Map([["b.png", "boom"]]),       // b errored
      new Set(["c.png"]),                  // c skipped-large
      new Set(["a.png"])                   // a uploaded
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId["http://x/a.png"]).toMatchObject({ status: "done", action: "uploaded" });
    expect(byId["http://x/b.png"]).toMatchObject({ status: "error", error: "boom" });
    expect(byId["http://x/c.png"]).toMatchObject({ status: "skipped", action: "skipped-large" });
    expect(byId["http://x/d.png"]).toMatchObject({ status: "done", action: "registered" });
  });

  it("maps skipped-existing and folder-moved truthfully", () => {
    const items = binaryResultItems(
      files,
      new Map(),                 // no errors
      new Set(),                 // no skipped-large
      new Set(),                 // no uploaded
      new Set(["a.png"]),        // a skipped (exists)
      new Set(["b.png"])         // b folder-moved
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId["http://x/a.png"]).toMatchObject({ status: "skipped", action: "exists" });
    expect(byId["http://x/b.png"]).toMatchObject({ status: "done", action: "folder-moved" });
    expect(byId["http://x/c.png"]).toMatchObject({ status: "done", action: "registered" });
  });

  it("maps missing-source binary to skipped/no-source-binary (and it wins over exists)", () => {
    const items = binaryResultItems(
      files,
      new Map(),
      new Set(),
      new Set(),
      new Set(["a.png"]),        // a also in skippedKeys...
      new Set(),
      new Set(["a.png"])         // ...but missing-source takes precedence
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId["http://x/a.png"]).toMatchObject({ status: "skipped", action: "no-source-binary" });
  });
});
