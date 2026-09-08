import { BaseRepository } from "./base.js";

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
}
