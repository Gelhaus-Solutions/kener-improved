import db from "../db/db.js";
import { DEFAULT_ORG_ID, runAcrossOrgs, runWithOrg } from "../db/orgContext.js";
import { GetUserPermissions } from "./userController.js";
import { roleIdFor } from "../db/provisionOrg.js";
import { invalidateOrgDomainCache } from "../http/orgResolve.js";
import type { OrgRecord } from "../db/repositories/orgs.js";

/**
 * Organisations, from the caller's point of view (I3f).
 *
 * Everything here answers a question about **the signed-in user's** relationship
 * to the orgs on this instance, which is why it lives in its own controller
 * rather than alongside the repository: the repository knows what rows exist,
 * and this knows which of them the caller is entitled to see or act in.
 *
 * The queries against `orgs` and `org_members` all run inside `runAcrossOrgs`,
 * for the reason spelled out on `OrgsRepository`: those tables are how an org is
 * *found*, so a query against them cannot be filtered by the org it is trying to
 * determine.
 */

export interface MyOrg {
  id: number;
  slug: string;
  name: string;
  is_owner: boolean;
  is_default: boolean;
}

/** The orgs the caller belongs to, in a shape the switcher can render. */
export async function GetMyOrgs(userId: number): Promise<MyOrg[]> {
  const rows = await runAcrossOrgs(() => db.getOrgsForUser(userId));
  return rows.map((org) => ({
    id: org.id,
    slug: org.slug,
    name: org.name,
    is_owner: !!org.is_org_owner,
    is_default: !!org.is_default,
  }));
}

/**
 * Whether the caller may create an organisation.
 *
 * **`orgs.write` held in the default org, not in whichever org they happen to be
 * acting in.** Roles are per-org, so the permission alone would let the
 * administrator of any tenant mint further tenants and own them - which is right
 * for an instance the operator runs for themselves, and wrong the moment a
 * tenant administers their own org. Membership of the default org is the closest
 * thing this schema has to "runs the instance", so that is what is asked.
 *
 * The check is deliberately not a permission id of its own. Inventing an
 * instance-level permission tier is I3g's problem, and one that wants doing
 * properly rather than as a side effect of the org switcher.
 */
export async function CanCreateOrg(userId: number): Promise<boolean> {
  const isInstanceOrg = await runAcrossOrgs(() => db.isOrgMember(DEFAULT_ORG_ID, userId));
  if (!isInstanceOrg) return false;

  const permissions = await runWithOrg(DEFAULT_ORG_ID, () => GetUserPermissions(userId));
  return permissions.has("orgs.write");
}

/** The org a session is acting in, resolved for display. Undefined if it is gone. */
export async function GetOrgById(orgId: number): Promise<OrgRecord | undefined> {
  return await runAcrossOrgs(() => db.getOrgById(orgId));
}

/**
 * Moves a session into another org.
 *
 * Membership is re-checked here rather than trusted from the list the UI was
 * rendered with: that list was built when the page loaded, and a membership can
 * be revoked between then and the click.
 *
 * Returns the permissions the caller will hold **in the org they are moving
 * to**, because roles are per-org and the screen they are looking at may not be
 * one they can reach there. The client uses it to pick where to land, and the
 * layout's own permission check is still what enforces it - this only spares the
 * user a 403 they can do nothing about.
 */
export async function SwitchOrg(
  sessionId: string,
  userId: number,
  orgId: number,
): Promise<{ org_id: number; permissions: string[] }> {
  const isMember = await runAcrossOrgs(() => db.isOrgMember(orgId, userId));
  if (!isMember) throw new Error("You are not a member of that organisation");

  await db.setSessionOrg(sessionId, orgId);

  const permissions = await runWithOrg(orgId, () => GetUserPermissions(userId));
  return { org_id: orgId, permissions: [...permissions] };
}

// ============ Administering an org (I3f) ============
//
// Everything below acts on **the org the caller is currently acting in**, never
// on an org named in the payload. That is the whole access model: the pipeline
// has already established the session's org and checked membership, so an action
// cannot reach sideways into a tenant the caller does not belong to, and no
// handler has to re-derive who is allowed what. Switching org is how you
// administer a different one.
//
// The one exception is creating an org, which by definition has no org to be in.

export interface OrgDetail {
  id: number;
  slug: string;
  name: string;
  tag_prefix: string;
  is_default: boolean;
  domains: Array<{ id: number; hostname: string; status: string }>;
}

