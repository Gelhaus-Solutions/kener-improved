import { DEFAULT_ORG_ID, provisionOrgTemplates } from "../src/lib/server/db/provisionOrg.ts";
import type { Knex } from "knex";

/**
 * The transactional email templates, owned by the default org.
 *
 * A wrapper over `provisionOrgTemplates` as of I3b. This file used to repeat the
 * same twelve-line block five times, each asking `where({ template_id })` with
 * no org - a lookup that finds another org's row now that the primary key is
 * `(org_id, template_id)`.
 */
export async function seed(knex: Knex): Promise<void> {
  await provisionOrgTemplates(knex, DEFAULT_ORG_ID);
}
