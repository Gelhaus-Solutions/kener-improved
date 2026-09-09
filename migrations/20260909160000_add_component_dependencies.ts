import type { Knex } from "knex";

// C3: the dependency graph, and per-component rollup settings.
//
// **This is status *metadata*, not a status producer.** The distinction matters
// because Kener already has something that looks similar and is not:
// `services/groupCall.ts` is a monitor *type*, which at check time reads each
// member's last cached value out of Redis and returns a `MonitoringResult`. It
// produces a status. The graph here is read at page-render time to answer "what
// does this component depend on", "what does this failure affect", and "what
// should this parent show given its children". The two must not be merged, and
// `GroupCall` is deliberately not touched by this migration or by the code that
// reads these tables.
//
// **Why `monitor_rollup_settings` is a side table rather than columns on
// `monitors`.** `appScheduler.ts` computes `hash = tag + "::" +
// HashString(JSON.stringify(monitor))` and tears down and recreates that
// monitor's BullMQ scheduler whenever the hash changes. Any new column on
// `monitors` would therefore churn every scheduler on every unrelated edit -
// including one that only changed a rollup mode. This rule applies to all new
// per-monitor configuration, not just this item.

const DEPENDENCIES = "component_dependencies";
const ROLLUP_SETTINGS = "monitor_rollup_settings";

interface GroupMember {
  tag?: string;
  weight?: number;
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(DEPENDENCIES))) {
    await knex.schema.createTable(DEPENDENCIES, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable();
      table.string("parent_monitor_tag", 255).notNullable();
      table.string("child_monitor_tag", 255).notNullable();
      // CONTAINS: the parent is made of the child. DEPENDS_ON: the parent needs
      // the child but is not composed of it. Both propagate; they differ in what
      // the "what does this affect" view says about them.
      table.string("relation", 20).notNullable().defaultTo("CONTAINS");
      // Per edge, so one parent can inherit hard from one child and softly from
      // another. NONE records the relationship without letting it propagate.
      table.string("propagation", 20).notNullable().defaultTo("WORST");
      table.float("weight").notNullable().defaultTo(1);
      table.timestamp("created_at").defaultTo(knex.fn.now());
      table.timestamp("updated_at").defaultTo(knex.fn.now());

      // Inline foreign keys on a table being *created* are safe on both
      // dialects. The SQLite rebuild hazard is specific to adding one to a table
      // that already exists, which is an ALTER implemented as a rebuild.
      table.foreign("parent_monitor_tag").references("tag").inTable("monitors").onDelete("CASCADE");
      table.foreign("child_monitor_tag").references("tag").inTable("monitors").onDelete("CASCADE");

      table.unique(["parent_monitor_tag", "child_monitor_tag", "relation"], {
        indexName: "component_dependencies_parent_child_relation_unique",
      });
      table.index(["org_id"], "idx_component_dependencies_org_id");
      table.index(["child_monitor_tag"], "idx_component_dependencies_child");
    });
  }

  if (!(await knex.schema.hasTable(ROLLUP_SETTINGS))) {
    await knex.schema.createTable(ROLLUP_SETTINGS, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable();
      table.string("monitor_tag", 255).notNullable();
      // NONE | WORST | WEIGHTED. NONE means this component reports only itself.
      table.string("rollup_mode", 20).notNullable().defaultTo("NONE");

      /**
       * Pins this component's reported status, whatever its children say.
       *
       * A *different* thing from `incidents.impact_override`, which answers
       * "this incident's impact is really X". This one answers "this component
       * is X regardless of what rolls up", with no incident involved - it is a
       * rollup control, and it outlives any single incident.
       */
      table.string("manual_override", 32).nullable();
      table.text("manual_override_reason").nullable();
      /**
       * When the pin lapses, in UTC seconds.
       *
       * The reason expiries exist at all: an override set during an outage and
       * never removed is a component that has quietly stopped reporting the
       * truth, and nothing about the screen would say so a month later. Null
       * means it does not lapse, which is allowed and should be rare.
       */
      table.integer("manual_override_expires_at").nullable();
      table.timestamp("created_at").defaultTo(knex.fn.now());
      table.timestamp("updated_at").defaultTo(knex.fn.now());

      table.foreign("monitor_tag").references("tag").inTable("monitors").onDelete("CASCADE");
      table.unique(["monitor_tag"], { indexName: "monitor_rollup_settings_monitor_tag_unique" });
      table.index(["org_id"], "idx_monitor_rollup_settings_org_id");
    });
  }

  // ---- seed the graph from existing GROUP monitors ------------------------
  //
  // Recorded so the graph describes the system as it actually is on day one,
  // rather than starting empty and waiting for someone to retype what
  // `type_data` already knows.
  //
  // **These rows change nothing.** A GROUP monitor's own status still comes from
  // `GroupCall`, and the rollup reader skips GROUP monitors precisely so that
  // stays true - see `incidents/rollup.ts`. The edges are here for the blast
  // radius view and for the day a GROUP monitor is converted.
  if (!(await knex.schema.hasTable("monitors"))) return;

  const groups = await knex("monitors").where("monitor_type", "GROUP").select("tag", "type_data", "org_id");
  for (const group of groups) {
    let members: GroupMember[] = [];
    try {
      const parsed = typeof group.type_data === "string" ? JSON.parse(group.type_data) : group.type_data;
      members = Array.isArray(parsed?.monitors) ? parsed.monitors : [];
    } catch {
      // A monitor whose type_data will not parse is one the group service cannot
      // run either. Skipped rather than failed: this migration must not be the
      // thing that refuses to boot over a row that was already broken.
      continue;
    }

    for (const member of members) {
      if (!member?.tag) continue;
      // The child must exist, or the foreign key rejects the insert and takes
      // the whole migration with it on Postgres, where a failed statement aborts
      // the transaction.
      const child = await knex("monitors").where("tag", member.tag).first();
      if (!child) continue;

      const existing = await knex(DEPENDENCIES)
        .where({ parent_monitor_tag: group.tag, child_monitor_tag: member.tag, relation: "CONTAINS" })
        .first();
      if (existing) continue;

      await knex(DEPENDENCIES).insert({
        org_id: group.org_id ?? 1,
        parent_monitor_tag: group.tag,
        child_monitor_tag: member.tag,
        relation: "CONTAINS",
        propagation: "WEIGHTED",
        weight: typeof member.weight === "number" ? member.weight : 1,
      });
    }

    if (members.length === 0) continue;
    const settings = await knex(ROLLUP_SETTINGS).where("monitor_tag", group.tag).first();
    if (settings) continue;
    await knex(ROLLUP_SETTINGS).insert({
      org_id: group.org_id ?? 1,
      monitor_tag: group.tag,
      rollup_mode: "WEIGHTED",
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(DEPENDENCIES);
  await knex.schema.dropTableIfExists(ROLLUP_SETTINGS);
}
