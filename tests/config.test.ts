import { describe, it, expect } from "vitest";
import { envInt } from "../shared/src/config";

describe("envInt", () => {
  it("honors an explicit 0 (not treated as falsy)", () => {
    process.env.__ENVINT_TEST = "0";
    expect(envInt("__ENVINT_TEST", 5)).toBe(0);
  });

  it("falls back when unset or non-numeric", () => {
    delete process.env.__ENVINT_TEST;
    expect(envInt("__ENVINT_TEST", 5)).toBe(5);
    process.env.__ENVINT_TEST = "abc";
    expect(envInt("__ENVINT_TEST", 5)).toBe(5);
  });

  it("parses a normal integer", () => {
    process.env.__ENVINT_TEST = "200";
    expect(envInt("__ENVINT_TEST", 5)).toBe(200);
  });
});
