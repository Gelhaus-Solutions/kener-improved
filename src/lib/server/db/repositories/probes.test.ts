import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Knex from "knex";
import type { Knex as KnexType } from "knex";
import { ProbesRepository } from "./probes.js";
import { unscoped } from "./testSupport";

/**
 * The reads the probes screen and the scheduler make, against a region that has
 * more than one agent.
 *
 * **Why this file exists.** Both of these join `probe_agents` on `region_id`, and
 * that join returns one row per matching agent. While a region could only hold
 * one agent that was invisible; the moment it can hold two, every row on both
 * sides doubles. For scheduling that is correct and wanted, because each agent
 * really does have to be dispatched to. For the screen it was a bug, and a loud
 * one: the assignment list is keyed on `assignment_id`, so a duplicated row
 * crashed the render with `each_key_duplicate` and the page hung on its spinner
 * for ever, with nothing whatever on the server to show for it.
 *
 * A green test suite had nothing to say about any of it, because every fixture
 * in the repository had one agent per region. So the fixture here is two.
 */
describe("ProbesRepository with several agents in one region", () => {
  let db: KnexType;
  let repo: ProbesRepository;

  beforeAll(async () => {
    db = Knex({
      client: "better-sqlite3",
      connection: { filename: ":memory:" },
      useNullAsDefault: true,
    });

    await db.schema.createTable("probe_agents", (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable();
      table.string("name").notNullable();
      table.integer("region_id").notNullable();
      table.string("token_hash").notNullable();
      table.string("token_hint");
      table.string("status").notNullable();
      table.string("connection_state").notNullable();
      table.string("agent_version");
      table.string("capabilities");
      table.integer("last_seen_at");
      table.integer("created_at");
      table.integer("updated_at");
    });

    await db.schema.createTable("monitor_probe_assignments", (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable();
      table.string("monitor_tag").notNullable();
      table.integer("region_id").notNullable();
      table.string("mode").notNullable();
      table.string("source").notNullable();
      table.integer("created_at");
      table.integer("updated_at");
    });

    // One region, two agents. The second is what every assertion below turns on.
    await db("probe_agents").insert([
      {
        id: 1,
        org_id: 1,
        name: "frankfurt-a",
        region_id: 3,
        token_hash: "a",
        token_hint: "aaaa",
        status: "ACTIVE",
        connection_state: "CONNECTED",
      },
      {
        id: 2,
        org_id: 1,
        name: "frankfurt-b",
        region_id: 3,
        token_hash: "b",
        token_hint: "bbbb",
        status: "ACTIVE",
        connection_state: "CONNECTED",
      },
      // A disabled third, to prove the scheduling read still filters on status
      // rather than simply returning everything in the region.
      {
        id: 3,
        org_id: 1,
        name: "frankfurt-off",
        region_id: 3,
        token_hash: "c",
        token_hint: "cccc",
        status: "DISABLED",
        connection_state: "DISCONNECTED",
      },
    ]);

    await db("monitor_probe_assignments").insert([
      { id: 10, org_id: 1, monitor_tag: "api", region_id: 3, mode: "REMOTE_PREFERRED", source: "RULE" },
      { id: 11, org_id: 1, monitor_tag: "web", region_id: 3, mode: "REMOTE_PREFERRED", source: "OVERRIDE" },
    ]);

    repo = unscoped(new ProbesRepository(db));
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("returns each assignment exactly once, whatever the region's agent count", async () => {
    const rows = await repo.getProbeAssignments();

    // Two assignments, not four. The screen keys on `assignment_id`, so a
    // duplicate here is a crashed page rather than a cosmetic repeat.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.assignment_id).sort()).toEqual([10, 11]);
    expect(new Set(rows.map((r) => r.assignment_id)).size).toBe(rows.length);
  });

  it("still dispatches one target per active agent, because each has to be asked", async () => {
    const targets = await repo.getProbeTargetsForMonitor("api");

    // The opposite expectation to the one above, on purpose. Scheduling wants
    // the fan-out: both live agents run the check and the merge reduces their
    // answers to the region's single verdict.
    expect(targets.map((t) => t.agent_id).sort()).toEqual([1, 2]);
    expect(targets.every((t) => t.region_id === 3)).toBe(true);
  });
});
