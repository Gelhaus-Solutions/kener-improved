import { BaseRepository } from "./base.js";
import { currentOrgId } from "../../events/eventContext.js";
import type { SiteData } from "../../types/db.js";

/**
 * Repository for site data operations
 *
 * **Org-scoped as of I3b.** `site_data.key` used to be globally unique and is now
 * unique per org, so every read and the upsert have to say which org they mean or
 * a second organisation reads and overwrites the first one's settings.
 *
 * The org comes from `currentOrgId()` as a default argument rather than a
 * required parameter. That was a deliberate choice over threading an `orgId`
 * through every call site: `currentOrgId()` already falls back to the default
 * org, so behaviour is identical today and these methods become correct on their
 * own the moment I3d starts populating the request context. Callers that do know
 * their org can pass it, which is the convention the webhook and event
 * repositories already follow.
 */
export class SiteDataRepository extends BaseRepository {
  async insertOrUpdateSiteData(
    key: string,
    value: string,
    data_type: string,
    orgId: number = currentOrgId(),
  ): Promise<number[]> {
    return await this.table("site_data")
      .insert({ key, value, data_type, org_id: orgId })
      // Must match the composite unique index exactly, or Postgres has no
      // arbiter to resolve the conflict against and the upsert throws.
      .onConflict(["org_id", "key"])
      .merge({ value, updated_at: this.knexUnscoped.fn.now() });
  }

  async getAllSiteData(orgId: number = currentOrgId()): Promise<SiteData[]> {
    return await this.table("site_data").where("org_id", orgId);
  }

  async getSiteData(key: string, orgId: number = currentOrgId()): Promise<{ value: string } | undefined> {
    return await this.table("site_data").select("value").where({ key, org_id: orgId }).first();
  }

  async getSiteDataByKey(key: string, orgId: number = currentOrgId()): Promise<SiteData | undefined> {
    return await this.table("site_data").where({ key, org_id: orgId }).first();
  }

  async getAllSiteDataByPrefix(prefix: string, orgId: number = currentOrgId()): Promise<SiteData[]> {
    return await this.table("site_data").where("org_id", orgId).andWhere("key", "like", `${prefix}.%`);
  }

  async getAllSiteDataAnalytics(): Promise<SiteData[]> {
    return await this.getAllSiteDataByPrefix("analytics");
  }
}
