import type { Knex } from "knex";

// B1g. How much say one agent has among the others in its own region.
//
// **What this does not change.** A region still votes exactly once in the outer
// merge. Its influence still does not depend on how many boxes are deployed
// there, and `monitoring_data`'s `(monitor_tag, region_id, timestamp)` key still
// holds one row per region per minute. This weight applies only inside
// `mergeRegionAgents`, where a region settles its own answer before that single
// vote is cast.
//
// **Why it is worth a column.** B1f made agents in a region strict equal peers
// and told operators that wanting different weights meant wanting two regions.
// That advice is wrong in the one case it most often comes up: a datacentre
// probe and a residential box can both legitimately report for Frankfurt while
// deserving different say, and splitting them into two regions to express that
// would double Frankfurt's weight in the outer merge, which is precisely what
// B1f exists to prevent.
//
// **1 on every existing row, so nothing moves.** Equal weights reduce to the
// behaviour shipped in B1f exactly, and an operator who wants otherwise opts in
// per agent.
//
// Zero is a legal, meaningful value: an agent that reports and is recorded but
// cannot carry a vote among its peers. It is not the same as `DISPLAY_ONLY`,
// which is a region-level mode.

const TABLE = "probe_agents";
const COLUMN = "weight";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return;

  await knex.schema.alterTable(TABLE, (table) => {
    // Integer rather than float, matching `probe_region_rules.default_weight`
    // and `monitor_probe_overrides.weight` beside it. Relative size is all the
    // tally uses, so fractions buy nothing and compare badly.
    table.integer(COLUMN).notNullable().defaultTo(1);
  });
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.dropColumn(COLUMN);
  });
}
