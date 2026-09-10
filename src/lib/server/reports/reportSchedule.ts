import { rrulestr } from "rrule";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

/**
 * When a schedule fires, and what range it covers (F4).
 *
 * Pure, and separated from the scheduler for the usual reason: this is where the
 * timezone and calendar reasoning lives, and it should be testable by naming a
 * date rather than by waiting for the first of the month.
 *
 * **Everything here goes through an explicit `WallClock`, and that is not
 * ceremony.** Two libraries are in play and they disagree about which half of a
 * `Date` carries the answer: `toZonedTime` returns a Date whose *local* fields
 * read as the target zone, while `rrule` - given a `DTSTART:...Z` - returns Dates
 * whose *UTC* fields carry the intended wall clock. The first version of this
 * file read UTC getters off a `toZonedTime` result, which is correct only when
 * the process itself runs in UTC and silently wrong everywhere else. Naming the
 * six numbers makes each conversion state which convention it is reading.
 */

export type ReportRangeKind = "PREV_MONTH" | "PREV_WEEK" | "LAST_7D" | "LAST_30D" | "LAST_90D";

export const REPORT_RANGE_KINDS: readonly ReportRangeKind[] = [
  "PREV_MONTH",
  "PREV_WEEK",
  "LAST_7D",
  "LAST_30D",
  "LAST_90D",
];

const DAY = 86400;

/** A local date and time with no zone attached. `month` is 0-based, like `Date`. */
interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function zoneOrUtc(timezone: string): string {
  return isValidTimezone(timezone) ? timezone : "UTC";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The wall clock showing in `zone` at a given instant. Reads *local* getters. */
function wallClockInZone(instantSeconds: number, zone: string): WallClock {
  const zoned = toZonedTime(new Date(instantSeconds * 1000), zone);
  return {
    year: zoned.getFullYear(),
    month: zoned.getMonth(),
    day: zoned.getDate(),
    hour: zoned.getHours(),
    minute: zoned.getMinutes(),
    second: zoned.getSeconds(),
  };
}

/**
 * The instant at which `wall` shows in `zone`.
 *
 * Built as a string rather than a Date so `fromZonedTime` has nothing to
 * interpret against the host's own zone.
 */
function wallClockToInstant(wall: WallClock, zone: string): number {
  const text = `${wall.year}-${pad(wall.month + 1)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
  return Math.floor(fromZonedTime(text, zone).getTime() / 1000);
}

/** Normalises a wall clock (day 0, month 12, ...) by round-tripping through `Date.UTC`. */
function normalise(wall: WallClock): WallClock {
  const d = new Date(Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** Monday-based weekday, 1..7, for a wall clock. */
function isoWeekday(wall: WallClock): number {
  const day = new Date(Date.UTC(wall.year, wall.month, wall.day)).getUTCDay();
  // `getUTCDay` is Sunday-0. Without this mapping the week before a Sunday
  // firing comes out six days wrong, which is the classic bug in this expression.
  return day === 0 ? 7 : day;
}

/**
 * The window a schedule reports on, resolved at fire time.
 *
 * **Calendar kinds are resolved in the schedule's own timezone, then expressed
 * as UTC instants.** "Previous month" for a schedule set to Europe/Berlin means
 * the Berlin month, which begins an hour or two before the UTC one; reporting
 * the UTC month instead would hand a Berlin reader a document whose first hours
 * belong to the month before. The returned bounds are always UTC seconds,
 * because that is what the rollups are keyed by.
 *
 * The rolling kinds end at the fire instant and need no calendar reasoning at
 * all - "the last 30 days" is the same 30 days everywhere.
 */
export function resolveScheduleRange(
  kind: ReportRangeKind,
  firedAt: number,
  timezone: string,
): { from: number; to: number } {
  if (kind === "LAST_7D") return { from: firedAt - 7 * DAY, to: firedAt };
  if (kind === "LAST_30D") return { from: firedAt - 30 * DAY, to: firedAt };
  if (kind === "LAST_90D") return { from: firedAt - 90 * DAY, to: firedAt };

  const zone = zoneOrUtc(timezone);
  const local = wallClockInZone(firedAt, zone);
  const midnight = { hour: 0, minute: 0, second: 0 };

  if (kind === "PREV_WEEK") {
    const weekday = isoWeekday(local);
    const thisMonday = normalise({ ...local, ...midnight, day: local.day - (weekday - 1) });
    const prevMonday = normalise({ ...thisMonday, day: thisMonday.day - 7 });
    return { from: wallClockToInstant(prevMonday, zone), to: wallClockToInstant(thisMonday, zone) };
  }

  // PREV_MONTH: the whole month that has just ended, locally.
  const firstOfThisMonth = normalise({ ...local, ...midnight, day: 1 });
  const firstOfPrevMonth = normalise({ ...firstOfThisMonth, month: firstOfThisMonth.month - 1 });
  return { from: wallClockToInstant(firstOfPrevMonth, zone), to: wallClockToInstant(firstOfThisMonth, zone) };
}

/**
 * The next instant this schedule is due, strictly after `afterTs`.
 *
 * **The rule is evaluated as a wall clock and then placed in the zone**, which
 * is the only arrangement that survives daylight saving. `rrule` has no IANA
 * support without pulling in luxon; giving it a `DTSTART:...Z` makes it work
 * purely in UTC, so its answers carry the intended *local* fields in their UTC
 * getters, and `wallClockToInstant` then converts those to the real instant. An
 * 09:00 schedule therefore stays at 09:00 across a DST boundary rather than
 * drifting to 08:00 or 10:00.
 *
 * Returns null when the rule is unparseable or has no further occurrence, and
 * the caller stores that null. A schedule that cannot be parsed then simply
 * never becomes due, rather than throwing on every hourly tick forever.
 */
export function computeNextRunAt(rrule: string, timezone: string, afterTs: number, dtstartTs?: number): number | null {
  const zone = zoneOrUtc(timezone);
  try {
    const cursorWall = wallClockInZone(afterTs, zone);
    const startWall = wallClockInZone(dtstartTs ?? afterTs, zone);

    const asUtcDate = (wall: WallClock) =>
      new Date(Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second));

    const dtstart = `DTSTART:${asUtcDate(startWall).toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
    const rule = rrulestr(`${dtstart}\nRRULE:${rrule.replace(/^RRULE:/i, "")}`);

    // `inc: false` makes this strictly after the cursor, so a schedule whose
    // next run is computed at the exact instant it just fired advances instead
    // of returning that same instant and becoming due again on the next tick.
    const next = rule.after(asUtcDate(cursorWall), false);
    if (!next) return null;

    return wallClockToInstant(
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth(),
        day: next.getUTCDate(),
        hour: next.getUTCHours(),
        minute: next.getUTCMinutes(),
        second: next.getUTCSeconds(),
      },
      zone,
    );
  } catch {
    return null;
  }
}

/** A human description of the range kind, for the email and the admin screen. */
export function describeRangeKind(kind: ReportRangeKind): string {
  switch (kind) {
    case "PREV_MONTH":
      return "the previous calendar month";
    case "PREV_WEEK":
      return "the previous week";
    case "LAST_7D":
      return "the last 7 days";
    case "LAST_30D":
      return "the last 30 days";
    case "LAST_90D":
      return "the last 90 days";
  }
}
