import type { Knex } from "knex";
import seedSiteData from "../src/lib/server/db/seedSiteData.ts";

// I3g: instance defaults for `site_data`, with per-org overrides.
//
// **The shape.** `org_id = 0` holds the instance layer. A read takes the
// instance rows and overlays the current org's on top, so an org stores a row
// only for a setting it has actually changed. A handful of keys go the other
// way entirely: they are instance-scoped, they live only at org 0, and an org
// row for one of them is not an override but a mistake.
//
// **Why not a new `org_settings` table.** `siteDataKeys.ts` and
// `siteDataController.ts` are upstream-churned files. Keeping the same table
// means neither needs a structural change; a new table would fork both hard and
// conflict on every sync.
//
// **This migration deletes rows, which nothing else here does.** Two kinds, and
// the distinction is the whole safety argument:
//
//   1. A row whose value is byte-identical to the shipped default carries no
//      decision. Nobody chose it; it is there because provisioning wrote every
//      key into every org. Deleting it changes no behaviour at all - the org
//      reads the same value from the instance layer afterwards - and it is what
//      turns the overlay from a no-op into the feature.
//   2. An org's row for an instance-scoped key. That one CAN carry a decision,
//      and deleting it is the point: the key is being declared not-theirs. The
//      default org's value is promoted to the instance layer first, so the
//      instance keeps whatever the operator had actually configured.
//
// Everything else - every value a tenant genuinely customised - is left exactly
// where it is and keeps winning over the instance layer.
//
// **Importing `src/` from a migration.** This file is the exception to the rule
// and it is a deliberate one. The whole migration turns on "is this row equal to
// the shipped default", and the shipped defaults are `seedSiteData`. Copying
// ~57 keys in here would freeze them at today's values, which is fine for the
// comparison but means a reader has two lists to keep in sync and no way to tell
// when they drift. The risk the rule guards against is a migration breaking when
// `src/` moves underneath it; `seedSiteData.ts` is a literal object with no
// imports and no behaviour, so the blast radius is a key being added or removed,
// which changes only how many identical rows this collapses.

const SITE_DATA = "site_data";
const ORGS = "orgs";

/**
 * The org that holds instance-level values.
 *
 * Mirrors `INSTANCE_ORG_ID` in `src/lib/server/db/orgContext.ts`. Zero because
 * `orgs.id` is an `increments` column whose sequence starts at 1, so claiming it
 * by hand neither consumes nor skips a generated id - the same trick B1a used
 * for region 0.
 */
const INSTANCE_ORG_ID = 0;

/** Mirrors `DEFAULT_ORG_ID`. See `20260909100000`. */
const DEFAULT_ORG_ID = 1;

/**
 * Keys that belong to the instance and not to a tenant.
 *
 * Mirrors `INSTANCE_SCOPED_KEYS` in `src/lib/server/controllers/siteDataScope.ts`.
 * Each one decides something a tenant administrator must not be able to decide
 * for the whole instance:
 *
 *   - `oidcSettings`        the identity provider every login goes through.
 *   - `mfaPolicy`           whether a second factor is mandatory.
 *   - `dataRetentionPolicy` how long history is kept, which is the operator's
 *                           disk and the operator's bill.
 *   - `auditRetentionDays`  the same, for the record of who did what.
 *   - `eventBusConsumers`   whether customer notifications are sent at all.
 */
const INSTANCE_SCOPED_KEYS = [
  "oidcSettings",
  "mfaPolicy",
  "dataRetentionPolicy",
  "auditRetentionDays",
  "eventBusConsumers",
];

/**
 * Settings a one-off migration introduced rather than `seedSiteData`.
 *
 * Mirrors `MIGRATION_SEEDED_DEFAULTS` in `provisionOrg.ts`. They are here for
 * the same reason they are there: neither code fallback is the value the default
 * org actually got, so the instance layer has to be given them explicitly.
 */
const MIGRATION_SEEDED_DEFAULTS: Record<string, { value: string; data_type: string }> = {
  mfaPolicy: { value: "none", data_type: "string" },
  eventBusConsumers: {
    value: JSON.stringify({ audit: "live", webhook: "live", email: "live", subscribers: "shadow", triggers: "shadow" }),
    data_type: "object",
  },
};

