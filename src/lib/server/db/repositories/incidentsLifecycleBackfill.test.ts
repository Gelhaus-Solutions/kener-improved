import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Knex from "knex";
import type { Knex as KnexType } from "knex";
import { IncidentsRepository, alertCreatedAtSeconds } from "./incidents.js";
import { unscoped } from "./testSupport";

/**
 * KENER-150. The re-runnable lifecycle backfill.
 *
 * **What went wrong, because it decides what these tests have to prove.** The
 * original backfill lived inside migration `20260909170000`, and migrations run
 * before seeds on every path there is. A fresh install therefore swept an empty
 * `incidents` table, wrote nothing, and knex marked the migration done for ever.
 * Every incident that arrived afterwards kept null timestamps permanently and
 * the Response Timeline read "Not recorded" on every row, with no script, action
 * or command able to recompute it.
 *
 * So the property under test is not "it computes the right value once". It is
 * **that it can be run again, at any time, against a database that already has
 * data, without disagreeing with itself or with what is already there.** That is
 * what lets it be a button an operator presses when they notice.
 */

/** The migration's own fixture era, so a reader can check the rules by eye. */
const T = {
  alertEarly: 1768485600, // 2026-01-15T14:00:00Z
  alertLate: 1768489200, // 15:00
  identified: 1768486500, // 14:15
  identifiedAgain: 1768488000, // 14:40, after slipping back
  monitoring: 1768487400, // 14:30
  resolved: 1768490000, // 15:13
  resolvedAgain: 1768492000, // 15:46, after a reopen
  ended: 1768490000,
};

async function schema(db: KnexType): Promise<void> {
  await db.schema.createTable("incidents", (table) => {
    table.increments("id").primary();
    table.string("title");
    table.integer("start_date_time");
    table.integer("end_date_time");
    table.string("state");
    table.integer("detected_at");
    table.integer("acknowledged_at");
    table.integer("identified_at");
    table.integer("mitigated_at");
    table.integer("resolved_at");
  });

  await db.schema.createTable("incident_comments", (table) => {
    table.increments("id").primary();
    table.integer("incident_id");
    table.string("state");
    table.integer("commented_at");
  });

  await db.schema.createTable("monitor_alerts_v2", (table) => {
    table.increments("id").primary();
    table.integer("incident_id");
    // Deliberately a string column: SQLite stores knex.fn.now() as naive text,
    // and that is the shape the parsing branch exists for.
    table.string("created_at");
  });
}

