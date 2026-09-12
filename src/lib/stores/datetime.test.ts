import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { parseDateInput, zoneLabel } from "./datetime";
import { timezone } from "./timezone";

describe("parseDateInput", () => {
  it("treats a naive DB audit-column string as UTC", () => {
    expect(parseDateInput("2026-08-20 04:02:00").toISOString()).toBe("2026-08-20T04:02:00.000Z");
  });

  it("accepts epoch seconds, epoch milliseconds, ISO strings, and Dates", () => {
    const iso = "2026-08-20T04:02:00.000Z";
    expect(parseDateInput(1787198520).toISOString()).toBe(iso);
    expect(parseDateInput(1787198520000).toISOString()).toBe(iso);
    expect(parseDateInput(iso).toISOString()).toBe(iso);
    expect(parseDateInput(new Date(iso)).toISOString()).toBe(iso);
  });
});

/**
 * D5. The label has to name the zone the time is shown in, not the one the
 * process happens to run in. Those are different on the server during SSR and
 * different again for any viewer who is not in the host's zone, which is what
 * made a maintenance window look like it said two different times.
 */
describe("zoneLabel", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  // 2026-01-15T14:00:00Z, in winter so Berlin is +1 rather than +2.
  const WINTER = 1768485600;
  // 2026-07-15T14:00:00Z, when Berlin is +2.
  const SUMMER = 1784124000;

  // The store refuses a zone that is not in `availableTimezones`, and that list
  // is empty until init() fills it. Without this every call silently keeps the
  // default and the assertions below all compare UTC with UTC.
  timezone.init();

  function labelFor(tz: string, at: number): string {
    timezone.setTimezone(tz);
    return get(zoneLabel)(at);
  }

  it("names the selected zone, not the host's", () => {
    // The trap this replaced: format(toZonedTime(d, tz), "zzz") prints the
    // host's offset for every zone, so on this host every label would be GMT-5.
    process.env.TZ = "America/New_York";

    expect(labelFor("UTC", WINTER)).toBe("UTC");
    expect(labelFor("Europe/Berlin", WINTER)).toBe("GMT+1");
  });

  it("gives the same label whatever zone the process runs in", () => {
    const seen = new Set<string>();
    for (const hostZone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
      process.env.TZ = hostZone;
      seen.add(labelFor("Europe/Berlin", WINTER));
    }
    expect(seen).toEqual(new Set(["GMT+1"]));
  });

  it("follows daylight saving rather than pinning one offset", () => {
    process.env.TZ = "UTC";
    expect(labelFor("Europe/Berlin", WINTER)).toBe("GMT+1");
    expect(labelFor("Europe/Berlin", SUMMER)).toBe("GMT+2");
  });

  it("handles a half-hour offset", () => {
    // Spelled the way Intl.supportedValuesOf reports it, which is the legacy
    // alias rather than the canonical name. The store validates against that
    // list, so "Asia/Kolkata" would be refused here.
    process.env.TZ = "UTC";
    expect(labelFor("Asia/Calcutta", WINTER)).toBe("GMT+5:30");
  });

  it("refuses an unknown zone at the store rather than mislabelling", () => {
    // The store keeps the last good zone, so a bad value never reaches the
    // formatter. This pins that, which is the behaviour anyone reading the
    // label's own try/catch would otherwise assume was doing the work.
    process.env.TZ = "UTC";
    const before = labelFor("Europe/Berlin", WINTER);
    expect(labelFor("Mars/Olympus_Mons", WINTER)).toBe(before);
  });
});