/** The current org, with the hostnames that route to it. */
export async function GetOrgDetail(orgId: number): Promise<OrgDetail> {
  const [org, domains] = await Promise.all([
    runAcrossOrgs(() => db.getOrgById(orgId)),
    runAcrossOrgs(() => db.getOrgDomainsForOrg(orgId)),
  ]);
  if (!org) throw new Error("Organisation not found");

  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    tag_prefix: org.tag_prefix ?? "",
    is_default: !!org.is_default,
    domains: domains.map((d) => ({ id: d.id, hostname: d.hostname, status: d.status })),
  };
}

/**
 * A slug is what appears in `/o/<slug>/` and what `tag_prefix` is derived from,
 * so it has to survive being put in a URL and in a monitor tag unescaped.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function NormaliseSlug(input: string): string {
  const slug = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error("Slug must be 3-40 characters of lowercase letters, digits and hyphens");
  }
  return slug;
}

/**
 * Creates an organisation and makes the caller its owner.
 *
 * Three things happen and all three are necessary; an org missing any of them is
 * one nobody can administer:
 *
 *   1. the row, which is what `orgForHost` and `/o/<slug>/` resolve to
 *   2. `provisionOrg`, which gives it roles, monitors, a home page, settings and
 *      email templates - the same set a fresh install gets
 *   3. the creator's membership *and* their admin role **in the new org**
 *
 * Step 3 is the one that is easy to leave out and impossible to recover from
 * through the UI: roles are per-org, so without a `users_roles` row in the new
 * org the creator can switch into an org where they hold no permissions at all,
 * and no screen that could grant them any.
 *
 * `tag_prefix` defaults to the slug. It is what keeps `monitors.tag` globally
 * unique across orgs while `monitors.slug` stays the per-org name, so it is not
 * something an operator should have to think about.
 */
export async function CreateOrganisation(
  userId: number,
  input: { name: string; slug: string },
): Promise<{ id: number; slug: string; name: string }> {
  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 100) {
    throw new Error("Name must be between 2 and 100 characters");
  }
  const slug = NormaliseSlug(input.slug);

  const existing = await runAcrossOrgs(() => db.getOrgBySlug(slug));
  if (existing) throw new Error(`An organisation with the slug "${slug}" already exists`);

  const orgId = await runAcrossOrgs(() => db.createOrg({ slug, name, tag_prefix: slug }));

  await runAcrossOrgs(() => db.provisionNewOrg(orgId));

  await runAcrossOrgs(() => db.addOrgMember(orgId, userId, true));
  // Inside the new org, so the `users_roles` row is stamped with its id rather
  // than with the org the request happens to be running in.
  await runWithOrg(orgId, () => db.addUserToRole(roleIdFor(orgId, "admin"), userId));

  return { id: orgId, slug, name };
}

/**
 * Renames an org, or moves its `/o/<slug>/` path.
 *
 * `tag_prefix` is deliberately not editable. It is baked into every
 * `monitors.tag` the org already has, so changing it would either orphan every
 * monitor or require rewriting rows that other tables reference by tag.
 */
export async function UpdateOrganisation(orgId: number, input: { name?: string; slug?: string }): Promise<void> {
  const patch: { name?: string; slug?: string } = {};

  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (name.length < 2 || name.length > 100) {
      throw new Error("Name must be between 2 and 100 characters");
    }
    patch.name = name;
  }

  if (input.slug !== undefined) {
    const slug = NormaliseSlug(input.slug);
    const existing = await runAcrossOrgs(() => db.getOrgBySlug(slug));
    if (existing && existing.id !== orgId) {
      throw new Error(`An organisation with the slug "${slug}" already exists`);
    }
    patch.slug = slug;
  }

  if (Object.keys(patch).length === 0) return;
  await runAcrossOrgs(() => db.updateOrg(orgId, patch));
}

/** Hostnames are compared lowercased and without a port, exactly as `orgForHost` looks them up. */
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Points a hostname at this org.
 *
 * Added as ACTIVE, which is what makes it serve immediately. G4 is where a
 * verification step belongs; `org_domains.status` already carries the column for
 * it, and `getActiveOrgDomains` already refuses anything that is not ACTIVE, so
 * that change is a status value rather than a schema one.
 *
 * The host cache has to be invalidated by hand: it is a sixty-second in-process
 * map, and an operator who has just added a domain will try it immediately.
 */