describe("IncidentsRepository.backfillLifecycleTimestamps", () => {
  let db: KnexType;
  let repo: IncidentsRepository;

  beforeEach(async () => {
    db = Knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
    await schema(db);
    repo = unscoped(new IncidentsRepository(db));
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function incident(over: Record<string, unknown> = {}): Promise<number> {
    const [id] = await db("incidents").insert({
      title: "Checkout is down",
      start_date_time: T.alertEarly,
      end_date_time: T.ended,
      state: "RESOLVED",
      ...over,
    });
    return id as number;
  }

  async function row(id: number) {
    return await db("incidents").where("id", id).first();
  }

  it("derives all four columns from the evidence that is still in the database", async () => {
    const id = await incident();
    await db("monitor_alerts_v2").insert([
      { incident_id: id, created_at: "2026-01-15 15:00:00" },
      { incident_id: id, created_at: "2026-01-15 14:00:00" },
    ]);
    await db("incident_comments").insert([
      { incident_id: id, state: "IDENTIFIED", commented_at: T.identified },
      { incident_id: id, state: "MONITORING", commented_at: T.monitoring },
      { incident_id: id, state: "RESOLVED", commented_at: T.resolved },
    ]);

    const counts = await repo.backfillLifecycleTimestamps();

    expect(counts).toEqual({
      incidents_considered: 1,
      detected_at: 1,
      identified_at: 1,
      mitigated_at: 1,
      resolved_at: 1,
    });
    expect(await row(id)).toMatchObject({
      detected_at: T.alertEarly,
      identified_at: T.identified,
      mitigated_at: T.monitoring,
      resolved_at: T.resolved,
    });
  });

  // THE PROPERTY THE WHOLE FIX RESTS ON. A button an operator can press twice is
  // only safe if the second press is a no-op, and "no-op" has to mean both "no
  // value changed" and "it reported that it changed nothing".
  it("is idempotent: a second run writes nothing and reports nothing", async () => {
    const id = await incident();
    await db("monitor_alerts_v2").insert({ incident_id: id, created_at: "2026-01-15 14:00:00" });
    await db("incident_comments").insert({ incident_id: id, state: "RESOLVED", commented_at: T.resolved });

    const first = await repo.backfillLifecycleTimestamps();
    const afterFirst = await row(id);

    const second = await repo.backfillLifecycleTimestamps();
    const afterSecond = await row(id);

    expect(first.detected_at).toBe(1);
    expect(second).toEqual({
      incidents_considered: 1, // identified_at and mitigated_at have no evidence, so it stays a candidate
      detected_at: 0,
      identified_at: 0,
      mitigated_at: 0,
      resolved_at: 0,
    });
    expect(afterSecond).toEqual(afterFirst);
  });

  // The other half of safety: it must never argue with a live transition or a
  // human. Every column here already holds a value that the evidence disagrees
  // with, and the evidence must lose.
  it("never overwrites a timestamp that is already set", async () => {
    const id = await incident({
      detected_at: 111,
      identified_at: 222,
      mitigated_at: 333,
      resolved_at: 444,
    });
    await db("monitor_alerts_v2").insert({ incident_id: id, created_at: "2026-01-15 14:00:00" });
    await db("incident_comments").insert([
      { incident_id: id, state: "IDENTIFIED", commented_at: T.identified },
      { incident_id: id, state: "MONITORING", commented_at: T.monitoring },
      { incident_id: id, state: "RESOLVED", commented_at: T.resolved },
    ]);

    const counts = await repo.backfillLifecycleTimestamps();

    expect(counts.incidents_considered).toBe(0);
    expect(await row(id)).toMatchObject({
      detected_at: 111,
      identified_at: 222,
      mitigated_at: 333,
      resolved_at: 444,
    });
  });

  /**
   * The same property where it is actually load-bearing.
   *
   * The test above is answered by the candidate filter alone: an incident with
   * all four columns set never enters the sweep, so the per-column `whereNull`
   * guard is never reached and removing it leaves that test green. A
   * PARTIALLY filled incident is the case the guard exists for - it must be
   * swept, because something is genuinely missing, and the columns that are
   * already set must survive the sweep.
   *
   * Found by mutation: deleting `whereNull(column)` reddened only the
   * idempotence test, which meant the stated property was one layer thinner
   * than it read.
   */
  it("fills only the missing columns of a partly stamped incident", async () => {
    const id = await incident({
      detected_at: null,
      identified_at: 222, // a human corrected this one
      mitigated_at: null,
      resolved_at: null,
    });
    await db("monitor_alerts_v2").insert({ incident_id: id, created_at: "2026-01-15 14:00:00" });
    await db("incident_comments").insert([
      { incident_id: id, state: "IDENTIFIED", commented_at: T.identified },
      { incident_id: id, state: "MONITORING", commented_at: T.monitoring },
      { incident_id: id, state: "RESOLVED", commented_at: T.resolved },
    ]);

    const counts = await repo.backfillLifecycleTimestamps();

    expect(counts.incidents_considered).toBe(1);
    expect(counts.identified_at).toBe(0);
    expect(await row(id)).toMatchObject({
      detected_at: T.alertEarly,
      identified_at: 222, // the correction survived, the evidence did not win
      mitigated_at: T.monitoring,
      resolved_at: T.resolved,
    });
  });

  it("takes the earliest alert for detection, not the latest", async () => {
    const id = await incident();
    await db("monitor_alerts_v2").insert([
      { incident_id: id, created_at: "2026-01-15 15:00:00" },
      { incident_id: id, created_at: "2026-01-15 14:00:00" },
      { incident_id: id, created_at: "2026-01-15 14:30:00" },
    ]);

    await repo.backfillLifecycleTimestamps();

    expect((await row(id)).detected_at).toBe(T.alertEarly);
    expect((await row(id)).detected_at).not.toBe(T.alertLate);
  });

  // Identification is a thing you learn and do not unlearn, so an incident that
  // slipped back to INVESTIGATING and was identified again was identified at the
  // FIRST one.
  it("takes the first IDENTIFIED and the first MONITORING", async () => {
    const id = await incident();
    await db("incident_comments").insert([
      { incident_id: id, state: "IDENTIFIED", commented_at: T.identifiedAgain },
      { incident_id: id, state: "IDENTIFIED", commented_at: T.identified },
      { incident_id: id, state: "MONITORING", commented_at: T.monitoring },
    ]);

    await repo.backfillLifecycleTimestamps();

    expect((await row(id)).identified_at).toBe(T.identified);
  });

  // Resolution is not. An incident resolved, reopened and resolved again was
  // over at the SECOND one; taking the first reports an MTTR that ends before
  // the outage did.
  it("takes the last RESOLVED, which is the opposite of the other two", async () => {
    const id = await incident({ end_date_time: T.resolvedAgain });
    await db("incident_comments").insert([
      { incident_id: id, state: "RESOLVED", commented_at: T.resolved },
      { incident_id: id, state: "RESOLVED", commented_at: T.resolvedAgain },
    ]);

    await repo.backfillLifecycleTimestamps();

    expect((await row(id)).resolved_at).toBe(T.resolvedAgain);
  });

  // A reopened incident has a RESOLVED comment in its history and is not
  // resolved now. Stamping it would make an open incident report an MTTR and put
  // it in every "resolved this month" count.
  it("refuses to resolve an incident that is open right now", async () => {
    const id = await incident({ end_date_time: null, state: "INVESTIGATING" });
    await db("incident_comments").insert([
      { incident_id: id, state: "RESOLVED", commented_at: T.resolved },
      { incident_id: id, state: "IDENTIFIED", commented_at: T.identified },
    ]);

    const counts = await repo.backfillLifecycleTimestamps();

    expect((await row(id)).resolved_at).toBeNull();
    expect(counts.resolved_at).toBe(0);
    // The rest of the timeline is still recovered; only resolution is withheld.
    expect((await row(id)).identified_at).toBe(T.identified);
  });

  it("falls back to end_date_time for an incident closed without a RESOLVED comment", async () => {
    const id = await incident({ end_date_time: T.ended });

    const counts = await repo.backfillLifecycleTimestamps();

    expect((await row(id)).resolved_at).toBe(T.ended);
    expect(counts.resolved_at).toBe(1);
  });

  it("lets a real RESOLVED comment beat the end_date_time fallback", async () => {
    const id = await incident({ end_date_time: T.resolvedAgain });
    await db("incident_comments").insert({ incident_id: id, state: "RESOLVED", commented_at: T.resolved });

    await repo.backfillLifecycleTimestamps();

    // The comment, not the coarser end time.
    expect((await row(id)).resolved_at).toBe(T.resolved);
  });

  // MTTA is a claim about a human responding. No historical source for that
  // exists, and deriving it from anything available would be inventing the
  // number rather than measuring it.
  it("never invents acknowledged_at", async () => {
    const id = await incident();
    await db("monitor_alerts_v2").insert({ incident_id: id, created_at: "2026-01-15 14:00:00" });
    await db("incident_comments").insert({ incident_id: id, state: "RESOLVED", commented_at: T.resolved });

    await repo.backfillLifecycleTimestamps();

    expect((await row(id)).acknowledged_at).toBeNull();
  });

  it("touches only the incident it was given", async () => {
    const target = await incident();
    const other = await incident();
    await db("incident_comments").insert([
      { incident_id: target, state: "RESOLVED", commented_at: T.resolved },
      { incident_id: other, state: "RESOLVED", commented_at: T.resolved },
    ]);

    const counts = await repo.backfillLifecycleTimestamps(target);

    expect(counts.incidents_considered).toBe(1);
    expect((await row(target)).resolved_at).toBe(T.resolved);
    expect((await row(other)).resolved_at).toBeNull();
  });

  it("handles more incidents than one whereIn chunk", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 620; i++) ids.push(await incident());
    // In batches: SQLite caps a compound SELECT at 500 terms, which is a limit
    // of this fixture and not of the code under test.
    for (let i = 0; i < ids.length; i += 100) {
      await db("incident_comments").insert(
        ids.slice(i, i + 100).map((id) => ({ incident_id: id, state: "RESOLVED", commented_at: T.resolved })),
      );
    }

    const counts = await repo.backfillLifecycleTimestamps();

    expect(counts.incidents_considered).toBe(620);
    expect(counts.resolved_at).toBe(620);
    expect((await row(ids[0])).resolved_at).toBe(T.resolved);
    expect((await row(ids[619])).resolved_at).toBe(T.resolved);
  });
});

