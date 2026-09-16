import type { Knex } from "knex";

// B12a: one service, several regional endpoints.
//
// **The shape, and the trap it exists to avoid.** `monitoring_data` is keyed
// `(monitor_tag, region_id, timestamp)` and that `region_id` is the PROBE
// region. Target regions are a SECOND axis: three regional endpoints checked
// from two probe vantage points is six samples a minute, which does not fit a
// key holding one region column. Making a target anything other than an ordinary
// monitor_tag would put a fourth column into the primary key of the largest
// table in the schema.
//
// So a regional target IS an ordinary monitor, with its own tag and its own
// rows, and this table is only the relationship. `monitoring_data`, the rollups,
// probe assignment and the whole execution path keep working unchanged and the
// probe axis stays exactly what it always was.
//
// **A table rather than a JSON column on the parent**, unlike `GROUP` monitors,
// which keep their members in `type_data`. Two reasons, and the first is the one
// that matters: the region is a FOREIGN KEY here, so a region cannot be deleted
// out from under a service that targets it without the database saying so, and
// "which region is this endpoint in" is never parsed back out of a derived tag.
// The second is that this is queried from the child's side as often as the
// parent's ("what is this hidden monitor, and whose is it"), which a JSON blob
// on the parent answers only by scanning every parent.
const TABLE = "monitor_region_targets";

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (table) => {
    table.increments("id").primary();
    // Nullable to match every other org-scoped table in this schema, where NULL
    // means a row that predates org scoping rather than a row belonging to
    // nobody. `BaseRepository` applies the scope.
    table.integer("org_id").nullable();

    // TAGS, not ids, matching `webhook_endpoint_scopes` and for the same reason:
    // the tag is the physical key this codebase passes around, it is what
    // `monitoring_data` is keyed by, and storing ids would mean a join to answer
    // a question every caller already holds the answer to.
    table.string("parent_tag", 255).notNullable();
    table.string("child_tag", 255).notNullable();

    // Where the endpoint IS. A foreign key rather than a string, because unlike
    // a monitor tag a region is a row an operator renames, and the name is not
    // the identity.
    table.integer("region_id").notNullable();

    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.timestamp("updated_at").defaultTo(knex.fn.now());

    // **One endpoint per region per service.** This is the model rather than a
    // nicety: two endpoints in one region is two services or one service with a
    // load balancer, and either way the fixed rollup rule ("all up is UP, some
    // down is DEGRADED") has no answer for a region that is half down.
    table.unique(["parent_tag", "region_id"], { indexName: "uq_monitor_region_targets_parent_region" });

    // **A child belongs to exactly one parent.** Without this a monitor could be
    // a regional endpoint of two services at once, and its status would roll up
    // into both while the operator could only see it under one.
    table.unique(["child_tag"], { indexName: "uq_monitor_region_targets_child" });

    // The parent's own lookup: every target of one service, on every render.
    table.index(["parent_tag"], "idx_monitor_region_targets_parent");

    // RESTRICT rather than CASCADE, and it is the opposite choice from
    // `webhook_endpoint_scopes`. A scope is configuration and is meaningless
    // without its endpoint; this row is the only record that a monitor holding
    // ninety days of history is part of a service. Deleting the region out from
    // under it must fail loudly and be resolved by an operator, rather than
    // silently orphaning an endpoint nothing then rolls up.
    table.foreign("region_id").references("id").inTable("regions").onDelete("RESTRICT");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
