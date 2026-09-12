import { provisionOrgTemplates, provisionableOrgIds } from "../src/lib/server/db/provisionOrg.ts";
import type { Knex } from "knex";

/**
 * Each org's transactional email templates.
 *
 * A wrapper over `provisionOrgTemplates` as of I3b. This file used to repeat the
 * same twelve-line block five times, each asking `where({ template_id })` with
 * no org - a lookup that finds another org's row now that the primary key is
 * `(org_id, template_id)`.
 *
 * **Every org, not just the default one.** A template added after a tenant was
 * created never reached it, which is a transactional email that tenant cannot
 * send. Only missing templates are written; one a tenant has edited has a row
 * and is skipped.
 */
export async function seed(knex: Knex): Promise<void> {
  for (const orgId of await provisionableOrgIds(knex)) {
    await provisionOrgTemplates(knex, orgId);
  }
}
