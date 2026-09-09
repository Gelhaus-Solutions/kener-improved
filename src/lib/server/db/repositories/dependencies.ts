import { BaseRepository } from "./base.js";
import type { DependencyEdge, RollupSetting } from "../../incidents/rollup.js";

/**
 * The component dependency graph and per-monitor rollup settings (C3).
 *
 * Its own repository because it is a distinct concern from monitors: these are
 * status *metadata*, read at page-render time, and they live in side tables
 * precisely so that editing them does not churn every BullMQ scheduler the way a
 * new column on `monitors` would.
 */
export class DependenciesRepository extends BaseRepository {
  /**
   * Every edge in the org.
   *
   * The whole graph in one query rather than a walk of per-node lookups: a page
   * render needs to resolve many components at once, and a status page's graph is
   * hundreds of rows, not millions. Fetching it whole is what makes the rollup a
   * pure in-memory function that can be tested without a database.
   */
  async getAllDependencies(): Promise<DependencyEdge[]> {
    return (await this.table("component_dependencies").select(
      "parent_monitor_tag",
      "child_monitor_tag",
      "relation",
      "propagation",
      "weight",
    )) as DependencyEdge[];
  }

  /**
   * Tags of every monitor of a given type.
   *
   * Here rather than on the monitors repository because the only caller is the
   * rollup, which needs exactly one thing from `monitors`: which of them already
   * compute their own status from their members.
   */
  async getMonitorsByType(monitorType: string): Promise<Array<{ tag: string }>> {
    return await this.table("monitors").where("monitor_type", monitorType).select("tag");
  }

  async getAllRollupSettings(): Promise<RollupSetting[]> {
    return (await this.table("monitor_rollup_settings").select(
      "monitor_tag",
      "rollup_mode",
      "manual_override",
      "manual_override_expires_at",
    )) as RollupSetting[];
  }

  /** One monitor's edges, in both directions, for the monitor edit screen. */
  async getDependenciesForMonitor(tag: string): Promise<{ children: DependencyEdge[]; parents: DependencyEdge[] }> {
    const [children, parents] = await Promise.all([
      this.table("component_dependencies").where("parent_monitor_tag", tag).select("*"),
      this.table("component_dependencies").where("child_monitor_tag", tag).select("*"),
    ]);
    return { children: children as DependencyEdge[], parents: parents as DependencyEdge[] };
  }

  async insertDependency(data: {
    parent_monitor_tag: string;
    child_monitor_tag: string;
    relation: string;
    propagation: string;
    weight: number;
  }): Promise<void> {
    await this.table("component_dependencies")
      .insert({ ...data, created_at: this.knexUnscoped.fn.now(), updated_at: this.knexUnscoped.fn.now() })
      // Re-adding an edge that exists is an edit of its propagation or weight,
      // not an error: the operator's intent is the same either way.
      .onConflict(["parent_monitor_tag", "child_monitor_tag", "relation"])
      .merge({ propagation: data.propagation, weight: data.weight, updated_at: this.knexUnscoped.fn.now() });
  }

  async deleteDependency(parentTag: string, childTag: string, relation: string): Promise<number> {
    return await this.table("component_dependencies")
      .where({ parent_monitor_tag: parentTag, child_monitor_tag: childTag, relation })
      .del();
  }

  async getRollupSetting(tag: string): Promise<RollupSetting | undefined> {
    return (await this.table("monitor_rollup_settings").where("monitor_tag", tag).first()) as RollupSetting | undefined;
  }

  async upsertRollupSetting(data: {
    monitor_tag: string;
    rollup_mode: string;
    manual_override: string | null;
    manual_override_reason: string | null;
    manual_override_expires_at: number | null;
  }): Promise<void> {
    await this.table("monitor_rollup_settings")
      .insert({ ...data, created_at: this.knexUnscoped.fn.now(), updated_at: this.knexUnscoped.fn.now() })
      .onConflict(["monitor_tag"])
      .merge({
        rollup_mode: data.rollup_mode,
        manual_override: data.manual_override,
        manual_override_reason: data.manual_override_reason,
        manual_override_expires_at: data.manual_override_expires_at,
        updated_at: this.knexUnscoped.fn.now(),
      });
  }
}
