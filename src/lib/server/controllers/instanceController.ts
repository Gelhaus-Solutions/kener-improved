import db from "../db/db.js";
import { DEFAULT_ORG_ID, runAcrossOrgs, runWithOrg } from "../db/orgContext.js";
import { invalidateOrgDomainCache } from "../http/orgResolve.js";
import type { UserRecordPublic } from "../types/db.js";

/**
 * The instance tier (KENER-31).
 *
 * **The one thing in this codebase that is not per-org.** Everything else asks
 * "what may this user do *here*", answered by a role held in the organisation
 * the session is acting in. This asks "does this user run the installation",
 * which no per-org role can answer without also handing every tenant
 * administrator the ability to grant it to themselves.
 *
 * `orgController.CanCreateOrg` names the same problem and works around it by
 * asking for `orgs.write` **held in the default org**, with a comment saying an
 * instance-level tier "is I3g's problem, and one that wants doing properly". This
 * is that tier, and the answer turned out to be that the schema already had it:
 * `users.is_owner` has meant the instance superadmin since P4, and is set by
 * `CreateFirstUser` and by nothing else. There is no screen, no action and no
 * role that can grant it, which is precisely the property an instance tier needs
 * and precisely what a permission id could never have.
 *
 * **Not a permission, deliberately.** Adding `instance.admin` to `orgPerms.ts`
 * would seed it into the vocabulary every org's role editor lists, and the first
 * tenant administrator to tick it would own the instance. The gate is a column
 * on the user, checked here, and nowhere else.
 *
 * Every read and write below therefore runs `runAcrossOrgs` or an explicit
 * `runWithOrg(target)`: this is the one caller in the codebase whose whole
 * purpose is to see across tenants, and it says so at every query rather than
 * inheriting a context and hoping.
 */

/** Whether this user runs the installation. The only definition, used everywhere. */
export function IsInstanceSuperadmin(user: Pick<UserRecordPublic, "is_owner"> | null | undefined): boolean {
  return user?.is_owner === "YES";
}

export interface InstanceOrgSummary {
  id: number;
  slug: string;
  name: string;
  status: string;
  is_default: boolean;
  tag_prefix: string;
  members: number;
  monitors: number;
  pages: number;
  domains: number;
}

/**
 * Every organisation on the instance, with the counts that say whether one is
 * real, dormant or abandoned.
 *
 * Suspended orgs are included and the rest of the codebase excludes them, which
 * is the point: this is the only screen from which a suspended org can be found
 * and brought back.
 */
export async function GetInstanceOrgs(): Promise<InstanceOrgSummary[]> {
  const [orgs, counts, domains] = await runAcrossOrgs(async () => {
    return await Promise.all([db.getAllOrgs(), db.getOrgCounts(), db.getAllOrgDomains()]);
  });

  const countsById = new Map(counts.map((c) => [c.org_id, c]));
  const domainsById = new Map<number, number>();
  for (const d of domains) domainsById.set(d.org_id, (domainsById.get(d.org_id) ?? 0) + 1);

  return orgs.map((org) => ({
    id: org.id,
    slug: org.slug,
    name: org.name,
    status: org.status,
    is_default: !!org.is_default,
    tag_prefix: org.tag_prefix ?? "",
    members: countsById.get(org.id)?.members ?? 0,
    monitors: countsById.get(org.id)?.monitors ?? 0,
    pages: countsById.get(org.id)?.pages ?? 0,
    domains: domainsById.get(org.id) ?? 0,
  }));
}

export interface InstanceOrgMember {
  user_id: number;
  email: string;
  name: string;
  is_active: boolean;
  is_owner: boolean;
  role_ids: string[];
}

export interface InstanceOrgDetail extends InstanceOrgSummary {
  domain_list: Array<{ id: number; hostname: string; status: string }>;
  member_list: InstanceOrgMember[];
}

