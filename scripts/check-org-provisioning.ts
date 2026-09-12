/**
 * Checks that every org actually received what provisioning owes it (Z).
 *
 * `npm run db:check-orgs`
 *
 * **The gap this closes.** An org is provisioned once, by `provisionOrg`, on the
 * day it is created. Everything added to the product afterwards - a permission,
 * a `site_data` key, an email template - reaches an existing org only through
 * the three seeds that re-run at boot, and all three used to top up
 * `DEFAULT_ORG_ID` alone. Every tenant but the first was therefore a snapshot of
 * whatever the product looked like on its creation date.
 *
 * The visible version was `slo.read` and `reports.read`, added after the second
 * org existed: org 1 picked them up on the next boot and no other org ever did,
 * so the SLOs and Reports entries were simply absent from that tenant's sidebar.
 * `canReachRoute` fails closed and the manage layout *filters* unreachable nav
 * items out rather than disabling them, so there was nothing to see - no error,
 * no log, just a product that looked like it had never had the feature.
 *
 * The seeds now fan out and repair this at every boot, which makes it
 * self-healing. This makes it *checkable*, which is not the same thing: a
 * self-healing mechanism that has silently stopped healing looks exactly like
 * one that is working.
 *
 * **The default org is the reference, and that is deliberate.** Its roles are
 * checked against `ROLE_PERMISSIONS`, which is the authority; every other org is
 * then compared against org 1, which the seed guarantees is current. Restating
 * the expected `site_data` keys and template ids here would be a second copy of
 * a list that already exists twice, and a second copy is only ever a way to be
 * out of date - which is the whole shape of the bug being checked for.
 *
 * Exits non-zero on any gap, so it can be a deploy gate.
 */

import knexLib from "knex";
import type { Knex } from "knex";
import knexOb from "../knexfile.js";
import {
  DEFAULT_ORG_ID,
  ROLE_PERMISSIONS,
  roleIdFor,
  instanceSiteDataDefaults,
} from "../src/lib/server/db/provisionOrg.js";
import { INSTANCE_ORG_ID, INSTANCE_SCOPED_KEYS } from "../src/lib/server/controllers/siteDataScope.js";

let failures = 0;

function report(org: string, label: string, missing: string[]): void {
  if (missing.length === 0) return;
  failures += missing.length;
  console.log(`  FAIL ${org}: ${label} (${missing.length})`);
  const shown = missing.slice(0, 12);
  for (const item of shown.sort()) console.log(`         - ${item}`);
  if (missing.length > shown.length) console.log(`         ... and ${missing.length - shown.length} more`);
}

/** The permission ids a role holds, as rows rather than as intent. */
async function grantsFor(knex: Knex, roleId: string): Promise<Set<string>> {
  const rows: Array<{ permissions_id: string }> = await knex("roles_permissions")
    .where("roles_id", roleId)
    .select("permissions_id");
  return new Set(rows.map((row) => row.permissions_id));
}

async function keysFor(knex: Knex, table: string, column: string, orgId: number): Promise<Set<string>> {
  const rows = await knex(table).where("org_id", orgId).select(column);
  return new Set(rows.map((row: Record<string, unknown>) => String(row[column])));
}

