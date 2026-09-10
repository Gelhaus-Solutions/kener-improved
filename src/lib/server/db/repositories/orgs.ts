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

/** What the instance console shows beside each org. See `getOrgCounts`. */
export interface OrgCounts {
  org_id: number;
  members: number;
  monitors: number;
  pages: number;
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

  /**
   * Per-org row counts, for the instance console (KENER-31).
   *
   * Three grouped counts rather than one query with correlated subqueries: the
   * shape is identical on SQLite, Postgres and MySQL, and an org with no
   * monitors simply has no row in that result instead of needing an outer join
   * that each dialect spells differently. The caller fills the gaps with zero.
   *
   * `monitors` and `pages` are tenant tables, so this only works inside
   * `runAcrossOrgs` - which is correct and deliberate: counting every org's rows
   * is the definition of an instance-wide read, and `InstanceController` is the
   * only caller, behind the superadmin gate.
   */
  async getOrgCounts(): Promise<OrgCounts[]> {
    const [members, monitors, pages] = await Promise.all([
      this.table("org_members").groupBy("org_id").select("org_id").count({ n: "*" }),
      this.table("monitors").groupBy("org_id").select("org_id").count({ n: "*" }),
      this.table("pages").groupBy("org_id").select("org_id").count({ n: "*" }),
    ]);

    const byOrg = new Map<number, OrgCounts>();
    const fold = (rows: Array<Record<string, unknown>>, key: "members" | "monitors" | "pages") => {
      for (const row of rows) {
        const orgId = Number(row.org_id);
        if (!Number.isFinite(orgId)) continue;
        const entry = byOrg.get(orgId) ?? { org_id: orgId, members: 0, monitors: 0, pages: 0 };
        entry[key] = Number(row.n ?? 0);
        byOrg.set(orgId, entry);
      }
    };
    fold(members, "members");
    fold(monitors, "monitors");
    fold(pages, "pages");

    return [...byOrg.values()].sort((a, b) => a.org_id - b.org_id);
  }

  /**
   * Suspends or reactivates an org (KENER-31).
   *
   * `status` is the switch four different subsystems already read:
   * `getActiveOrgIds` is what every scheduler fans out over, `getOrgsForUser`
   * is what the switcher lists, `/o/<slug>` resolution checks it, and the two
   * domain lookups join on it. Suspension is therefore a single column write and
   * not a feature of its own, which is exactly why it is worth having.
   */
  async setOrgStatus(orgId: number, status: string): Promise<number> {
    return await this.table("orgs").where({ id: orgId }).update({ status });
  }

  /** Every active org id, for the schedulers that genuinely fan out across tenants. */
  async getActiveOrgIds(): Promise<number[]> {
    const rows = await this.table("orgs").where({ status: "ACTIVE" }).orderBy("id", "asc").select("id");
    return rows.map((r: { id: number }) => r.id);
  }

  /**
   * Verified hostnames only: a PENDING domain must not yet serve a tenant's page.
   *
   * Joined to `orgs` so a **suspended org's custom domain stops resolving**
   * (KENER-31). Every other route into a suspended tenant was already closed -
   * the schedulers fan out over `getActiveOrgIds`, the switcher lists
   * `getOrgsForUser`, and `/o/<slug>` checks the status directly - which left
   * this one query as the way a suspended org kept serving its status page to
   * the public on its own hostname. An inner join, so a domain whose org has
   * been deleted stops resolving rather than resolving to nothing.
   */
  /**
   * Every org hostname, whatever its status and whatever its org's.
   *
   * The instance console's counterpart to `getActiveOrgDomains` (KENER-31). That
   * one answers "what should this hostname serve", so it filters hard; this one
   * answers "how is this instance configured", where a suspended org's domains
   * and a PENDING one are exactly what the operator came to look at.
   */
  async getAllOrgDomains(): Promise<OrgDomainRecord[]> {
    return await this.table("org_domains").orderBy("id", "asc").select("id", "org_id", "hostname", "status");
  }

  async getActiveOrgDomains(): Promise<OrgDomainRecord[]> {
    return await this.table("org_domains as od")
      .join("orgs as o", "o.id", "od.org_id")
      .where("od.status", "ACTIVE")
      .andWhere("o.status", "ACTIVE")
      .select("od.id", "od.org_id", "od.hostname", "od.status");
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
