import { provisionOrgMonitors, DEFAULT_ORG_ID } from "../src/lib/server/db/provisionOrg.ts";
import type { Knex } from "knex";

/**
 * Starter monitors for the default org.
 *
 * The emptiness check moved into `provisionOrgMonitors` and is scoped by org.
 * It used to ask whether the whole `monitors` table was empty, which stops being
 * the right question the moment a second org exists: that org would find the
 * table full and be provisioned with nothing.
 */
export async function seed(knex: Knex): Promise<void> {
  await provisionOrgMonitors(knex, DEFAULT_ORG_ID);
}
