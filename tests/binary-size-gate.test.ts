import { describe, it, expect } from "vitest";
import { parseMaxBytes, isWithinSizeLimit, formatBytes } from "../src/shared/binary";

describe("size gate", () => {
  it("parses MB to bytes; blank/zero means no limit", () => {
    expect(parseMaxBytes(100)).toBe(100 * 1024 * 1024);
    expect(parseMaxBytes("50")).toBe(50 * 1024 * 1024);
    expect(parseMaxBytes(0)).toBe(0);
    expect(parseMaxBytes(undefined)).toBe(0);
    expect(parseMaxBytes("garbage")).toBe(0);
  });

  it("no limit (0) always passes", () => {
    expect(isWithinSizeLimit(999_999_999, 0)).toBe(true);
  });

  it("enforces ceiling inclusively", () => {
    const max = parseMaxBytes(10); // 10 MB
    expect(isWithinSizeLimit(10 * 1024 * 1024, max)).toBe(true);
    expect(isWithinSizeLimit(10 * 1024 * 1024 + 1, max)).toBe(false);
  });

  it("formats bytes", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });
});
