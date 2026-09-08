import { BaseRepository } from "./base.js";
import { provisionOrg } from "../provisionOrg.js";

/**
 * The organisation tables themselves.
 *
 * **Everything here is deliberately unscoped**, and that is not an oversight:
 * `orgs`, `org_members` and `org_domains` are how an org is *found*, so a query
 * against them cannot be filtered by the org it is trying to determine. They are
 * listed in `INSTANCE_TABLES` for the same reason, which means `this.table()`
 * passes them straight through and no context is required to read them.
 *
 * The access rule they enforce lives one level up: membership is checked before
 * a session is allowed to act in an org, not by hiding rows here.
 */

export interface OrgRecord {
  id: number;
  slug: string;
  name: string;
  status: string;
  is_default: boolean | number;
  tag_prefix: string;
}

export interface OrgDomainRecord {
  id: number;
  org_id: number;
  hostname: string;
  status: string;
}

export interface OrgMembershipRecord {
  org_id: number;
  user_id: number;
  is_org_owner: boolean | number;
  perms_epoch: number;
}

export class OrgsRepository extends BaseRepository {
  async getOrgById(orgId: number): Promise<OrgRecord | undefined> {
    return await this.table("orgs").where({ id: orgId }).first();
  }

  async getOrgBySlug(slug: string): Promise<OrgRecord | undefined> {
    return await this.table("orgs").where({ slug }).first();
  }

  async getAllOrgs(): Promise<OrgRecord[]> {
    return await this.table("orgs").orderBy("id", "asc");
  }

  /** Every active org id, for the schedulers that genuinely fan out across tenants. */
  async getActiveOrgIds(): Promise<number[]> {
    const rows = await this.table("orgs").where({ status: "ACTIVE" }).orderBy("id", "asc").select("id");
    return rows.map((r: { id: number }) => r.id);
  }

  /** Verified hostnames only: a PENDING domain must not yet serve a tenant's page. */
  async getActiveOrgDomains(): Promise<OrgDomainRecord[]> {
    return await this.table("org_domains").where({ status: "ACTIVE" }).select("id", "org_id", "hostname", "status");
  }

  /** The orgs a user belongs to, for the switcher and for the membership check. */
  async getOrgsForUser(userId: number): Promise<Array<OrgRecord & { is_org_owner: boolean | number }>> {
    return await this.table("org_members as om")
      .join("orgs as o", "om.org_id", "o.id")
      .where("om.user_id", userId)
      .andWhere("o.status", "ACTIVE")
      .orderBy("o.id", "asc")
      .select("o.id", "o.slug", "o.name", "o.status", "o.is_default", "o.tag_prefix", "om.is_org_owner");
  }

  async getOrgMembership(orgId: number, userId: number): Promise<OrgMembershipRecord | undefined> {
    return await this.table("org_members").where({ org_id: orgId, user_id: userId }).first();
  }

  /**
   * Whether a user may act in an org.
   *
   * The single check every entry point that trusts a session's `active_org_id`
   * has to make. A session can name any org id; membership is what makes it
   * legitimate.
   */
  async isOrgMember(orgId: number, userId: number): Promise<boolean> {
    return !!(await this.getOrgMembership(orgId, userId));
  }

  // ============ Writes (I3f) ============
  //
  // Creating and administering an org from the admin, rather than from a seed.
  // Everything below is as unscoped as the reads above and for the same reason;
  // the entitlement to run any of it is decided in `orgController`, which is the
  // only caller.

  /** Creates the org row itself. `provisionOrg` is what makes it usable. */
  async createOrg(data: { slug: string; name: string; tag_prefix: string }): Promise<number> {
    const [row] = await this.table("orgs")
      .insert({
        slug: data.slug,
        name: data.name,
        tag_prefix: data.tag_prefix,
        status: "ACTIVE",
        is_default: false,
      })
      .returning("id");
    return Number(typeof row === "object" ? row.id : row);
  }

