<<<<<<< HEAD
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
=======
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knex, { type Knex } from "knex";
import { MaintenancesRepository } from "./maintenances";

describe("MaintenancesRepository.getAllGlobalOngoingMaintenanceEvents", () => {
  const ts = 1000;
  let db: Knex;
  let repo: MaintenancesRepository;

  const summarize = (events: Awaited<ReturnType<MaintenancesRepository["getAllGlobalOngoingMaintenanceEvents"]>>) =>
    events.map((event) => ({ id: event.id, monitors: event.monitors.map((m) => m.monitor_tag) }));

  beforeAll(async () => {
    db = knex({
>>>>>>> b69e1be9022031659cf1e44b0e053aab4c0210e7
      client: "better-sqlite3",
      connection: { filename: ":memory:" },
      useNullAsDefault: true,
    });

<<<<<<< HEAD
    const base = await import("../../../../../migrations/20260109120000_add_maintenances_tables.js");
    const suppress = await import("../../../../../migrations/20260913140000_add_maintenance_suppress_alerts.js");
    await base.up(db);
    await suppress.up(db);

    repo = unscoped(new MaintenancesRepository(db));
=======
    await db.schema.createTable("monitors", (table) => {
      table.string("tag").primary();
      table.string("name").notNullable();
      table.string("image");
      table.string("is_hidden").defaultTo("NO").notNullable();
    });
    await db.schema.createTable("maintenances", (table) => {
      table.integer("id").primary();
      table.string("title").notNullable();
      table.string("description");
      table.string("status").defaultTo("ACTIVE");
      table.string("is_global").defaultTo("NO");
    });
    await db.schema.createTable("maintenances_events", (table) => {
      table.integer("id").primary();
      table.integer("maintenance_id").notNullable();
      table.integer("start_date_time").notNullable();
      table.integer("end_date_time").notNullable();
      table.string("status").defaultTo("ONGOING");
      table.timestamps(true, true);
    });
    await db.schema.createTable("maintenance_monitors", (table) => {
      table.integer("maintenance_id").notNullable();
      table.string("monitor_tag").notNullable();
      table.string("monitor_impact");
    });

    await db("monitors").insert([
      { tag: "api", name: "Public API", is_hidden: "NO" },
      { tag: "billing-db", name: "Billing DB", is_hidden: "YES" },
    ]);
    await db("maintenances").insert([
      { id: 1, title: "Global, no monitors", is_global: "YES" },
      { id: 2, title: "Global, hidden monitor only", is_global: "YES" },
      { id: 3, title: "Global, visible and hidden monitors", is_global: "YES" },
      { id: 4, title: "Not global, hidden monitor only", is_global: "NO" },
      { id: 5, title: "Not global, visible monitor only", is_global: "NO" },
    ]);
    await db("maintenances_events").insert([
      { id: 11, maintenance_id: 1, start_date_time: 900, end_date_time: 2000 },
      { id: 12, maintenance_id: 2, start_date_time: 800, end_date_time: 2000 },
      { id: 13, maintenance_id: 3, start_date_time: 700, end_date_time: 2000 },
      { id: 14, maintenance_id: 4, start_date_time: 600, end_date_time: 2000 },
      { id: 15, maintenance_id: 5, start_date_time: 500, end_date_time: 2000 },
    ]);
    await db("maintenance_monitors").insert([
      { maintenance_id: 2, monitor_tag: "billing-db", monitor_impact: "MAINTENANCE" },
      { maintenance_id: 3, monitor_tag: "api", monitor_impact: "MAINTENANCE" },
      { maintenance_id: 3, monitor_tag: "billing-db", monitor_impact: "MAINTENANCE" },
      { maintenance_id: 4, monitor_tag: "billing-db", monitor_impact: "MAINTENANCE" },
      { maintenance_id: 5, monitor_tag: "api", monitor_impact: "MAINTENANCE" },
    ]);

    repo = new MaintenancesRepository(db);
>>>>>>> b69e1be9022031659cf1e44b0e053aab4c0210e7
  });

  afterAll(async () => {
    await db.destroy();
  });

<<<<<<< HEAD
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
=======
  it("returns a global maintenance event that has no linked monitors", async () => {
    const events = summarize(await repo.getAllGlobalOngoingMaintenanceEvents(ts));
    expect(events).toContainEqual({ id: 11, monitors: [] });
  });

  it("keeps a global maintenance event linked only to hidden monitors, with an empty monitor list", async () => {
    const events = summarize(await repo.getAllGlobalOngoingMaintenanceEvents(ts));
    expect(events).toContainEqual({ id: 12, monitors: [] });
  });

  it("never lists a hidden monitor", async () => {
    expect(summarize(await repo.getAllGlobalOngoingMaintenanceEvents(ts))).toContainEqual({
      id: 13,
      monitors: ["api"],
    });
    expect(summarize(await repo.getAllGlobalOngoingMaintenanceEvents(ts, ["api", "billing-db"]))).toEqual([
      { id: 13, monitors: ["api"] },
      { id: 15, monitors: ["api"] },
    ]);
  });

  it("with a tags filter, returns only events linked to a requested monitor that is not hidden", async () => {
    expect(await repo.getAllGlobalOngoingMaintenanceEvents(ts, ["billing-db"])).toEqual([]);
    expect(summarize(await repo.getAllGlobalOngoingMaintenanceEvents(ts, ["api"]))).toEqual([
      { id: 13, monitors: ["api"] },
      { id: 15, monitors: ["api"] },
    ]);
>>>>>>> b69e1be9022031659cf1e44b0e053aab4c0210e7
  });
});