/**
 * The naive-text branch, which is the one that silently produces a wrong answer
 * rather than an error.
 *
 * SQLite stores `knex.fn.now()` as `YYYY-MM-DD HH:MM:SS` with no zone marker,
 * and `new Date()` reads a string in that shape as LOCAL time. On a Berlin
 * machine that moves every `detected_at` by an hour or two, in the direction
 * that makes detection look like it happened before the outage began. Postgres
 * returns a real Date and needs none of this, which is exactly why a
 * Postgres-only test would never have seen it.
 *
 * `npm test` pins TZ=UTC, so the invariance has to be forced rather than hoped
 * for, and the fixture is LATE EVENING on purpose: a midday timestamp lands on
 * the same instant-of-day arithmetic in every zone within twelve hours of UTC,
 * which is how this class of bug survives a test suite.
 */
describe("alertCreatedAtSeconds is the same answer in every timezone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  const zones = ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"];

  it("reads naive SQLite text as UTC wherever the host is standing", () => {
    const answers = zones.map((zone) => {
      process.env.TZ = zone;
      return alertCreatedAtSeconds("2026-01-15 23:30:00");
    });

    // 2026-01-15T23:30:00Z
    expect(new Set(answers)).toEqual(new Set([1768519800]));
  });

  it("agrees with an explicit UTC Date for the same instant", () => {
    process.env.TZ = "Asia/Kolkata";
    expect(alertCreatedAtSeconds("2026-01-15 23:30:00")).toBe(
      alertCreatedAtSeconds(new Date("2026-01-15T23:30:00Z")),
    );
  });

  it("tells seconds from milliseconds by magnitude", () => {
    expect(alertCreatedAtSeconds(1768519800)).toBe(1768519800);
    expect(alertCreatedAtSeconds(1768519800000)).toBe(1768519800);
  });

  it("returns null rather than NaN for something unusable", () => {
    expect(alertCreatedAtSeconds(null)).toBeNull();
    expect(alertCreatedAtSeconds(undefined)).toBeNull();
    expect(alertCreatedAtSeconds("not a date")).toBeNull();
    expect(alertCreatedAtSeconds({})).toBeNull();
  });
});
