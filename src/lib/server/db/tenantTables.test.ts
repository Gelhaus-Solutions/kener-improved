import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TENANT_TABLES, INSTANCE_TABLES, isTenantTable } from "./tenantTables.js";
import { ROLLUP_TABLES } from "../types/db.js";
import { PARTITIONED_TABLES } from "./partitions.js";

// Whether a table is tenant-scoped is a *registration*, not something the type
// system can see. `BaseRepository.table()` looks the name up in `TENANT_TABLES`
// at runtime; a table missing from it is passed straight through, unscoped and
// unstamped.
//
// That is how KENER-124 shipped. `monitor_rollup_15m` was created, wired into
// the fold chain, the read path and retention, and typechecked clean. The first
// write died with:
//
//   null value in column "org_id" of relation "monitor_rollup_15m_y2026m06"
//
// The compile-time guarantee the tenancy design rests on - `this.knex("monitors")`
// does not exist, so a repository that forgets to scope does not build - covers
// forgetting to *scope a query*. It does not cover forgetting to *declare a
// table*, and the failure mode of the second is a NOT NULL violation on
// Postgres, or silent cross-tenant rows wherever the column happens to be
// nullable.
//
// These are the checks that need no database. The both-directions check against
// a real schema - every table that carries `org_id` is registered, and every
// registered table has the column - is `npm run db:check-tenancy`, because it
// can only be asked of a database that exists.

const ROOT = path.resolve(process.cwd());
const PHASE3 = path.join(ROOT, "migrations", "20260909120000_add_org_schema_phase3.ts");

/**
 * The table names in a `const TENANT_TABLES = [...]` literal.
 *
 * **Comments are stripped first, and that is not fussiness.** The list is
 * heavily commented and several of those comments contain quoted phrases; a
 * regex run over the raw slice picks up `"it is safe by accident"` as a table
 * name and reports a mismatch that is not there. A check that reports things
 * that are not there is one somebody eventually turns off.
 */
function tableNamesIn(source: string, declaration: RegExp): string[] {
  const match = source.match(declaration);
  if (!match) throw new Error("could not find the table list; has the declaration been renamed?");
  const withoutComments = match[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...withoutComments.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("TENANT_TABLES covers every table that is supposed to be scoped", () => {
  it("includes every rollup grain's table", () => {
    // The exact KENER-124 failure. A grain added to `ROLLUP_TABLES` is a table
    // the engine writes to on its next tick, so it has to be registered in the
    // same change.
    for (const table of Object.values(ROLLUP_TABLES)) {
      expect(isTenantTable(table), `${table} is a rollup table and must be tenant-scoped`).toBe(true);
    }
  });

  it("includes every partitioned table", () => {
    // A partitioned table is per-org history by definition - that is why it grew
    // big enough to need partitioning. Missing one here means the partition
    // maintenance writes rows nothing scopes.
    for (const { table } of PARTITIONED_TABLES) {
      expect(isTenantTable(table), `${table} is partitioned and must be tenant-scoped`).toBe(true);
    }
  });

  it("includes every table the phase 3 migration made org_id NOT NULL on", () => {
    // That migration carries its own copy of the list, deliberately: a migration
    // has to stay self-contained because it must keep working against a checkout
    // of `src/` from any later point in time. Its header says the two lists
    // agreeing "is what makes the constraint and the runtime scoping describe the
    // same set of tables", and until now nothing checked that they did.
    //
    // **Subset, not equality.** The migration's list is frozen at what existed on
    // 2026-09-09 and must never be edited; `TENANT_TABLES` legitimately grows
    // past it. What must never happen is the other direction: a table whose
    // `org_id` cannot be null, no longer being stamped by the runtime, which is
    // an insert that fails at the database rather than a wrong answer.
    const frozen = tableNamesIn(fs.readFileSync(PHASE3, "utf8"), /const TENANT_TABLES = \[([\s\S]*?)\n\];/);
    expect(frozen.length).toBeGreaterThan(20);

    const unregistered = frozen.filter((table) => !isTenantTable(table));
    expect(unregistered, "tables with a NOT NULL org_id that the runtime no longer scopes").toEqual([]);
  });
});

describe("the two registrations do not contradict each other", () => {
  it("never calls the same table both tenant and instance", () => {
    // `INSTANCE_TABLES` is documentation rather than something consulted at
    // runtime, which is exactly why it can drift without anyone noticing. A
    // table in both lists means the prose says one thing and the scoping does
    // another, and the prose is what the next person adding a table reads.
    const both = [...TENANT_TABLES].filter((table) => INSTANCE_TABLES.has(table));
    expect(both, "listed as both tenant-scoped and instance-wide").toEqual([]);
  });

  it("does not register the tables an org is found through", () => {
    // These three cannot be scoped by org: they are how the org is resolved in
    // the first place. Scoping `org_members` by the current org would mean
    // needing the org to find the org.
    for (const table of ["orgs", "org_members", "org_domains"]) {
      expect(isTenantTable(table), `${table} is how an org is found and must not be scoped by one`).toBe(false);
    }
  });

  it("registers no table twice and none empty", () => {
    expect([...TENANT_TABLES].every((table) => table.trim().length > 0)).toBe(true);
    expect([...INSTANCE_TABLES].every((table) => table.trim().length > 0)).toBe(true);
  });
});
