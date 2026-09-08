import seedSiteData from "../src/lib/server/db/seedSiteData.ts";
import { DEFAULT_ORG_ID } from "../src/lib/server/db/provisionOrg.ts";
import type { Knex } from "knex";

/**
 * Instance settings, owned by the default org.
 *
 * Scoped by org, though `site_data.key` is still globally unique so today there
 * can only be one row per key anyway. I3g makes these instance defaults with
 * per-org overrides; stamping the org now means that change has correct data to
 * build on rather than a table of unattributed rows.
 */
export async function seed(knex: Knex): Promise<void> {
  const seedDataRecord = seedSiteData as Record<string, unknown>;
  for (const key in seedDataRecord) {
    if (Object.prototype.hasOwnProperty.call(seedDataRecord, key)) {
      let value = seedDataRecord[key];
      let data_type = typeof value;
      if (data_type === "object") {
        value = JSON.stringify(value);
      }
      const existingEntry = await knex("site_data").where({ key: key }).first();
      if (!existingEntry) {
        await knex("site_data").insert([{ key: key, value: value, data_type: data_type, org_id: DEFAULT_ORG_ID }]);
      }
    }
  }
}
