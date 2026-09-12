import { BaseRepository } from "./base.js";
import { currentOrgId } from "../../events/eventContext.js";
import { runAcrossOrgs } from "../orgContext.js";
import { INSTANCE_ORG_ID, overlaySiteData, overlaySiteDataKey, writeOrgFor } from "../../controllers/siteDataScope.js";
import type { SiteData } from "../../types/db.js";

/**
 * Repository for site data operations
 *
 * **Org-scoped as of I3b, layered as of I3g.** `site_data.key` used to be
 * globally unique and is now unique per org, so every read and the upsert have
 * to say which org they mean or a second organisation reads and overwrites the
 * first one's settings. On top of that, `org_id = 0` now holds the instance
 * layer: a read takes those rows and overlays the current org's on top, so an
 * org stores a row only for a setting it has actually changed.
 *
 * The org comes from `currentOrgId()` as a default argument rather than a
 * required parameter. That was a deliberate choice over threading an `orgId`
 * through every call site: `currentOrgId()` already falls back to the default
 * org, so behaviour is identical today and these methods become correct on their
 * own the moment I3d starts populating the request context. Callers that do know
 * their org can pass it, which is the convention the webhook and event
 * repositories already follow.
 *
 * **Why the layered reads do not use `this.table()`.** That helper appends
 * `where org_id = <current org>` for a tenant table, which is exactly right
 * everywhere else and exactly wrong here: a query needing rows from org 0 *and*
 * org N would come back as `org_id = N AND org_id = 0` and return nothing, for
 * every key, silently. So they say `runAcrossOrgs` and name both orgs
 * themselves. Nothing leaks: the `whereIn` names the instance layer and the
 * caller's own org and no other, and `overlaySiteData` is what decides which of
 * the two wins.
 */
export class SiteDataRepository extends BaseRepository {
  /**
   * Both layers for one org, in one query.
   *
   * One round trip rather than two: this is the hottest read in the app, on the
   * path of every public page load, and the overlay is a few dozen map writes.
   */
  private async layeredRows(orgId: number): Promise<SiteData[]> {
    return await runAcrossOrgs(() =>
      this.knexUnscoped("site_data").whereIn("org_id", [INSTANCE_ORG_ID, orgId]).select("*"),
    );
  }

  /**
   * Writes a setting into the layer it belongs in.
   *
   * An instance-scoped key goes to org 0 whatever org the caller is acting in.
   * That is the asymmetry I3g rests on: those keys decide things a tenant
   * administrator must not decide for the instance, so an org-level row for one
   * would be an override that silently did nothing.
   */
  async insertOrUpdateSiteData(
    key: string,
    value: string,
    data_type: string,
    orgId: number = currentOrgId(),
  ): Promise<number[]> {
    const targetOrg = writeOrgFor(key, orgId);
    return await runAcrossOrgs(() =>
      this.knexUnscoped("site_data")
        .insert({ key, value, data_type, org_id: targetOrg })
        // Must match the composite unique index exactly, or Postgres has no
        // arbiter to resolve the conflict against and the upsert throws.
        .onConflict(["org_id", "key"])
        .merge({ value, updated_at: this.knexUnscoped.fn.now() }),
    );
  }

  async getAllSiteData(orgId: number = currentOrgId()): Promise<SiteData[]> {
    return overlaySiteData(await this.layeredRows(orgId), orgId);
  }

  async getSiteData(key: string, orgId: number = currentOrgId()): Promise<{ value: string } | undefined> {
    const row = await this.getSiteDataByKey(key, orgId);
    return row ? { value: row.value } : undefined;
  }

  async getSiteDataByKey(key: string, orgId: number = currentOrgId()): Promise<SiteData | undefined> {
    const rows: SiteData[] = await runAcrossOrgs(() =>
      this.knexUnscoped("site_data").whereIn("org_id", [INSTANCE_ORG_ID, orgId]).andWhere({ key }).select("*"),
    );
    return overlaySiteDataKey(rows, key, orgId);
  }

  async getAllSiteDataByPrefix(prefix: string, orgId: number = currentOrgId()): Promise<SiteData[]> {
    const rows: SiteData[] = await runAcrossOrgs(() =>
      this.knexUnscoped("site_data")
        .whereIn("org_id", [INSTANCE_ORG_ID, orgId])
        .andWhere("key", "like", `${prefix}.%`)
        .select("*"),
    );
    return overlaySiteData(rows, orgId);
  }

  async getAllSiteDataAnalytics(): Promise<SiteData[]> {
    return await this.getAllSiteDataByPrefix("analytics");
  }

  // ---- The instance layer itself (I3g) ------------------------------------

  /**
   * The instance layer's own rows, unoverlaid.
   *
   * For the instance console, which edits the defaults rather than reading
   * through them. Every other reader wants `getAllSiteData`.
   */
  async getInstanceSiteData(): Promise<SiteData[]> {
    return await runAcrossOrgs(() => this.knexUnscoped("site_data").where("org_id", INSTANCE_ORG_ID).select("*"));
  }

  /** Writes a value into the instance layer, whatever the key's ordinary scope. */
  async setInstanceSiteData(key: string, value: string, data_type: string): Promise<void> {
    await runAcrossOrgs(() =>
      this.knexUnscoped("site_data")
        .insert({ key, value, data_type, org_id: INSTANCE_ORG_ID })
        .onConflict(["org_id", "key"])
        .merge({ value, updated_at: this.knexUnscoped.fn.now() }),
    );
  }

  /**
   * Drops one org's override, so it inherits the instance default again.
   *
   * Scoped through `this.table()` deliberately, unlike everything else here: it
   * deletes, and a delete that could name any org is not something to leave
   * reachable from a request.
   */
  async clearSiteDataOverride(key: string): Promise<number> {
    return await this.table("site_data").where({ key }).delete();
  }

  /** Which keys this org overrides, for showing "inherited" beside the rest. */
  async getOverriddenKeys(orgId: number = currentOrgId()): Promise<string[]> {
    const rows: Array<{ key: string }> = await runAcrossOrgs(() =>
      this.knexUnscoped("site_data").where("org_id", orgId).select("key"),
    );
    return rows.map((row) => row.key);
  }
}
