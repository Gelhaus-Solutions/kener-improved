import { DEFAULT_ORG_ID, provisionOrgSiteData } from "../src/lib/server/db/provisionOrg.ts";
import type { Knex } from "knex";

/**
 * Instance settings, owned by the default org.
 *
 * A wrapper over `provisionOrgSiteData` as of I3b, so a fresh install and a
 * newly created org run the same code. The lookup it now uses is scoped by
 * `org_id`: while `site_data.key` was globally unique this seed could get away
 * with asking whether the key existed at all, and the moment the key became
 * per-org that question started answering "yes" for every org because of the
 * default org's row.
 */
export async function seed(knex: Knex): Promise<void> {
  await provisionOrgSiteData(knex, DEFAULT_ORG_ID);
}
