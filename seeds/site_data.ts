import { provisionInstanceSiteData } from "../src/lib/server/db/provisionOrg.ts";
import type { Knex } from "knex";

/**
 * The instance layer's settings.
 *
 * **One layer, not one per org, as of I3g.** This used to loop every org and
 * write a full copy of every key into each. That copy is what made the overlay
 * pointless: an org's own row always wins, so an instance default was invisible
 * the moment an org existed and changing one reached nobody.
 *
 * It now tops up `org_id = 0` alone. Orgs inherit, and store a row only for a
 * setting somebody actually changed.
 *
 * **This is still the only thing that reaches an existing install after it is
 * created.** An org gets what `provisionOrg` gave it on the day it was made, and
 * the seeds re-running on every boot are what deliver anything added afterwards.
 * A `site_data` key added in a later release arrives here, at the instance
 * layer, and is immediately visible to every org that has not overridden it -
 * which is a strictly better outcome than I3b's, where the new key had to be
 * written into every org separately and a tenant created before the change would
 * otherwise have kept the setting's pre-change meaning forever.
 */
export async function seed(knex: Knex): Promise<void> {
  await provisionInstanceSiteData(knex);
}
