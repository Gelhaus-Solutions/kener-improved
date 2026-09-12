import type { Knex as KnexType } from "knex";
import { BaseRepository, type MonitorFilter, type CountResult } from "./base.js";
import { currentOrgIdOrDefault } from "../orgContext.js";
import { slugFromTag } from "../monitorSlug.js";
import type { MonitorRecord, MonitorRecordInsert } from "../../types/db.js";

/**
 * Clamp the Confirmation Threshold to its 1–60 invariant at the data layer, so the bound holds
 * for every app write path (v4 API, manage API, clone, group), not only the v4 API validator.
 * A non-finite/missing value defaults to 1 (off).
 */
function clampConfirmationThreshold(value: number | null | undefined): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(60, Math.max(1, n));
}

/**
 * Repository for monitors CRUD operations
 */
export class MonitorsRepository extends BaseRepository {
  async getMonitorsByTags(tags: string[]): Promise<MonitorRecord[]> {
    return await this.table("monitors").whereIn("tag", tags);
  }

  async getMonitorsByTag(tag: string): Promise<MonitorRecord | undefined> {
    return await this.table("monitors").where("tag", tag).first();
  }

  /**
   * This org's tag prefix, or "" when it has none.
   *
   * Read per insert rather than cached: monitor creation is rare, `orgs` is a
   * handful of rows, and a cache keyed on the ambient org is a cache that has to
   * be invalidated when an org is created mid-process.
   */
  private async currentTagPrefix(): Promise<string> {
    const orgId = currentOrgIdOrDefault();
    const org = await this.knexUnscoped("orgs").where("id", orgId).first();
    return (org?.tag_prefix as string | undefined) ?? "";
  }

  async insertMonitor(data: MonitorRecordInsert): Promise<number[]> {
    return await this.table("monitors").insert({
      tag: data.tag,
      // I3e. Absent from this whitelist until now, so every monitor created
      // through the admin since that migration was written with a null slug -
      // and the public page hands the browser the *slug*, not the tag. The
      // migration's one-time backfill is the only thing that had ever set it.
      //
      // Defaulted through `slugFromTag` rather than straight from `tag`, because
      // `tag` carries the org's prefix and the slug must not: a monitor created
      // through the admin in an org with `tag_prefix = "postiz"` was getting
      // `slug = "postiz_earth"`, and its public URL read
      // `/o/postiz/monitors/postiz_earth`. A no-op on the default org, whose
      // prefix is empty.
      slug: data.slug ?? slugFromTag(data.tag, await this.currentTagPrefix()),
      name: data.name,
      description: data.description,
      image: data.image,
      cron: data.cron,
      default_status: data.default_status,
      status: data.status,
      category_name: data.category_name,
      monitor_type: data.monitor_type,
      // Also missing from the whitelist, and `CloneMonitor` has always passed
      // both - so a cloned monitor silently lost its triggers.
      down_trigger: data.down_trigger,
      degraded_trigger: data.degraded_trigger,
      type_data: data.type_data,
      day_degraded_minimum_count: data.day_degraded_minimum_count,
      day_down_minimum_count: data.day_down_minimum_count,
      confirmation_threshold: clampConfirmationThreshold(data.confirmation_threshold),
      include_degraded_in_downtime: data.include_degraded_in_downtime,
      is_hidden: data.is_hidden || "NO",
      monitor_settings_json: data.monitor_settings_json,
      created_at: this.knexUnscoped.fn.now(),
      updated_at: this.knexUnscoped.fn.now(),
      external_url: data.external_url,
    });
  }

  async updateMonitor(data: MonitorRecord): Promise<number> {
    return await this.table("monitors")
      .where({ id: data.id })
      .update({
        tag: data.tag,
        name: data.name,
        description: data.description,
        image: data.image,
        cron: data.cron,
        default_status: data.default_status,
        status: data.status,
        category_name: data.category_name,
        monitor_type: data.monitor_type,
        type_data: data.type_data,
        day_degraded_minimum_count: data.day_degraded_minimum_count,
        day_down_minimum_count: data.day_down_minimum_count,
        confirmation_threshold: clampConfirmationThreshold(data.confirmation_threshold),
        include_degraded_in_downtime: data.include_degraded_in_downtime,
        is_hidden: data.is_hidden,
        monitor_settings_json: data.monitor_settings_json,
        updated_at: this.knexUnscoped.fn.now(),
        external_url: data.external_url,
      });
  }

  async updateMonitorTrigger(data: {
    id: number;
    down_trigger: string | null;
    degraded_trigger: string | null;
  }): Promise<number> {
    return await this.table("monitors").where({ id: data.id }).update({
      down_trigger: data.down_trigger,
      degraded_trigger: data.degraded_trigger,
      updated_at: this.knexUnscoped.fn.now(),
    });
  }

  async getMonitors(data: MonitorFilter): Promise<MonitorRecord[]> {
    let query = this.table("monitors").whereRaw("1=1");
    if (!!data.status) {
      query = query.andWhere("status", data.status);
    }
    if (!!data.is_hidden) {
      query = query.andWhere("is_hidden", data.is_hidden);
    }
    if (data.category_name && data.category_name !== "All Categories") {
      query = query.andWhere("category_name", data.category_name);
    }
    if (!!data.id) {
      query = query.andWhere("id", data.id);
    }
    if (!!data.monitor_type) {
      query = query.andWhere("monitor_type", data.monitor_type);
    }
    if (!!data.tag) {
      query = query.andWhere("tag", data.tag);
    }
    if (!!data.tags) {
      query = query.andWhere((builder: KnexType.QueryBuilder) => {
        builder.whereIn("tag", data.tags as string[]);
      });
    }
    if (!!data.search) {
      const term = `%${data.search}%`;
      query = query.andWhere((builder: KnexType.QueryBuilder) => {
        builder.where("name", "like", term).orWhere("tag", "like", term);
      });
    }
    return await query.orderBy("id", "desc");
  }

  async getMonitorByTag(tag: string): Promise<MonitorRecord | undefined> {
    return await this.table("monitors").where("tag", tag).first();
  }

  /**
   * The monitor with this per-org slug (I3e).
   *
   * `tag` is the physical key - globally unique, and the thing that appears in
   * `monitoring_data`, Redis keys and BullMQ job ids - while `slug` is the name a
   * tenant chose and the one that belongs in a public URL. For the default org
   * the two are identical, which is what makes every existing badge, embed and
   * monitor URL keep working unchanged.
   *
   * Org-scoped like everything else here, so two orgs may both have `api`.
   */
  async getMonitorBySlug(slug: string): Promise<MonitorRecord | undefined> {
    return await this.table("monitors").where("slug", slug).first();
  }

  /** The batch form, for an endpoint that resolves up to a hundred names at once. */
  async getMonitorsBySlugs(slugs: string[]): Promise<MonitorRecord[]> {
    if (slugs.length === 0) return [];
    return await this.table("monitors").whereIn("slug", slugs);
  }

  async deleteMonitorsByTag(tag: string): Promise<number> {
    return await this.table("monitors").where("tag", tag).del();
  }
}
