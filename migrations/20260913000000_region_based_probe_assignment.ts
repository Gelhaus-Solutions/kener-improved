import type { Knex } from "knex";

// Probe assignment moves from the agent to the REGION (B1e).
//
// **The bug this removes.** `monitor_probe_assignments.agent_id` made the
// assignment a fact about one row in `probe_agents`, and `deleteProbeAgent`
// deletes the assignments with it because the schema deliberately carries no
// foreign key. So rotating a probe the ordinary way - delete the agent, create a
// new one with a fresh token - silently forgot every monitor it was checking.
// The operator sees an agent that connects, reports healthy, and checks nothing.
//
// The region was always the thing being configured. One agent per region is
// already enforced in `createProbeAgent` and `updateProbeAgent`, so `agent_id`
// was a second name for `region_id` that could be deleted independently of what
// it named. Keyed on the region, an agent becomes what it always was: the worker
// that happens to serve a place. Delete it, create another one there, and the
// assignments are still the region's.
//
// **The rule, and why the resolved rows are stored rather than derived.** A
// region carries a rule - `ALL` or `NONE` - and a monitor carries an
// include/exclude override for that region. Those two could answer every
// question at read time without `monitor_probe_assignments` existing at all.
// They are resolved into concrete `(monitor_tag, region_id)` rows anyway,
// because "which monitors is Frankfurt checking" is the question an operator
// actually asks, and an answer recomputed from two tables on every read is one
// nobody can inspect, diff, or find in an audit log. The resolved row records
// which of the two put it there, in `source`.