  async updateOrg(orgId: number, data: { name?: string; slug?: string }): Promise<number> {
    return await this.table("orgs").where({ id: orgId }).update(data);
  }

  async getOrgDomainsForOrg(orgId: number): Promise<OrgDomainRecord[]> {
    return await this.table("org_domains")
      .where({ org_id: orgId })
      .orderBy("id", "asc")
      .select("id", "org_id", "hostname", "status");
  }

  /** The hostname is stored lowercased, because `orgForHost` looks it up that way. */
  async addOrgDomain(orgId: number, hostname: string, status: string): Promise<number> {
    const [row] = await this.table("org_domains")
      .insert({ org_id: orgId, hostname: hostname.toLowerCase(), status })
      .returning("id");
    return Number(typeof row === "object" ? row.id : row);
  }

  /** Scoped by org id as well as row id, so one org cannot delete another's domain. */
  async deleteOrgDomain(orgId: number, id: number): Promise<number> {
    return await this.table("org_domains").where({ id, org_id: orgId }).del();
  }

  async getOrgDomainByHostname(hostname: string): Promise<OrgDomainRecord | undefined> {
    return await this.table("org_domains").where({ hostname: hostname.toLowerCase() }).first();
  }

  /** Idempotent: re-adding an existing member changes nothing rather than failing. */
  async addOrgMember(orgId: number, userId: number, isOrgOwner: boolean): Promise<void> {
    await this.table("org_members")
      .insert({ org_id: orgId, user_id: userId, is_org_owner: isOrgOwner, perms_epoch: 0 })
      .onConflict(["org_id", "user_id"])
      .ignore();
  }

  async setOrgMemberOwner(orgId: number, userId: number, isOrgOwner: boolean): Promise<number> {
    return await this.table("org_members")
      .where({ org_id: orgId, user_id: userId })
      .update({ is_org_owner: isOrgOwner });
  }

  async removeOrgMember(orgId: number, userId: number): Promise<number> {
    return await this.table("org_members").where({ org_id: orgId, user_id: userId }).del();
  }

  /** How many owners an org has, so the last one cannot be removed or demoted. */
  async countOrgOwners(orgId: number): Promise<number> {
    const row = await this.table("org_members")
      .where({ org_id: orgId })
      .andWhere("is_org_owner", true)
      .count({ c: "*" })
      .first();
    return Number((row as { c: string | number } | undefined)?.c ?? 0);
  }

  /**
   * Fills a newly created org with everything that makes it usable.
   *
   * Runs the same `provisionOrg` a fresh install runs through `seeds/`, rather
   * than a second copy of it: that is the whole reason the function was
   * extracted in I3b, and letting the admin drift from the seed is precisely
   * what it was extracted to prevent.
   *
   * `knexUnscoped` because `provisionOrg` writes tenant rows for an org that is
   * not the one this request is running in, and stamps `org_id` explicitly on
   * every insert of its own.
   */
  async provisionNewOrg(orgId: number): Promise<void> {
    await provisionOrg(this.knexUnscoped, orgId);
  }

  /** The org's members with the identity fields the members table shows. */
  async getOrgMembersDetailed(
    orgId: number,
  ): Promise<Array<{ user_id: number; email: string; name: string; is_active: number; is_org_owner: boolean }>> {
    const rows = await this.table("org_members as om")
      .join("users as u", "om.user_id", "u.id")
      .where("om.org_id", orgId)
      .orderBy("u.email", "asc")
      .select("om.user_id", "u.email", "u.name", "u.is_active", "om.is_org_owner");
    return rows.map((r: Record<string, unknown>) => ({
      user_id: Number(r.user_id),
      email: String(r.email),
      name: String(r.name ?? ""),
      is_active: Number(r.is_active ?? 0),
      is_org_owner: !!r.is_org_owner,
    }));
  }
}