/** The shipped default for every key, in the shape `site_data` stores. */
function shippedDefaults(): Record<string, { value: string; data_type: string }> {
  const defaults: Record<string, { value: string; data_type: string }> = { ...MIGRATION_SEEDED_DEFAULTS };
  const seeded = seedSiteData as Record<string, unknown>;
  for (const key of Object.keys(seeded)) {
    const value = seeded[key];
    const data_type = typeof value;
    defaults[key] = {
      value: data_type === "object" ? JSON.stringify(value) : String(value),
      data_type,
    };
  }
  return defaults;
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(SITE_DATA))) return;
  if (!(await knex.schema.hasColumn(SITE_DATA, "org_id"))) return;

  // ---- 1. The sentinel org ----------------------------------------------
  //
  // `site_data.org_id` carries a foreign key to `orgs` on Postgres, so the
  // instance layer needs a row to point at. It is not an organisation and must
  // never be treated as one: `status` is deliberately not ACTIVE, which is what
  // keeps it out of `getActiveOrgIds` and therefore out of every scheduler
  // fan-out without any of them having to know it exists.
  if (await knex.schema.hasTable(ORGS)) {
    const existing = await knex(ORGS).where({ id: INSTANCE_ORG_ID }).first();
    if (!existing) {
      await knex(ORGS).insert({
        id: INSTANCE_ORG_ID,
        slug: "__instance",
        name: "Instance defaults",
        status: "INSTANCE",
        is_default: false,
        // UNIQUE and NOT NULL, and it must never collide with a real org's. The
        // instance row owns no monitors, so this prefix is never built into a tag.
        tag_prefix: "__instance",
      });
    }
  }

  const defaults = shippedDefaults();

  // ---- 2. Fill the instance layer ---------------------------------------
  //
  // The shipped defaults first, so every key exists at org 0 even if no org ever
  // had a row for it. An instance layer with holes would make a missing key
  // ambiguous: "inherited" and "not configured anywhere" would look identical.
  for (const [key, entry] of Object.entries(defaults)) {
    const present = await knex(SITE_DATA).where({ key, org_id: INSTANCE_ORG_ID }).first();
    if (present) continue;
    await knex(SITE_DATA).insert({
      key,
      value: entry.value,
      data_type: entry.data_type,
      org_id: INSTANCE_ORG_ID,
    });
  }

  // ---- 3. Instance-scoped keys: promote, then clear ----------------------
  //
  // The default org's value wins over the shipped default, because it is the one
  // the operator actually configured - an OIDC issuer URL, a retention policy
  // they chose. Promoting it is what makes this migration invisible to a
  // single-tenant install: the instance keeps behaving exactly as it did.
  for (const key of INSTANCE_SCOPED_KEYS) {
    const fromDefaultOrg = await knex(SITE_DATA).where({ key, org_id: DEFAULT_ORG_ID }).first();
    if (fromDefaultOrg) {
      await knex(SITE_DATA)
        .where({ key, org_id: INSTANCE_ORG_ID })
        .update({ value: fromDefaultOrg.value, data_type: fromDefaultOrg.data_type });
    }

    // Every org's copy, the default org's included. These keys now live at org 0
    // and nothing reads them anywhere else, so leaving them would leave rows that
    // look authoritative and are not.
    await knex(SITE_DATA).whereNot({ org_id: INSTANCE_ORG_ID }).andWhere({ key }).delete();
  }

  // ---- 4. Collapse rows that only ever held the shipped default ----------
  //
  // Compared against the *shipped* default rather than against whatever org 0
  // now holds. Those are the same for every key except the instance-scoped ones,
  // which step 3 has already emptied - and using org 0's promoted value here
  // would delete a tenant's row for matching a value the default org chose,
  // which is a different and much less safe claim than "nobody ever changed it".
  const instanceScoped = new Set(INSTANCE_SCOPED_KEYS);
  for (const [key, entry] of Object.entries(defaults)) {
    if (instanceScoped.has(key)) continue;
    await knex(SITE_DATA).whereNot({ org_id: INSTANCE_ORG_ID }).andWhere({ key, value: entry.value }).delete();
  }
}

export async function down(knex: Knex): Promise<void> {
  // Push the instance layer back down into every org that is now inheriting it,
  // so a rollback leaves each org self-contained the way it was before. Without
  // this, rolling back would leave orgs with holes where they used to carry a
  // full copy, and the pre-I3g reader has no instance layer to fall back to.
  if (!(await knex.schema.hasTable(SITE_DATA))) return;

  const instanceRows: Array<{ key: string; value: string; data_type: string }> = await knex(SITE_DATA)
    .where({ org_id: INSTANCE_ORG_ID })
    .select("key", "value", "data_type");

  const orgIds: number[] = (await knex.schema.hasTable(ORGS))
    ? (await knex(ORGS).whereNot({ id: INSTANCE_ORG_ID }).select("id")).map((row: { id: number }) => Number(row.id))
    : [DEFAULT_ORG_ID];

  for (const orgId of orgIds) {
    for (const row of instanceRows) {
      const present = await knex(SITE_DATA).where({ key: row.key, org_id: orgId }).first();
      if (present) continue;
      await knex(SITE_DATA).insert({ key: row.key, value: row.value, data_type: row.data_type, org_id: orgId });
    }
  }

  await knex(SITE_DATA).where({ org_id: INSTANCE_ORG_ID }).delete();
  if (await knex.schema.hasTable(ORGS)) {
    await knex(ORGS).where({ id: INSTANCE_ORG_ID }).delete();
  }
}