const ASSIGNMENTS = "monitor_probe_assignments";
const RULES = "probe_region_rules";
const OVERRIDES = "monitor_region_overrides";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(ASSIGNMENTS))) return;

  if (!(await knex.schema.hasTable(RULES))) {
    await knex.schema.createTable(RULES, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable().defaultTo(1);
      table.integer("region_id").notNullable();

      // ALL | NONE. NONE is the default and means "this region checks only the
      // monitors somebody named", which is exactly how assignment behaved
      // before this migration - so an existing install keeps behaving the same
      // until an operator asks for more.
      table.string("rule", 32).notNullable().defaultTo("NONE");

      // Carried from the assignment row, where it used to sit per monitor. It
      // never varied per monitor in practice and it is a property of how a
      // region is used, not of one check.
      table.string("mode", 32).notNullable().defaultTo("REMOTE_PREFERRED");

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });

    await knex.schema.alterTable(RULES, (table) => {
      table.index(["org_id"], "idx_probe_region_rules_org_id");
      table.unique(["org_id", "region_id"], { indexName: "probe_region_rules_org_region_unique" });
    });
  }

  if (!(await knex.schema.hasTable(OVERRIDES))) {
    await knex.schema.createTable(OVERRIDES, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable().defaultTo(1);
      table.string("monitor_tag", 255).notNullable();
      table.integer("region_id").notNullable();

      // INCLUDE | EXCLUDE, and both are needed. Without EXCLUDE a region set to
      // ALL could never spare one monitor, because the next resolve would put it
      // straight back; without INCLUDE a region set to NONE could never name one.
      table.string("decision", 16).notNullable();

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });

    await knex.schema.alterTable(OVERRIDES, (table) => {
      table.index(["org_id"], "idx_monitor_region_overrides_org_id");
      table.unique(["monitor_tag", "region_id"], { indexName: "monitor_region_overrides_tag_region_unique" });
    });
  }

  if (!(await knex.schema.hasColumn(ASSIGNMENTS, "region_id"))) {
    await knex.schema.alterTable(ASSIGNMENTS, (table) => {
      // Nullable for the length of this migration only: the backfill below fills
      // every row, and a `notNullable` column added to a table with rows needs a
      // default that would then be a real region id nobody chose.
      table.integer("region_id").nullable();
      // RULE | OVERRIDE. Which of the two produced this row, so the screen can
      // say "because Frankfurt checks everything" rather than leaving an
      // operator to work out why a monitor is on a list they did not put it on.
      table.string("source", 16).notNullable().defaultTo("OVERRIDE");
    });
  }

  // Every existing assignment named an agent, and one agent per region is
  // already enforced, so this is a rename rather than a merge: no two rows can
  // collide on the new key.
  if (await knex.schema.hasColumn(ASSIGNMENTS, "agent_id")) {
    await knex(ASSIGNMENTS)
      .update({
        region_id: knex(`probe_agents`).select("region_id").whereRaw(`probe_agents.id = ${ASSIGNMENTS}.agent_id`),
      })
      .whereNull("region_id");

    // An assignment whose agent no longer exists has already lost its meaning
    // and cannot be given a region. It is deleted rather than carried forward as
    // a null that every reader would then have to defend against.
    await knex(ASSIGNMENTS).whereNull("region_id").delete();

    // Each existing assignment was named by hand, so OVERRIDE is what it is:
    // no region has a rule yet.
    await knex(ASSIGNMENTS).update({ source: "OVERRIDE" });

    // ...and an OVERRIDE row has to be backed by an actual exception, or the
    // very first reconcile deletes it.
    //
    // This is not a tidiness point. `reconcileProbeAssignments` recomputes the
    // resolved rows from the rules and the exceptions and removes anything they
    // do not account for. Carrying the assignments across without the exceptions
    // that justify them would mean every existing probe assignment survived the
    // migration and was then silently dropped by the scheduler's next sweep -
    // which is the same class of silent loss this migration exists to remove,
    // arriving through the fix rather than the bug.
    const carried = (await knex(ASSIGNMENTS).select("org_id", "monitor_tag", "region_id")) as Array<{
      org_id: number;
      monitor_tag: string;
      region_id: number;
    }>;
    if (carried.length > 0) {
      const now = Math.floor(Date.now() / 1000);
      await knex(OVERRIDES)
        .insert(
          carried.map((row) => ({
            org_id: row.org_id,
            monitor_tag: row.monitor_tag,
            region_id: row.region_id,
            decision: "INCLUDE",
            created_at: now,
            updated_at: now,
          })),
        )
        .onConflict(["monitor_tag", "region_id"])
        .ignore();
    }

    await knex.schema.alterTable(ASSIGNMENTS, (table) => {
      table.dropUnique(["monitor_tag", "agent_id"], "monitor_probe_assignments_tag_agent_unique");
    });
    await knex.schema.alterTable(ASSIGNMENTS, (table) => {
      table.dropColumn("agent_id");
    });
    await knex.schema.alterTable(ASSIGNMENTS, (table) => {
      table.unique(["monitor_tag", "region_id"], { indexName: "monitor_probe_assignments_tag_region_unique" });
      table.index(["region_id"], "idx_monitor_probe_assignments_region_id");
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(OVERRIDES)) await knex.schema.dropTable(OVERRIDES);
  if (await knex.schema.hasTable(RULES)) await knex.schema.dropTable(RULES);

  if (!(await knex.schema.hasTable(ASSIGNMENTS))) return;
  if (await knex.schema.hasColumn(ASSIGNMENTS, "agent_id")) return;

  // The agent an assignment named is recoverable, because the region names
  // exactly one. An assignment for a region with no agent has nothing to point
  // at and is dropped, which is the same loss the forward migration describes.
  await knex.schema.alterTable(ASSIGNMENTS, (table) => {
    table.integer("agent_id").nullable();
  });
  await knex(ASSIGNMENTS).update({
    agent_id: knex("probe_agents").select("id").whereRaw(`probe_agents.region_id = ${ASSIGNMENTS}.region_id`),
  });
  await knex(ASSIGNMENTS).whereNull("agent_id").delete();
  await knex.schema.alterTable(ASSIGNMENTS, (table) => {
    table.dropUnique(["monitor_tag", "region_id"], "monitor_probe_assignments_tag_region_unique");
    table.dropIndex(["region_id"], "idx_monitor_probe_assignments_region_id");
  });
  await knex.schema.alterTable(ASSIGNMENTS, (table) => {
    table.dropColumn("region_id");
    table.dropColumn("source");
  });
  await knex.schema.alterTable(ASSIGNMENTS, (table) => {
    table.unique(["monitor_tag", "agent_id"], { indexName: "monitor_probe_assignments_tag_agent_unique" });
  });
}
