import { BaseRepository } from "./base.js";
import { currentOrgId } from "../../events/eventContext.js";
import type { GeneralEmailTemplateRecord, GeneralEmailTemplateRecordInsert } from "../../types/db.js";

/**
 * Repository for general email templates operations
 *
 * **Org-scoped as of I3b**, which widened this table's primary key from
 * `template_id` to `(org_id, template_id)` so a second organisation can word its
 * own verification and invitation emails. Every method here keyed on
 * `template_id` alone, which after the widening would read, update and delete
 * another org's row.
 *
 * The org defaults to `currentOrgId()` for the reason set out on
 * `SiteDataRepository`: identical behaviour today, correct on its own once I3d
 * populates the context, and no fan-out into every call site in this slice.
 *
 * Note that `org_id` is NOT NULL on this table and only this table - a primary
 * key column cannot be nullable. Every writer below therefore sets it.
 */
export class EmailTemplateConfigRepository extends BaseRepository {
  /**
   * Insert a new email template
   */
  async insertEmailTemplate(
    template: GeneralEmailTemplateRecordInsert,
    orgId: number = currentOrgId(),
  ): Promise<string[]> {
    return await this.knex("general_email_templates").insert({ org_id: orgId, ...template });
  }

  /**
   * Update an existing email template by template_id
   */
  async updateEmailTemplate(
    template_id: string,
    updates: Partial<Omit<GeneralEmailTemplateRecordInsert, "template_id">>,
    orgId: number = currentOrgId(),
  ): Promise<number> {
    return await this.knex("general_email_templates").where({ template_id, org_id: orgId }).update(updates);
  }

  /**
   * Get all email templates
   */
  async getAllEmailTemplates(orgId: number = currentOrgId()): Promise<GeneralEmailTemplateRecord[]> {
    return await this.knex("general_email_templates").where({ org_id: orgId }).select("*");
  }

  /**
   * Get a specific email template by template_id
   */
  async getEmailTemplateById(
    template_id: string,
    orgId: number = currentOrgId(),
  ): Promise<GeneralEmailTemplateRecord | undefined> {
    return await this.knex("general_email_templates").where({ template_id, org_id: orgId }).first();
  }

  /**
   * Delete an email template by template_id
   */
  async deleteEmailTemplate(template_id: string, orgId: number = currentOrgId()): Promise<number> {
    return await this.knex("general_email_templates").where({ template_id, org_id: orgId }).delete();
  }

  /**
   * Insert or update an email template (upsert)
   */
  async upsertEmailTemplate(
    template: GeneralEmailTemplateRecordInsert,
    orgId: number = currentOrgId(),
  ): Promise<number[]> {
    // The conflict target must name both primary key columns, or Postgres has no
    // arbiter to match and the upsert throws instead of merging.
    return await this.knex("general_email_templates")
      .insert({ org_id: orgId, ...template })
      .onConflict(["org_id", "template_id"])
      .merge({
        template_subject: template.template_subject,
        template_html_body: template.template_html_body,
        template_text_body: template.template_text_body,
      });
  }
}
