import type { Knex } from "knex";

// B1d: the local check becomes a source, and the three-level merge cascade.
//
// **What this changes about region 0.** B1a established that region 0 is the
// merged, authoritative verdict and that every read in Kener goes through it.
// That stays exactly true. What changes is who writes it: until now the local
// check wrote region 0 directly, so "merged verdict" and "whichever source was
// authoritative" were the same row by accident. From here region 0 is
// *computed*, and the local check reports at its own region like any probe.
//
// No backfill, and none is needed. Historic region-0 rows were the verdict at
// the time, because there was only ever one source. They stay the verdict.
//
// **Everything here is additive.** Two new tables, three nullable columns and
// one catalogue row. Nothing is dropped, nothing becomes NOT NULL, no key moves.
// An instance that never configures a policy behaves exactly as it did, because
// every new column is null and null means "inherit", and inheriting the shipped
// defaults reproduces B1c's behaviour.

const REGIONS = "regions";
const MERGE_POLICIES = "monitor_merge_policies";
const SOURCE_POLICIES = "monitor_source_policies";

/**
 * The local check's region.
 *
 * Mirrors `LOCAL_REGION_ID` in `src/lib/server/probes/merge.ts`. It cannot
 * import it: a migration has to keep working against a checkout of `src/` from
 * any later point in time, so it stays self-contained.
 *
 * Negative on purpose. `regions.id` is an `increments` column, so a generated id
 * is always positive and -1 can never be handed out to a probe region. Claiming
 * it by hand neither consumes nor skips a sequence value, exactly as B1a's
 * region 0 does.
 */
const LOCAL_REGION_ID = -1;

/** Mirrors `DEFAULT_ORG_ID`. See `20260909100000`. */
const DEFAULT_ORG_ID = 1;

/**
 * Postgres is the only dialect that gets foreign keys here.
 *
 * Same reasoning as `20260909100000`, restated because it is load-bearing and a
 * reader of this file should not have to go and find it: on SQLite, knex
 * implements an added constraint as a table rebuild, and this codebase never
 * turns the `foreign_keys` pragma on, so the constraint would cost a rewrite and
 * buy nothing. On Postgres it is catalogue-only over an empty table.
 */
function supportsSafeForeignKeys(knex: Knex): boolean {
  return knex.client.config.client === "pg";
}

export async function up(knex: Knex): Promise<void> {
  // ---- 1. The local source, as a catalogue row ---------------------------
  //
  // A row rather than a bare constant so the admin screen can show "Local
  // check" beside the probe regions and give it a weight and a trust rank
  // through the same form, instead of every screen special-casing it.
  if (await knex.schema.hasTable(REGIONS)) {
    const local = await knex(REGIONS).where("id", LOCAL_REGION_ID).first();
    if (!local) {
      await knex(REGIONS).insert({
        id: LOCAL_REGION_ID,
        // Instance-wide like region 0, not a tenant's. Every org's local check
        // is the same server.
        org_id: null,
        code: "local",
        name: "Local check",
        description:
          "The check Kener runs from its own server. Before B1d this wrote the merged verdict directly; it is now one source among several, and region 0 is computed from all of them.",
        is_active: true,
      });
    }

    // ---- 2. Per-region defaults for the cascade --------------------------
    //
    // Nullable, and null means "inherit the instance default". A zero default
    // weight would be a real configured value meaning "this region cannot carry
    // a vote", so the absence of a setting cannot be spelled 0.
    if (!(await knex.schema.hasColumn(REGIONS, "default_weight"))) {
      await knex.schema.alterTable(REGIONS, (table) => {
        table.integer("default_weight").nullable();
      });
    }
    if (!(await knex.schema.hasColumn(REGIONS, "default_trust_rank"))) {
      await knex.schema.alterTable(REGIONS, (table) => {
        // Lower is more trusted, like a nice value.
        table.integer("default_trust_rank").nullable();
      });
    }
    if (!(await knex.schema.hasColumn(REGIONS, "default_mode"))) {
      await knex.schema.alterTable(REGIONS, (table) => {
        // VOTE | DISPLAY_ONLY | OFF. A string rather than a boolean pair
        // because "recorded but does not vote" and "not run at all" are
        // genuinely different states and two booleans can express a fourth,
        // meaningless combination.
        table.string("default_mode", 32).nullable();
      });
    }
  }

  // ---- 3. The per-monitor policy override --------------------------------
  //
  // Its own table rather than columns on `monitors`. `monitors` is one of the
  // most upstream-churned files and tables in the schema, and a fork-only
  // policy has no business widening it: every future sync would meet three
  // columns upstream has never heard of. A row here exists only for a monitor
  // that actually overrides something.
  if (!(await knex.schema.hasTable(MERGE_POLICIES))) {
    await knex.schema.createTable(MERGE_POLICIES, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable().defaultTo(DEFAULT_ORG_ID);
      table.string("monitor_tag", 255).notNullable();

      // All three nullable: a monitor may override the policy and inherit the
      // quorum, or the other way round. Null is "ask the level above".
      table.string("policy", 32).nullable();
      table.integer("quorum_threshold").nullable();
      table.boolean("degraded_on_disagreement").nullable();

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });

    await knex.schema.alterTable(MERGE_POLICIES, (table) => {
      table.index(["org_id"], "idx_monitor_merge_policies_org_id");
      // One override row per monitor. `monitor_tag` is globally unique, so the
      // org is here for scoping and not for identity - the same shape
      // `monitor_probe_assignments` uses.
      table.unique(["monitor_tag"], { indexName: "monitor_merge_policies_tag_unique" });
    });

    if (supportsSafeForeignKeys(knex)) {
      await knex.schema.alterTable(MERGE_POLICIES, (table) => {
        table.foreign("org_id").references("id").inTable("orgs").onDelete("CASCADE");
      });
    }
  }

  // ---- 4. The per-monitor, per-source override ---------------------------
  //
  // This is the table that answers "for this one provider, trust the Frankfurt
  // probe over the local check". `region_id` is -1 for the local source, which
  // is the whole reason local needed a region of its own: without one there is
  // no key to hang its per-monitor weight on.
  if (!(await knex.schema.hasTable(SOURCE_POLICIES))) {
    await knex.schema.createTable(SOURCE_POLICIES, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable().defaultTo(DEFAULT_ORG_ID);
      table.string("monitor_tag", 255).notNullable();
      table.integer("region_id").notNullable();

      // Null means "inherit the region's default", which in turn may be null and
      // mean "inherit the instance default".
      table.integer("weight").nullable();
      table.integer("trust_rank").nullable();
      table.string("mode", 32).nullable();

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });

    await knex.schema.alterTable(SOURCE_POLICIES, (table) => {
      table.index(["org_id"], "idx_monitor_source_policies_org_id");
      table.index(["monitor_tag"], "idx_monitor_source_policies_tag");
      table.unique(["monitor_tag", "region_id"], {
        indexName: "monitor_source_policies_tag_region_unique",
      });
    });

    if (supportsSafeForeignKeys(knex)) {
      await knex.schema.alterTable(SOURCE_POLICIES, (table) => {
        table.foreign("org_id").references("id").inTable("orgs").onDelete("CASCADE");
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Both tables are new and nothing references them, so dropping them loses
  // only the overrides themselves. The region columns and the `local` catalogue
  // row are left in place deliberately: `monitoring_data` rows written at region
  // -1 while this was up would otherwise name a region that no longer exists,
  // and an orphaned sample is worse than an unused column.
  await knex.schema.dropTableIfExists(SOURCE_POLICIES);
  await knex.schema.dropTableIfExists(MERGE_POLICIES);
}
