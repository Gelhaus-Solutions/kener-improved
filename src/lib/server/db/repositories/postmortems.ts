import { BaseRepository } from "./base.js";
import { GetDbType } from "../../tool.js";
import type { PostmortemRecord } from "../../types/postmortem.js";

/**
 * Postmortems (C1).
 *
 * **Every column is listed explicitly on both the insert and the update**, the
 * same discipline `incidents.ts` documents, and for the same reason: a spread
 * lets `id` and `created_at` ride along, and an omission writes the column
 * default over an operator's text without erroring. Anything added to
 * `PostmortemRecord` that a person can edit belongs in all three lists here.
 */
export class PostmortemsRepository extends BaseRepository {
  async getPostmortemByIncidentId(incidentId: number): Promise<PostmortemRecord | undefined> {
    return await this.table("incident_postmortems").where("incident_id", incidentId).first();
  }

  async getPostmortemById(id: number): Promise<PostmortemRecord | undefined> {
    return await this.table("incident_postmortems").where("id", id).first();
  }

  /**
   * Published postmortems, newest first.
   *
   * Ordered by `published_at` rather than by `created_at` or by incident id,
   * because the order a reader expects is the order things were made public -
   * a postmortem drafted in March and published in May belongs at May.
   */
  async getPublishedPostmortems(limit: number): Promise<PostmortemRecord[]> {
    return await this.table("incident_postmortems")
      .where("status", "PUBLISHED")
      .whereNotNull("published_at")
      .orderBy("published_at", "desc")
      .limit(limit);
  }

  /** Published postmortems for a set of incidents. One query, for the page render. */
  async getPublishedPostmortemsForIncidents(incidentIds: number[]): Promise<PostmortemRecord[]> {
    if (incidentIds.length === 0) return [];
    return await this.table("incident_postmortems")
      .whereIn("incident_id", incidentIds)
      .where("status", "PUBLISHED")
      .select("*");
  }

  async insertPostmortem(data: Omit<PostmortemRecord, "id" | "created_at" | "updated_at">): Promise<PostmortemRecord> {
    const insertData = {
      incident_id: data.incident_id,
      status: data.status,
      title: data.title,
      summary: data.summary,
      root_cause: data.root_cause,
      impact_description: data.impact_description,
      resolution: data.resolution,
      body_md: data.body_md,
      action_items: data.action_items,
      timeline_source: data.timeline_source,
      timeline_custom: data.timeline_custom,
      published_at: data.published_at,
      author_user_id: data.author_user_id,
      last_editor_user_id: data.last_editor_user_id,
      notify_subscribers: data.notify_subscribers,
      created_at: this.knexUnscoped.fn.now(),
      updated_at: this.knexUnscoped.fn.now(),
    };

    // `org_id` is stamped by the scoped query builder, so it is deliberately not
    // in the object above: writing it here as well would let a caller's stale
    // value beat the request's org context.
    if (GetDbType() === "postgresql") {
      const [row] = await this.table("incident_postmortems").insert(insertData).returning("*");
      return row;
    }
    const result = await this.table("incident_postmortems").insert(insertData);
    const id = (result as unknown as number[])[0];
    return await this.table("incident_postmortems").where("id", id).first();
  }

  async updatePostmortem(id: number, data: Partial<PostmortemRecord>): Promise<number> {
    return await this.table("incident_postmortems").where("id", id).update({
      status: data.status,
      title: data.title,
      summary: data.summary,
      root_cause: data.root_cause,
      impact_description: data.impact_description,
      resolution: data.resolution,
      body_md: data.body_md,
      action_items: data.action_items,
      timeline_source: data.timeline_source,
      timeline_custom: data.timeline_custom,
      published_at: data.published_at,
      last_editor_user_id: data.last_editor_user_id,
      notify_subscribers: data.notify_subscribers,
      updated_at: this.knexUnscoped.fn.now(),
    });
  }

  async deletePostmortem(id: number): Promise<number> {
    return await this.table("incident_postmortems").where("id", id).delete();
  }
}
