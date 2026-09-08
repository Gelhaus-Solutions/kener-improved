import type { Knex } from "knex";
import monitorSeed from "./seedMonitorData.ts";
import { permissions } from "../../allPerms.ts";
import { orgPermissions } from "../../orgPerms.ts";

/**
 * Seeding a single organisation.
 *
 * The seeds under `seeds/` all asked "is this table empty?" and stopped there.
 * That was correct while there was exactly one org and is wrong the moment there
 * are two: the second org would find the table non-empty and silently provision
 * nothing, arriving with no monitors and no roles. Every check is now scoped to
 * an org, and the per-org work lives here so that creating an org (I3f) runs the
 * same code a fresh install does rather than a second copy of it that drifts.
 *
 * **What this deliberately does NOT provision, and why.**
 *
 * `pages.page_path`, `site_data.key` and `general_email_templates.template_id`
 * are still **globally** unique, so a second org's home page (path `""`) or its
 * copy of `siteName` would collide with the default org's on insert. Those
 * unique keys become per-org in I3b, and the corresponding provisioning belongs
 * with them. Attempting it here would either throw or, worse, silently attach
 * the default org's page to a new tenant.
 *
 * Until then `provisionOrg` is complete for what it covers and honest about the
 * rest: `provisionOrgPages` does not exist yet on purpose.
 */

/** The org that owns everything predating tenancy. Mirrors `DEFAULT_ORG_ID` in eventContext.ts. */
export const DEFAULT_ORG_ID = 1;

/** The three roles every org gets, matching what `seeds/roles.ts` has always created. */
const READONLY_ROLES = [
  { key: "admin", role_name: "Administrator" },
  { key: "editor", role_name: "Editor" },
  { key: "member", role_name: "Member" },
];

const allPermissionIds = permissions.map((p) => p.id);
const readPermissionIds = allPermissionIds.filter((id) => id.endsWith(".read"));
const orgPermissionIdList = orgPermissions.map((p) => p.id);

/**
 * Which permissions each role key gets.
 *
 * Identical to the mapping `seeds/roles.ts` has always used, including the
 * deliberate choice not to fan fork permissions out to `member` by the
 * ".read goes to member" rule: `audit.read` reaching everybody because of how it
 * is spelled is a real access decision, not a naming coincidence.
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [...allPermissionIds, ...orgPermissionIdList],
  editor: allPermissionIds.filter((id) => id !== "api_keys.delete"),
  member: readPermissionIds,
};

/**
 * The primary key for a role in an org.
 *
 * The default org keeps the bare keys (`admin`), which is what makes this
 * migration invisible: every existing `users_roles` row, every seed and every
 * `getRoleById` call site keeps working untouched. Later orgs get namespaced
 * ids so the global string primary key still holds, while `role_key` carries
 * the name the UI shows.
 */
export function roleIdFor(orgId: number, roleKey: string): string {
  return orgId === DEFAULT_ORG_ID ? roleKey : `o${orgId}_${roleKey}`;
}

/** Creates this org's roles and grants, without disturbing any other org's. */
export async function provisionOrgRoles(knex: Knex, orgId: number): Promise<void> {
  const existingPermRows: Array<{ id: string }> = await knex("permissions").select("id");
  const existingPermIds = new Set(existingPermRows.map((p) => p.id));

  for (const role of READONLY_ROLES) {
    const roleId = roleIdFor(orgId, role.key);

    const existing = await knex("roles").where("id", roleId).first();
    if (!existing) {
      await knex("roles").insert({
        id: roleId,
        role_key: role.key,
        org_id: orgId,
        role_name: role.role_name,
        readonly: 1,
        status: "ACTIVE",
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }

    // Only grant permissions that exist, so this is safe to run before or after
    // the permissions vocabulary is seeded.
    const wanted = (ROLE_PERMISSIONS[role.key] ?? []).filter((id) => existingPermIds.has(id));
    const held: Array<{ permissions_id: string }> = await knex("roles_permissions")
      .where("roles_id", roleId)
      .select("permissions_id");
    const heldSet = new Set(held.map((h) => h.permissions_id));

    for (const permissionId of wanted) {
      if (heldSet.has(permissionId)) continue;
      await knex("roles_permissions").insert({
        roles_id: roleId,
        permissions_id: permissionId,
        org_id: orgId,
        status: "ACTIVE",
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }
  }
}

/**
 * Creates this org's starter monitors.
 *
 * `tag` is built from the org's `tag_prefix` plus the slug, which is what keeps
 * it globally unique across orgs while the slug stays the per-org name. The
 * default org's prefix is empty, so its tags are exactly the slugs and are
 * byte-identical to what every existing install already has.
 */
export async function provisionOrgMonitors(knex: Knex, orgId: number): Promise<void> {
  const org = await knex("orgs").where("id", orgId).first();
  const prefix: string = org?.tag_prefix ?? "";

  const existing = await knex("monitors").where("org_id", orgId).count({ c: "*" }).first();
  if (Number((existing as { c: string | number } | undefined)?.c ?? 0) > 0) return;

  for (const monitor of monitorSeed) {
    const slug = monitor.tag;
    const tag = prefix ? `${prefix}_${slug}` : slug;

    await knex("monitors").insert({
      org_id: orgId,
      tag,
      slug,
      name: monitor.name,
      description: monitor.description,
      image: monitor.image,
      cron: monitor.cron,
      default_status: monitor.default_status,
      status: monitor.status,
      category_name: monitor.category_name,
      monitor_type: monitor.monitor_type,
      type_data: monitor.type_data,
      day_degraded_minimum_count: monitor.day_degraded_minimum_count,
      day_down_minimum_count: monitor.day_down_minimum_count,
      include_degraded_in_downtime: monitor.include_degraded_in_downtime,
      is_hidden: monitor.is_hidden || "NO",
      monitor_settings_json: monitor.monitor_settings_json || null,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
  }
}

/**
 * Everything a newly created org needs to be usable.
 *
 * I3f calls this when an operator creates an org. It is deliberately unused
 * until then: extracting it now, while there is still exactly one org and the
 * behaviour can be compared against the old seeds row for row, is far safer than
 * retrofitting it alongside the UI that first depends on it.
 */
export async function provisionOrg(knex: Knex, orgId: number): Promise<void> {
  await provisionOrgRoles(knex, orgId);
  await provisionOrgMonitors(knex, orgId);
  // Pages, site_data and email templates wait for I3b to make their unique keys
  // per-org. See the note at the top of this file.
}