/**
 * One organisation, opened up: its hostnames and who can act in it.
 *
 * **Read-only, and the console holds no write that reaches inside an org.** The
 * superadmin can see that a tenant has one owner and that they are deactivated;
 * fixing it means being a member, or suspending the org. That line is where it is
 * on purpose: a console that could quietly add itself to any tenant is one whose
 * audit trail nobody can trust, and impersonation was explicitly not asked for.
 *
 * Roles are per-org, so the role ids are read inside the target org rather than
 * across orgs - across, `getUserRoleIds` would return every role the person holds
 * anywhere and this screen would claim a tenant's member holds another tenant's
 * admin role.
 */
export async function GetInstanceOrgDetail(orgId: number): Promise<InstanceOrgDetail> {
  const summaries = await GetInstanceOrgs();
  const summary = summaries.find((o) => o.id === orgId);
  if (!summary) throw new Error("Organisation not found");

  const [domains, members] = await runAcrossOrgs(async () => {
    return await Promise.all([db.getOrgDomainsForOrg(orgId), db.getOrgMembersDetailed(orgId)]);
  });

  const memberList = await runWithOrg(orgId, async () =>
    Promise.all(
      members.map(async (m) => ({
        user_id: m.user_id,
        email: m.email,
        name: m.name,
        is_active: !!m.is_active,
        is_owner: m.is_org_owner,
        role_ids: await db.getUserRoleIds(m.user_id),
      })),
    ),
  );

  return {
    ...summary,
    domain_list: domains.map((d) => ({ id: d.id, hostname: d.hostname, status: d.status })),
    member_list: memberList,
  };
}

/** The two states an org can be in. `orgs.status` is a string column, not an enum. */
export const ORG_STATUS_ACTIVE = "ACTIVE";
export const ORG_STATUS_SUSPENDED = "SUSPENDED";

/**
 * Suspends or reactivates an organisation.
 *
 * **What suspension actually does**, because it is worth knowing before pressing
 * it. Nothing is deleted and nothing is exported; the org simply stops being
 * found:
 *
 *   - its monitors stop being checked, and its rollups, maintenance windows,
 *     SLA evaluations and cleanup stop running, because every scheduler fans out
 *     over `getActiveOrgIds`
 *   - it disappears from the org switcher, because `getOrgsForUser` filters on
 *     the same column
 *   - `/o/<slug>/` stops resolving to it
 *   - its custom hostnames, and its pages' custom hostnames, stop resolving
 *
 * The last of those is new here. The other three predate this console; the two
 * domain lookups did not check the org's status, so before KENER-31 a suspended
 * org went on serving its status page to the public on its own domain, which
 * made the whole feature a half-truth.
 *
 * **The default org cannot be suspended.** It owns everything that predates
 * tenancy, it is where `CanCreateOrg` looks, and it is the org a session with no
 * `active_org_id` lands in - so suspending it takes the instance down and leaves
 * no screen from which to undo that.
 *
 * The host cache is a sixty-second in-process map, so it is invalidated by hand:
 * an operator who has just suspended a tenant will check the hostname
 * immediately, and a minute of it still answering reads as the button not
 * working.
 */
export async function SetInstanceOrgStatus(orgId: number, status: string): Promise<void> {
  if (status !== ORG_STATUS_ACTIVE && status !== ORG_STATUS_SUSPENDED) {
    throw new Error("Status must be ACTIVE or SUSPENDED");
  }

  const org = await runAcrossOrgs(() => db.getOrgById(orgId));
  if (!org) throw new Error("Organisation not found");

  if (status === ORG_STATUS_SUSPENDED && (!!org.is_default || org.id === DEFAULT_ORG_ID)) {
    throw new Error("The default organisation cannot be suspended");
  }

  if (org.status === status) return;

  await runAcrossOrgs(() => db.setOrgStatus(orgId, status));
  invalidateOrgDomainCache();
}