export async function AddOrgDomain(orgId: number, hostname: string): Promise<void> {
  const host = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
  if (!HOSTNAME_PATTERN.test(host) || host.length > 253) {
    throw new Error("Enter a valid hostname, for example status.example.com");
  }

  const existing = await runAcrossOrgs(() => db.getOrgDomainByHostname(host));
  if (existing) {
    throw new Error(
      existing.org_id === orgId
        ? "That hostname is already pointed at this organisation"
        : "That hostname is already in use by another organisation",
    );
  }

  await runAcrossOrgs(() => db.addOrgDomain(orgId, host, "ACTIVE"));
  invalidateOrgDomainCache();
}

export async function RemoveOrgDomain(orgId: number, id: number): Promise<void> {
  await runAcrossOrgs(() => db.deleteOrgDomain(orgId, id));
  invalidateOrgDomainCache();
}

export interface OrgMember {
  user_id: number;
  email: string;
  name: string;
  is_active: boolean;
  is_owner: boolean;
  role_ids: string[];
}

/** The org's members, with the roles each holds **in this org**. */
export async function GetOrgMembers(orgId: number): Promise<OrgMember[]> {
  const rows = await runAcrossOrgs(() => db.getOrgMembersDetailed(orgId));
  // Roles are per-org, so this has to be asked inside the org, not across it.
  return await runWithOrg(orgId, async () =>
    Promise.all(
      rows.map(async (r) => ({
        user_id: r.user_id,
        email: r.email,
        name: r.name,
        is_active: !!r.is_active,
        is_owner: r.is_org_owner,
        role_ids: await db.getUserRoleIds(r.user_id),
      })),
    ),
  );
}

/**
 * Adds an existing instance user to this org, with a role in it.
 *
 * **By email, and only for a user who already exists.** Creating people is what
 * the Users screen and the invitation flow are for; this is the join between a
 * person and a tenant. A member added with no role would be a member who can
 * sign in, switch here and reach nothing, so the role is required rather than
 * optional.
 */
export async function AddOrgMember(
  orgId: number,
  input: { email: string; role_id: string; is_owner?: boolean },
): Promise<void> {
  const email = String(input.email ?? "")
    .trim()
    .toLowerCase();
  const user = await runAcrossOrgs(() => db.getUserByEmail(email));
  if (!user) throw new Error("No user on this instance has that email address");

  const role = await runWithOrg(orgId, () => db.getRoleById(input.role_id));
  if (!role) throw new Error("That role does not exist in this organisation");

  await runAcrossOrgs(() => db.addOrgMember(orgId, user.id, !!input.is_owner));
  await runWithOrg(orgId, async () => {
    const held = await db.getUserRoleIds(user.id);
    if (!held.includes(input.role_id)) await db.addUserToRole(input.role_id, user.id);
  });
}

/**
 * Promotes or demotes an owner.
 *
 * An org with no owner is an org nobody can hand over or administer at the org
 * level, so the last one cannot be demoted. The same rule guards removal.
 */
export async function SetOrgMemberOwner(orgId: number, userId: number, isOwner: boolean): Promise<void> {
  if (!isOwner) await AssertNotLastOwner(orgId, userId, "demoted");
  await runAcrossOrgs(() => db.setOrgMemberOwner(orgId, userId, isOwner));
}

/**
 * Removes a member from this org.
 *
 * Their roles in this org go with them: leaving `users_roles` behind would mean
 * a re-added member silently regaining permissions somebody had deliberately
 * taken away. The user themselves is untouched - they are one identity across
 * every org, and membership is what was revoked.
 */
export async function RemoveOrgMember(orgId: number, userId: number, actingUserId: number): Promise<void> {
  if (userId === actingUserId) {
    throw new Error("You cannot remove yourself from an organisation you are acting in");
  }
  await AssertNotLastOwner(orgId, userId, "removed");

  await runWithOrg(orgId, async () => {
    for (const roleId of await db.getUserRoleIds(userId)) {
      await db.removeUserFromRole(roleId, userId);
    }
  });
  await runAcrossOrgs(() => db.removeOrgMember(orgId, userId));
}

async function AssertNotLastOwner(orgId: number, userId: number, verb: string): Promise<void> {
  const membership = await runAcrossOrgs(() => db.getOrgMembership(orgId, userId));
  if (!membership?.is_org_owner) return;
  const owners = await runAcrossOrgs(() => db.countOrgOwners(orgId));
  if (owners <= 1) throw new Error(`The last owner of an organisation cannot be ${verb}`);
}
