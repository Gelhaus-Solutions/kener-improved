import type { Knex } from "knex";
import { permissions } from "../src/lib/allPerms.ts";
import { orgPermissions } from "../src/lib/orgPerms.ts";

// Upstream's permissions plus the fork's. The merge has to happen here and not
// in allPerms.ts, which stays byte-identical to upstream; see orgPerms.ts.
//
// This is not optional. The reconciliation below deletes any permission row not
// in this list, so an unmerged list would delete every fork permission on every
// boot, silently taking its grants with it.
const allSeededPermissions = [...permissions, ...orgPermissions];

export async function seed(knex: Knex): Promise<void> {
  const permissionIds = new Set(allSeededPermissions.map((p) => p.id));

  // Get all existing permissions
  const existing: Array<{ id: string }> = await knex("permissions").select("id");
  const existingIds = new Set(existing.map((e) => e.id));

  // Insert missing permissions
  for (const perm of allSeededPermissions) {
    if (!existingIds.has(perm.id)) {
      await knex("permissions").insert({
        id: perm.id,
        permission_name: perm.permission_name,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }
  }

  // Delete permissions that are no longer in the seed list
  const toDelete = existing.filter((e) => !permissionIds.has(e.id)).map((e) => e.id);
  if (toDelete.length > 0) {
    await knex("permissions").whereIn("id", toDelete).del();
  }
}
