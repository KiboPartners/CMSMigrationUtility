import { describe, it, expect, afterEach } from "vitest";
import { assertPurgeTargetSafe, purgeWarning } from "../src/shared/config";

const save = { s: process.env["SOURCE_TENANT"], t: process.env["TARGET_TENANT"] };
afterEach(() => {
  process.env["SOURCE_TENANT"] = save.s;
  process.env["TARGET_TENANT"] = save.t;
});

describe("assertPurgeTargetSafe", () => {
  it("throws when target == source", () => {
    process.env["SOURCE_TENANT"] = "1000502";
    process.env["TARGET_TENANT"] = "1000502";
    expect(() => assertPurgeTargetSafe()).toThrow(/same as SOURCE_TENANT/);
  });

  it("allows target == source when explicitly overridden", () => {
    process.env["SOURCE_TENANT"] = "1000502";
    process.env["TARGET_TENANT"] = "1000502";
    expect(() => assertPurgeTargetSafe(true)).not.toThrow();
  });

  it("allows distinct tenants", () => {
    process.env["SOURCE_TENANT"] = "1000502";
    process.env["TARGET_TENANT"] = "1000588";
    expect(() => assertPurgeTargetSafe()).not.toThrow();
  });
});

describe("purgeWarning", () => {
  it("names the artifact, tenant, note, and the --force instruction", () => {
    const w = purgeWarning("redirects on the target", "1000588", "Permanently deleted.");
    expect(w).toContain("redirects on the target");
    expect(w).toContain("1000588");
    expect(w).toContain("Permanently deleted.");
    expect(w).toContain("--force");
  });
});
