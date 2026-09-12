import { describe, it, expect } from "vitest";

// The action module pulls in the db singleton, which the validator does not
// touch. Stubbed so this stays a unit test of the parsing alone.
import { vi } from "vitest";
vi.mock("$lib/server/db/db.js", () => ({ default: {} }));
vi.mock("$lib/server/probes/auth.js", () => ({
  generateProbeToken: () => "t",
  hashProbeToken: () => "h",
  tokenHintOf: () => "hint",
}));
vi.mock("$lib/server/db/regions.js", () => ({ normalizeRegionCode: (v: string) => v }));

const { parseWeight } = await import("./createProbeAgent.js");

describe("parseWeight", () => {
  it("defaults to 1 when the operator said nothing", () => {
    // B1g's whole upgrade story: an unconfigured fleet keeps B1f's behaviour.
    expect(parseWeight(undefined)).toBe(1);
    expect(parseWeight(null)).toBe(1);
    expect(parseWeight("")).toBe(1);
  });

  it("accepts a whole number", () => {
    expect(parseWeight(3)).toBe(3);
    expect(parseWeight("7")).toBe(7);
  });

  it("accepts zero, which means recorded but no vote", () => {
    // Not the same as absent: absent is 1.
    expect(parseWeight(0)).toBe(0);
    expect(parseWeight("0")).toBe(0);
  });

  it("has no upper bound, because a large weight is a deliberate statement", () => {
    expect(parseWeight(9999)).toBe(9999);
  });

  it("refuses a negative weight", () => {
    expect(() => parseWeight(-1)).toThrow(/0 or more/);
  });

  it("refuses a fraction, since only relative size is used", () => {
    expect(() => parseWeight(1.5)).toThrow(/whole number/);
  });

  it("refuses something that is not a number at all", () => {
    expect(() => parseWeight("heavy")).toThrow(/whole number/);
    expect(() => parseWeight({})).toThrow(/whole number/);
  });

  it("refuses infinity rather than letting it win every tally", () => {
    expect(() => parseWeight(Number.POSITIVE_INFINITY)).toThrow(/whole number/);
  });
});
