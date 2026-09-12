import { provisionOrgSiteData, provisionableOrgIds } from "../src/lib/server/db/provisionOrg.ts";
import type { Knex } from "knex";

/**
 * Each org's settings.
 *
 * A wrapper over `provisionOrgSiteData` as of I3b, so a fresh install and a
 * newly created org run the same code. The lookup it uses is scoped by
 * `org_id`: while `site_data.key` was globally unique this seed could get away
 * with asking whether the key existed at all, and the moment the key became
 * per-org that question started answering "yes" for every org because of the
 * default org's row.
 *
 * **Every org, not just the default one.** A `site_data` key added after a
 * tenant was created never reached it, and the code fallback for a missing key
 * is usually the *old* default - so the setting silently kept its pre-change
 * meaning for every org but the first. Only missing keys are written; a value a
 * tenant has already set has a row and is skipped.
 */
export async function seed(knex: Knex): Promise<void> {
  for (const orgId of await provisionableOrgIds(knex)) {
    await provisionOrgSiteData(knex, orgId);
  }
}
