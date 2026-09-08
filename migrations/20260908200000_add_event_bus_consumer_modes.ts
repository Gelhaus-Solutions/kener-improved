import type { Knex } from "knex";

// Seeds `site_data.eventBusConsumers`, the flag that decides what each event bus
// consumer is allowed to do.
//
// The point of putting this in the database rather than in an env var is that a
// flip is one row write, applied within the mode cache's ten seconds, with no
// deploy and no restart. That property is what makes "move notifications onto
// the bus" a reversible decision: if the new path is wrong, an operator undoes
// it in the time it takes to click a button, rather than in the time it takes to
// roll back a container.
//
// The values seeded here are the safe starting point and are deliberately not
// the end state:
//
//   audit        live    it is additive. Nothing was writing audit rows for
//                        API-driven or scheduler-driven changes before, so
//                        there is no old path to double up with.
//   webhook      live    E10 shipped it live and it has no legacy counterpart.
//   email        live    registered only so a subscriber email can be retried
//                        from the delivery log; it routes nothing itself.
//   subscribers  shadow  the real sends still come from subscriberQueue.
//   triggers     shadow  the real sends still come from alertingQueue.
//
// The shadow pair stays shadow through P3 and P4 and is flipped in P6, once the
// diff between what the consumer resolved and what the old path actually sent
// has been empty for long enough to believe it.
//
// Written as a seed rather than as a default in code because a value nobody can
// see is a value nobody will change. It exists as a row so the admin screen has
// something to render on a fresh install.

const KEY = "eventBusConsumers";

const DEFAULT_MODES = {
  audit: "live",
  webhook: "live",
  email: "live",
  subscribers: "shadow",
  triggers: "shadow",
};

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("site_data"))) return;

  // Never overwrite. An operator who has already flipped a consumer must not
  // have that undone by a redeploy running migrations again, and this migration
  // is re-run on every boot in exactly that way.
  const existing = await knex("site_data").where({ key: KEY }).first();
  if (existing) return;

  await knex("site_data").insert([
    {
      key: KEY,
      value: JSON.stringify(DEFAULT_MODES),
      // Matches how every other object-valued key is stored; GetSiteDataByKey
      // parses on this column and would hand back a string without it.
      data_type: "object",
    },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("site_data"))) return;
  await knex("site_data").where({ key: KEY }).del();
}
