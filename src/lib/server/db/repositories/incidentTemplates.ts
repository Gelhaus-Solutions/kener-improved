import { BaseRepository } from "./base.js";
import { GetDbType } from "../../tool.js";
import type { IncidentTemplateRecord } from "../../types/incidentTemplate.js";

/**
 * Incident templates (C4).
 *
 * Explicit column lists on insert and update, the discipline `incidents.ts`
 * documents at length: a spread lets `id` and `created_at` ride along, and an
 * omission writes the column default over an operator's text without erroring.
 */
export class IncidentTemplatesRepository extends BaseRepository {
  /**
   * Every template in the org, most-used first.
   *
   * The ordering is the feature. During an outage the template somebody wants is
   * overwhelmingly the one they reached for last time, and a list sorted by name
   * makes them read it.
   */
  async getIncidentTemplates(): Promise<IncidentTemplateRecord[]> {
    return await this.table("incident_templates").orderBy("usage_count", "desc").orderBy("name", "asc").select("*");
  }

  async getIncidentTemplateById(id: number): Promise<IncidentTemplateRecord | undefined> {
    return await this.table("incident_templates").where("id", id).first();
  }

  async getIncidentTemplateByName(name: string): Promise<IncidentTemplateRecord | undefined> {
    return await this.table("incident_templates").where("name", name).first();
  }

  async insertIncidentTemplate(
    data: Omit<IncidentTemplateRecord, "id" | "org_id" | "created_at" | "updated_at">,
  ): Promise<IncidentTemplateRecord> {
    const insertData = {
      name: data.name,
      description: data.description,
      title_template: data.title_template,
      body_template: data.body_template,
      default_severity: data.default_severity,
      default_state: data.default_state,
      default_components: data.default_components,
      variables: data.variables,
      is_global: data.is_global,
      usage_count: data.usage_count,
      created_at: this.knexUnscoped.fn.now(),
      updated_at: this.knexUnscoped.fn.now(),
    };

    if (GetDbType() === "postgresql") {
      const [row] = await this.table("incident_templates").insert(insertData).returning("*");
      return row;
    }
    const result = await this.table("incident_templates").insert(insertData);
    const id = (result as unknown as number[])[0];
    return await this.table("incident_templates").where("id", id).first();
  }

  async updateIncidentTemplate(id: number, data: Partial<IncidentTemplateRecord>): Promise<number> {
    return await this.table("incident_templates").where("id", id).update({
      name: data.name,
      description: data.description,
      title_template: data.title_template,
      body_template: data.body_template,
      default_severity: data.default_severity,
      default_state: data.default_state,
      default_components: data.default_components,
      variables: data.variables,
      is_global: data.is_global,
      updated_at: this.knexUnscoped.fn.now(),
    });
  }

  async deleteIncidentTemplate(id: number): Promise<number> {
    return await this.table("incident_templates").where("id", id).delete();
  }

  /**
   * Bumps the use count.
   *
   * `increment` rather than read-modify-write, so two people opening incidents
   * from the same template during the same outage both count. The read-modify
   * version loses one of them, which is exactly when the count matters most.
   */
  async incrementIncidentTemplateUsage(id: number): Promise<number> {
    return await this.table("incident_templates").where("id", id).increment("usage_count", 1);
  }
}
