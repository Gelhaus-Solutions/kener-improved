import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_SECONDS,
  GetInstanceRole,
  IsStandby,
  ParseInstanceRole,
  ParseStaleSeconds,
  StandbyPrimaryUrl,
  StandbyToken,
} from "./config.js";

const KEYS = ["KENER_ROLE", "KENER_STANDBY_TOKEN", "KENER_STANDBY_PRIMARY_URL", "KENER_STANDBY_STALE_SECONDS"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("ParseInstanceRole", () => {
  it("defaults to primary when unset or empty, so an install that sets nothing is unchanged", () => {
    expect(ParseInstanceRole(undefined)).toBe("primary");
    expect(ParseInstanceRole("")).toBe("primary");
    expect(ParseInstanceRole("  ")).toBe("primary");
  });

  it("reads both roles, case and spacing aside", () => {
    expect(ParseInstanceRole("primary")).toBe("primary");
    expect(ParseInstanceRole("standby")).toBe("standby");
    expect(ParseInstanceRole(" Standby ")).toBe("standby");
  });

  it("refuses anything else rather than running as a primary by accident", () => {
    expect(() => ParseInstanceRole("standy")).toThrow(/KENER_ROLE/);
    expect(() => ParseInstanceRole("replica")).toThrow(/KENER_ROLE/);
  });
});

describe("the environment", () => {
  it("is primary with KENER_ROLE unset", () => {
    delete process.env.KENER_ROLE;
    expect(GetInstanceRole()).toBe("primary");
    expect(IsStandby()).toBe(false);
  });

  it("is a standby with KENER_ROLE=standby", () => {
    process.env.KENER_ROLE = "standby";
    expect(IsStandby()).toBe(true);
  });

  it("treats an empty token as no token and trims the primary URL's trailing slash", () => {
    process.env.KENER_STANDBY_TOKEN = "  ";
    expect(StandbyToken()).toBeNull();
    process.env.KENER_STANDBY_TOKEN = "s3cret";
    expect(StandbyToken()).toBe("s3cret");
    process.env.KENER_STANDBY_PRIMARY_URL = "https://status.example.com/status/";
    expect(StandbyPrimaryUrl()).toBe("https://status.example.com/status");
    delete process.env.KENER_STANDBY_PRIMARY_URL;
    expect(StandbyPrimaryUrl()).toBeNull();
  });
});

describe("ParseStaleSeconds", () => {
  it("defaults to five minutes", () => {
    expect(DEFAULT_STALE_SECONDS).toBe(300);
    expect(ParseStaleSeconds(undefined)).toBe(300);
    expect(ParseStaleSeconds("")).toBe(300);
  });

  it("takes a positive whole number of seconds and ignores anything else", () => {
    expect(ParseStaleSeconds("120")).toBe(120);
    expect(ParseStaleSeconds("0")).toBe(300);
    expect(ParseStaleSeconds("-5")).toBe(300);
    expect(ParseStaleSeconds("1.5")).toBe(300);
    expect(ParseStaleSeconds("five")).toBe(300);
  });
});
