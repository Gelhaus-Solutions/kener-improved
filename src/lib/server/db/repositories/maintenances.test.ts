import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Knex from "knex";
import type { Knex as KnexType } from "knex";
import { MaintenancesRepository } from "./maintenances.js";
import { unscoped } from "./testSupport";

/**
 * `createMaintenance` builds its insert from an explicit whitelist of columns.
 *
 * **That is the shape of the bug this file exists to stop.** A field the caller
 * passes but the whitelist does not name is not rejected and does not error: it
 * is silently dropped, the row takes the column default, and the caller is told
 * the write succeeded. D4's `suppress_alerts` shipped that way for exactly one
 * live run, and nothing in a mocked test could have seen it, because the mock
 * returns whatever it was told to.
 *
 * So the schema here is built by running the real migrations rather than by
 * hand: a fixture table written from the same assumption as the code under test
 * agrees with it by construction, which is how a whitelist stays untested.
 */
describe("MaintenancesRepository.createMaintenance", () => {
  let db: KnexType;
  let repo: MaintenancesRepository;

  beforeAll(async () => {
    db = Knex({
      client: "better-sqlite3",
      connection: { filename: ":memory:" },
      useNullAsDefault: true,
    });

    const base = await import("../../../../../migrations/20260109120000_add_maintenances_tables.js");
    const suppress = await import("../../../../../migrations/20260913140000_add_maintenance_suppress_alerts.js");
    await base.up(db);
    await suppress.up(db);

    repo = unscoped(new MaintenancesRepository(db));
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("persists suppress_alerts when the caller sets it", async () => {
    const created = await repo.createMaintenance({
      title: "Risky migration",
      start_date_time: 1000,
      rrule: "",
      duration_seconds: 3600,
      suppress_alerts: "NO",
    } as never);

    const stored = await repo.getMaintenanceById(created.id);
    expect(stored?.suppress_alerts).toBe("NO");
  });

  it("defaults to suppressing, because that is what every window did before D4", async () => {
    const created = await repo.createMaintenance({
      title: "Ordinary window",
      start_date_time: 1000,
      rrule: "",
      duration_seconds: 3600,
    } as never);

    const stored = await repo.getMaintenanceById(created.id);
    expect(stored?.suppress_alerts).toBe("YES");
  });
});
