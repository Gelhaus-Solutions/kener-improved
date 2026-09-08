import seedPagesData from "../src/lib/server/db/seedPagesData.ts";
import { DEFAULT_ORG_ID } from "../src/lib/server/db/provisionOrg.ts";
import type { Knex } from "knex";

/**
 * Starter pages for the default org.
 *
 * Scoped by org rather than asking whether the whole table is empty. Not yet
 * extracted into `provisionOrg`: `pages.page_path` is still globally unique, so
 * a second org cannot have a home page (path `""`) until I3b swaps that key.
 */
export async function seed(knex: Knex): Promise<void> {
  const pageCount = await knex("pages").where({ org_id: DEFAULT_ORG_ID }).count("id as CNT").first();

  if (pageCount && pageCount.CNT == 0) {
    // Insert seed pages
    for (const page of seedPagesData) {
      const [insertedPage] = await knex("pages")
        .insert({
          org_id: DEFAULT_ORG_ID,
          page_path: page.page_path,
          page_title: page.page_title,
          page_header: page.page_header,
          page_subheader: page.page_subheader,
          page_logo: page.page_logo,
          page_settings_json: page.page_settings_json,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        })
        .returning("id");

      // For the home page, add the default monitor (earth) if it exists
      if (page.page_path === "") {
        const earthMonitor = await knex("monitors").where({ tag: "earth", org_id: DEFAULT_ORG_ID }).first();
        if (earthMonitor) {
          const pageId = typeof insertedPage === "object" ? insertedPage.id : insertedPage;
          await knex("pages_monitors").insert({
            org_id: DEFAULT_ORG_ID,
            page_id: pageId,
            monitor_tag: "earth",
            monitor_settings_json: "",
            position: 0,
            created_at: knex.fn.now(),
            updated_at: knex.fn.now(),
          });
        }

        const kenerMonitor = await knex("monitors").where({ tag: "kener", org_id: DEFAULT_ORG_ID }).first();
        if (kenerMonitor) {
          const pageId = typeof insertedPage === "object" ? insertedPage.id : insertedPage;
          await knex("pages_monitors").insert({
            org_id: DEFAULT_ORG_ID,
            page_id: pageId,
            monitor_tag: "kener",
            monitor_settings_json: "",
            position: 1,
            created_at: knex.fn.now(),
            updated_at: knex.fn.now(),
          });
        }
      }
    }
  }
}
