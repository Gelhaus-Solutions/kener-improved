import { describe, it, expect } from "vitest";
import { computeNextRunAt, isValidTimezone, resolveScheduleRange } from "./reportSchedule.js";

const iso = (ts: number) => new Date(ts * 1000).toISOString();
const at = (text: string) => Math.floor(Date.parse(text) / 1000);

describe("isValidTimezone", () => {
  it("accepts an IANA zone", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });
  it("rejects nonsense", () => {
    expect(isValidTimezone("Middle/Earth")).toBe(false);
  });
});

describe("resolveScheduleRange", () => {
  it("PREV_MONTH in UTC is the whole month that just ended", () => {
    const fired = at("2026-03-01T09:00:00Z");
    const range = resolveScheduleRange("PREV_MONTH", fired, "UTC");
    expect(iso(range.from)).toBe("2026-02-01T00:00:00.000Z");
    expect(iso(range.to)).toBe("2026-03-01T00:00:00.000Z");
  });

  it("PREV_MONTH in Berlin starts an hour before the UTC month", () => {
    // The whole reason `timezone` is a column. A Berlin reader's February began
    // at 23:00Z on 31 January; reporting the UTC month would hand them a document
    // whose first hour belongs to a month they did not ask about.
    const fired = at("2026-03-01T08:00:00Z");
    const range = resolveScheduleRange("PREV_MONTH", fired, "Europe/Berlin");
    expect(iso(range.from)).toBe("2026-01-31T23:00:00.000Z");
    expect(iso(range.to)).toBe("2026-02-28T23:00:00.000Z");
  });

  it("PREV_MONTH crosses a year boundary", () => {
    const fired = at("2026-01-01T06:00:00Z");
    const range = resolveScheduleRange("PREV_MONTH", fired, "UTC");
    expect(iso(range.from)).toBe("2025-12-01T00:00:00.000Z");
    expect(iso(range.to)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("PREV_WEEK is the Monday-to-Monday week that just ended", () => {
    // 2026-03-04 is a Wednesday, so the previous week is 23 Feb to 2 Mar.
    const fired = at("2026-03-04T09:00:00Z");
    const range = resolveScheduleRange("PREV_WEEK", fired, "UTC");
    expect(iso(range.from)).toBe("2026-02-23T00:00:00.000Z");
    expect(iso(range.to)).toBe("2026-03-02T00:00:00.000Z");
  });

  it("PREV_WEEK is right when it fires on a Sunday", () => {
    // The off-by-one this guards: `getUTCDay()` is 0 on Sunday, so without the
    // Sunday-to-7 mapping the week comes out six days wrong.
    const fired = at("2026-03-08T09:00:00Z"); // a Sunday
    const range = resolveScheduleRange("PREV_WEEK", fired, "UTC");
    expect(iso(range.from)).toBe("2026-02-23T00:00:00.000Z");
    expect(iso(range.to)).toBe("2026-03-02T00:00:00.000Z");
  });

  it("rolling ranges end at the firing instant and need no calendar", () => {
    const fired = at("2026-03-17T13:37:00Z");
    const range = resolveScheduleRange("LAST_30D", fired, "Europe/Berlin");
    expect(range.to).toBe(fired);
    expect(range.from).toBe(fired - 30 * 86400);
  });

  it("falls back to UTC rather than throwing on an unknown zone", () => {
    const fired = at("2026-03-01T09:00:00Z");
    const range = resolveScheduleRange("PREV_MONTH", fired, "Middle/Earth");
    expect(iso(range.from)).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("computeNextRunAt", () => {
  it("finds the next monthly occurrence", () => {
    const after = at("2026-03-05T00:00:00Z");
    const next = computeNextRunAt("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", after);
    expect(next).not.toBeNull();
    expect(iso(next!)).toBe("2026-04-01T09:00:00.000Z");
  });

  it("places the occurrence in the schedule's zone, not in UTC", () => {
    // 09:00 in Berlin is 08:00Z in winter.
    const after = at("2026-01-05T00:00:00Z");
    const next = computeNextRunAt("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "Europe/Berlin", after);
    expect(iso(next!)).toBe("2026-02-01T08:00:00.000Z");
  });

  it("keeps the local hour across a daylight saving change", () => {
    // The reason the rule is evaluated as a wall clock and converted after.
    // Berlin is UTC+1 in winter and UTC+2 in summer; 09:00 local must stay 09:00
    // local, which means the UTC instant moves by an hour rather than the local
    // time drifting.
    const winter = computeNextRunAt(
      "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      "Europe/Berlin",
      at("2026-01-05T00:00:00Z"),
    );
    const summer = computeNextRunAt(
      "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      "Europe/Berlin",
      at("2026-06-05T00:00:00Z"),
    );
    expect(iso(winter!)).toBe("2026-02-01T08:00:00.000Z");
    expect(iso(summer!)).toBe("2026-07-01T07:00:00.000Z");
  });

  it("returns null for an unparseable rule rather than throwing", () => {
    // Stored as null, so the schedule never becomes due instead of throwing on
    // every hourly tick forever.
    expect(computeNextRunAt("NOT A RULE", "UTC", at("2026-03-05T00:00:00Z"))).toBeNull();
  });

  it("returns null for a rule with no further occurrence", () => {
    const after = at("2026-03-05T00:00:00Z");
    // A rule that finished before the cursor.
    const next = computeNextRunAt("FREQ=DAILY;COUNT=1", "UTC", after, at("2020-01-01T00:00:00Z"));
    expect(next).toBeNull();
  });

  it("is strictly after the cursor, so a schedule cannot re-fire on its own instant", () => {
    const exactly = at("2026-04-01T09:00:00Z");
    const next = computeNextRunAt("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", exactly);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(exactly);
  });
});