async function main(): Promise<void> {
  const knex = knexLib(knexOb as unknown as Knex.Config);
  console.log(`\n=== db:check-orgs (${knexOb.databaseType}) ===`);

  try {
    if (!(await knex.schema.hasTable("orgs"))) {
      console.log("  No `orgs` table. Nothing to check on a pre-tenancy schema.\n");
      process.exit(0);
    }

    // The instance sentinel (I3g) holds the defaults every org inherits. It has
    // no roles, no monitors and no templates by design, so checking it against
    // the default org would report every one of them as a gap.
    const orgs: Array<{ id: number; slug: string; status: string }> = await knex("orgs")
      .whereNot({ id: INSTANCE_ORG_ID })
      .select("id", "slug", "status")
      .orderBy("id");
    console.log(`  ${orgs.length} org(s)\n`);

    const roleKeys = Object.keys(ROLE_PERMISSIONS);

    // Only permissions that exist can be granted, so an unseeded vocabulary is
    // not reported as a per-org gap - it would be every org at once, which is a
    // different and louder problem.
    const known = new Set((await knex("permissions").select("id")).map((row: { id: string }) => row.id));

    // ---- the reference org, against the authority --------------------------
    for (const roleKey of roleKeys) {
      const roleId = roleIdFor(DEFAULT_ORG_ID, roleKey);
      if (!(await knex("roles").where("id", roleId).first())) {
        report(`org ${DEFAULT_ORG_ID}`, `role "${roleId}" does not exist`, [roleId]);
        continue;
      }
      const held = await grantsFor(knex, roleId);
      const wanted = (ROLE_PERMISSIONS[roleKey] ?? []).filter((id) => known.has(id));
      report(`org ${DEFAULT_ORG_ID} (${roleId})`, "grants missing against ROLE_PERMISSIONS", [
        ...wanted.filter((id) => !held.has(id)),
      ]);
    }

    // ---- every other org, against the reference ----------------------------
    const referenceGrants = new Map<string, Set<string>>();
    for (const roleKey of roleKeys) {
      referenceGrants.set(roleKey, await grantsFor(knex, roleIdFor(DEFAULT_ORG_ID, roleKey)));
    }
    const referenceTemplates = await keysFor(knex, "general_email_templates", "template_id", DEFAULT_ORG_ID);

    for (const org of orgs) {
      if (Number(org.id) === DEFAULT_ORG_ID) continue;
      const label = `org ${org.id} (${org.slug}${org.status && org.status !== "ACTIVE" ? `, ${org.status}` : ""})`;

      for (const roleKey of roleKeys) {
        const roleId = roleIdFor(Number(org.id), roleKey);
        if (!(await knex("roles").where("id", roleId).first())) {
          report(label, `role "${roleId}" does not exist`, [roleId]);
          continue;
        }
        const held = await grantsFor(knex, roleId);
        const expected = referenceGrants.get(roleKey) ?? new Set<string>();
        report(label, `grants the default org's "${roleKey}" holds and this one does not`, [
          ...[...expected].filter((id) => !held.has(id)),
        ]);
      }

      const templates = await keysFor(knex, "general_email_templates", "template_id", Number(org.id));
      report(label, "email templates the default org has and this one does not", [
        ...[...referenceTemplates].filter((id) => !templates.has(id)),
      ]);
    }

    // ---- the instance layer (I3g) ------------------------------------------
    //
    // This replaces the old per-org `site_data` comparison, which compared every
    // org against the default org's copy. Under I3g neither carries a copy: both
    // inherit, and an org's rows are only its overrides. So comparing them is
    // now trivially true and says nothing.
    //
    // The invariant that matters instead is that the instance layer is
    // **complete** - it holds a row for every key the registry declares. A hole
    // there is the real failure: the setting falls back to whatever the reading
    // code happens to default to, silently and for every tenant at once, which
    // is precisely the class of bug this script exists to catch.
    // Against the defaults provisioning actually writes, not against the key
    // registry. `siteDataKeys` registers more keys than `seedSiteData` ships
    // values for - `monitorSort`, `incidentGroupView`, the captcha providers -
    // and those legitimately have no row until somebody sets one. Imported from
    // `provisionOrg` rather than restated, so the check cannot disagree with the
    // thing it checks.
    const instanceKeys = await keysFor(knex, "site_data", "key", INSTANCE_ORG_ID);
    report("instance layer", "site_data defaults missing from the instance layer", [
      ...Object.keys(instanceSiteDataDefaults()).filter((key) => !instanceKeys.has(key)),
    ]);

    // And nothing may hold an org-level row for a key the instance owns: such a
    // row is not an override, it is a value nothing reads.
    for (const key of INSTANCE_SCOPED_KEYS) {
      const strays: Array<{ org_id: number }> = await knex("site_data")
        .where({ key })
        .whereNot({ org_id: INSTANCE_ORG_ID })
        .select("org_id");
      report("instance layer", `org-level rows for the instance-scoped key "${key}"`, [
        ...strays.map((row) => `org ${row.org_id}`),
      ]);
    }

    console.log(
      failures === 0
        ? `\nALL PASS - every org holds everything provisioning owes it\n`
        : `\n${failures} GAP(S). These are repaired by the boot seeds; a deploy fixes them.\n`,
    );
  } finally {
    await knex.destroy();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
