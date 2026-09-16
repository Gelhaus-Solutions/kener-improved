import { BaseRepository } from "./base.js";

/**
 * B12a. Which regional endpoints make up one multi-region service.
 *
 * **A regional target IS an ordinary monitor.** It has its own tag, its own
 * `monitoring_data` rows, its own probe assignment and its own execution, and
 * this table holds nothing but the relationship: which parent it belongs to and
 * which region it is in. That is the decision the whole model rests on, and the
 * reason is in the migration: `monitoring_data` is keyed
 * `(monitor_tag, region_id, timestamp)` where `region_id` is the PROBE region,
 * so making a target anything other than a monitor tag would have put a fourth
 * column into the primary key of the largest table in the schema.
 *
 * **Everything here is scoped.** `monitor_region_targets` is in `TENANT_TABLES`,
 * so `this.table()` applies `org_id` and throws without a context. There is no
 * cross-tenant read in this repository and there should never be one: unlike
 * `findProbeAgentByTokenHash`, nothing here is how an org gets *determined*.
 */

/** One regional endpoint of one multi-region service. */
export interface RegionTargetRecord {
  id: number;
  org_id: number | null;
  /** The multi-region monitor this endpoint belongs to. */
  parent_tag: string;
  /** The hidden monitor that actually gets checked. */
  child_tag: string;
  /** Where the endpoint IS, as a `regions.id`. Never parsed out of a tag. */
  region_id: number;
}

const TABLE = "monitor_region_targets";

export class RegionTargetsRepository extends BaseRepository {
  /**
   * Every regional endpoint of one service, region order.
   *
   * Ordered by `region_id` rather than by insertion, so the list a screen draws
   * and the list the rollup reduces are in the same order every time. A rollup
   * whose answer does not depend on order still benefits: a reader comparing two
   * renders should not have to work out whether anything moved.
   */
  async getRegionTargets(parentTag: string): Promise<RegionTargetRecord[]> {
    // **The ORDER BY is load-bearing on Postgres and only decorative on SQLite.**
    // `uq_monitor_region_targets_parent_region` is `(parent_tag, region_id)`, so
    // SQLite satisfies this query from that index and hands rows back in region
    // order whether or not it is asked to. Postgres picks
    // `idx_monitor_region_targets_parent` instead and returns INSERTION order:
    // measured on 17, three endpoints added as regions 3, 1, 2 come back 3, 1, 2
    // without this clause and 1, 2, 3 with it. Removing this line therefore
    // leaves every test green and scrambles the screen on the database most
    // installs actually run.
    return await this.table(TABLE).where({ parent_tag: parentTag }).orderBy("region_id", "asc").select("*");
  }

  /**
   * The same, for several services at once.
   *
   * Exists because the alternative is the shape that quietly makes a status page
   * with forty monitors issue forty queries. Returned as a map keyed by parent
   * tag so a caller can look up the service it is rendering without filtering
   * the whole result each time.
   */
  async getRegionTargetsForParents(parentTags: string[]): Promise<Map<string, RegionTargetRecord[]>> {
    const byParent = new Map<string, RegionTargetRecord[]>();
    if (parentTags.length === 0) return byParent;

    const rows: RegionTargetRecord[] = await this.table(TABLE)
      .whereIn("parent_tag", parentTags)
      .orderBy("region_id", "asc")
      .select("*");

    for (const row of rows) {
      const existing = byParent.get(row.parent_tag);
      if (existing) existing.push(row);
      else byParent.set(row.parent_tag, [row]);
    }
    return byParent;
  }

  /**
   * Is this monitor a regional endpoint of something, and whose?
   *
   * **The lookup the rest of B12 depends on more than any other.** A hidden
   * child must not be alerted on individually (Enno's Q3 decision: alerting
   * fires per monitor and names the region), must not appear on a public
   * surface, and must not be offered in a picker as though it were a service.
   * Every one of those is "is this a child" asked from the child's side, which
   * is why the unique index is on `child_tag` and why this is a single-row read
   * rather than a scan of every parent's member list.
   */
  async getRegionTargetByChild(childTag: string): Promise<RegionTargetRecord | undefined> {
    return await this.table(TABLE).where({ child_tag: childTag }).first();
  }

  /**
   * Every child tag in this org, for the callers that need the whole set.
   *
   * Alert evaluation and the public monitor list both ask "which of these many
   * monitors are hidden children", and asking per monitor would be one query per
   * monitor on a path that runs every minute.
   */
  async getAllRegionTargetChildTags(): Promise<Set<string>> {
    const rows: Array<{ child_tag: string }> = await this.table(TABLE).select("child_tag");
    return new Set(rows.map((row) => row.child_tag));
  }

  /**
   * Adds one regional endpoint to a service.
   *
   * `org_id` is left to `BaseRepository.table()`, which stamps it onto every
   * insert against a tenant table. Passing it here as well would work and would
   * win, since the stamp spreads the row over the default, but writing it by
   * hand is how one call site eventually disagrees with the scope it is running
   * in.
   *
   * The two unique indexes do the real work and are deliberately not re-checked
   * here first: `(parent_tag, region_id)` refuses a second endpoint in one
   * region, and `child_tag` refuses a monitor that already belongs to another
   * service. A read-then-write would be the same two checks with a race in the
   * middle.
   */
  async addRegionTarget(input: { parentTag: string; childTag: string; regionId: number }): Promise<number> {
    const [row] = await this.table(TABLE)
      .insert({
        parent_tag: input.parentTag,
        child_tag: input.childTag,
        region_id: input.regionId,
      })
      .returning("id");
    // **Both dialects return `[{ id }]`** - measured, not assumed, against
    // better-sqlite3 and pg. The bare-number branch is a defence against a knex
    // version that unwraps it, matching what `createOrg` and
    // `createReportSchedule` already do. It is deliberately NOT covered by a
    // test, because no supported dialect produces that shape and a test would
    // have to fake one; a mutation removing the branch survives for exactly that
    // reason rather than because nothing checks the id.
    return typeof row === "number" ? row : Number((row as { id: number } | undefined)?.id ?? 0);
  }

  /** Removes one regional endpoint. Does not touch the child monitor itself. */
  async removeRegionTarget(childTag: string): Promise<number> {
    return await this.table(TABLE).where({ child_tag: childTag }).delete();
  }

  /**
   * Removes every regional endpoint of a service.
   *
   * For a multi-region monitor being deleted or unfolded. Again: this removes
   * the RELATIONSHIPS. The child monitors and their history survive, which is
   * what makes an unfold something other than data loss.
   */
  async removeRegionTargetsForParent(parentTag: string): Promise<number> {
    return await this.table(TABLE).where({ parent_tag: parentTag }).delete();
  }
}
