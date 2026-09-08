import type { Knex } from "knex";

// Seeds `site_data.mfaPolicy`.
//
// `local_only` on purpose. Users who sign in through an identity provider
// already cleared whatever factors that provider requires, and demanding a
// second Kener-managed factor on top is the kind of friction that gets MFA
// turned off entirely. An operator who wants it everywhere sets `all`.
//
// Exists as a row rather than only as a code default so the value is visible and
// changeable, and so a fresh install has something for the settings screen to
// render.

const KEY = "mfaPolicy";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("site_data"))) return;

  // Never overwrite: migrations re-run on every boot, and an operator who set
  // this must not have it undone by a redeploy.
  const existing = await knex("site_data").where({ key: KEY }).first();
  if (existing) return;

  await knex("site_data").insert([{ key: KEY, value: "local_only", data_type: "string" }]);
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("site_data"))) return;
  await knex("site_data").where({ key: KEY }).del();
}
