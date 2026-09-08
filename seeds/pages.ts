import { DEFAULT_ORG_ID, provisionOrgPages } from "../src/lib/server/db/provisionOrg.ts";
import type { Knex } from "knex";

/**
 * Starter pages for the default org.
 *
 * A wrapper over `provisionOrgPages` as of I3b, which is what unblocked it:
 * `pages.page_path` was globally unique, so a second org could not have a home
 * page (path `""`) and the provisioning could not be shared.
 */
export async function seed(knex: Knex): Promise<void> {
  await provisionOrgPages(knex, DEFAULT_ORG_ID);
}
