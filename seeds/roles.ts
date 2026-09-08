import type { Knex } from "knex";
import { permissions } from "../src/lib/allPerms.ts";
import { orgPermissions, orgPermissionIds } from "../src/lib/orgPerms.ts";
import { provisionOrgRoles, roleIdFor, DEFAULT_ORG_ID } from "../src/lib/server/db/provisionOrg.ts";

/**
 * Seeds the three readonly roles (admin, editor, member),
 * assigns permissions to each role in roles_permissions,
 * and migrates existing users.role → users_roles.
 *
 * Permission mapping derived from src/routes/(manage)/manage/api/+server.ts:
 *
 * admin  → all permissions
 * editor → all except api_keys.delete (AdminCan-only)
 * member → all .read permissions only
 */

const readonlyRoles = [
  { id: "admin", role_name: "Administrator" },
  { id: "editor", role_name: "Editor" },
  { id: "member", role_name: "Member" },
];

const allPermissionIds = permissions.map((p) => p.id);
const readPermissionIds = allPermissionIds.filter((id) => id.endsWith(".read"));

// Fork permissions (orgPerms.ts) are granted to `admin` only, and deliberately
// NOT fanned out by the ".read goes to member" rule that applies to upstream's.
// `audit.read` would otherwise reach every member purely because of how it is
// spelled, which is a real decision about who can see who did what, and it
// should be made by an operator rather than by a naming coincidence.
const orgIds = orgPermissions.map((p) => p.id);

const rolePermissions: Record<string, string[]> = {
  admin: [...allPermissionIds, ...orgIds],
  editor: allPermissionIds.filter((id) => id !== "api_keys.delete"),
  member: readPermissionIds,
};

export async function seed(knex: Knex): Promise<void> {
  // 1. The default org's roles and grants. Shared with org creation (I3f) so a
  //    new org is provisioned by the same code a fresh install runs, rather than
  //    a second copy of it that drifts.
  await provisionOrgRoles(knex, DEFAULT_ORG_ID);

  // 2. Reconcile removals for the default org. Granting is `provisionOrgRoles`'
  //    job; this is the half that takes a permission away again when the seed
  //    mapping drops it.
  const existingPermRows: Array<{ id: string }> = await knex("permissions").select("id");
  const existingPermIds = new Set(existingPermRows.map((p) => p.id));

  for (const [roleKey, permissionIds] of Object.entries(rolePermissions)) {
    const roleId = roleIdFor(DEFAULT_ORG_ID, roleKey);
    const validPermissionIds = permissionIds.filter((id) => existingPermIds.has(id));

    const existingPerms: Array<{ permissions_id: string }> = await knex("roles_permissions")
      .where("roles_id", roleId)
      .select("permissions_id");

    // Remove permissions no longer assigned to this role.
    //
    // Fork permissions are exempt. Seeds re-run on every boot, so without this
    // an operator granting `audit.read` to `editor` would have it stripped at
    // the next restart, with no error and no way to make it stick. Upstream
    // permissions keep their existing reconcile-to-the-seed behaviour, so this
    // changes nothing about how upstream's roles are managed.
    const desiredSet = new Set(validPermissionIds);
    const toRemove = existingPerms
      .filter((e) => !desiredSet.has(e.permissions_id) && !orgPermissionIds.has(e.permissions_id))
      .map((e) => e.permissions_id);
    if (toRemove.length > 0) {
      await knex("roles_permissions").where("roles_id", roleId).whereIn("permissions_id", toRemove).del();
    }
  }

  // 3. Migrate existing users: read users.role → insert into users_roles
  const hasRoleColumn = await knex.schema.hasColumn("users", "role");
  if (hasRoleColumn) {
    const users: Array<{ id: number; role: string }> = await knex("users").select("id", "role");

    for (const user of users) {
      if (!user.role) continue;

      // Only migrate if a matching role exists
      const roleExists = await knex("roles").where("id", user.role).first();
      if (!roleExists) continue;

      // Skip if already assigned
      const existing = await knex("users_roles").where({ roles_id: user.role, users_id: user.id }).first();
      if (!existing) {
        await knex("users_roles").insert({
          roles_id: user.role,
          users_id: user.id,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        });
      }
    }
  }
}
