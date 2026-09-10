import type { Knex } from "knex";

// G4. Per-page custom domains: `status.acme.com` serves one page,
// `status.other.com` serves another, from one instance.
//
// **A refinement of `org_domains`, not a replacement.** P4 added `org_domains`
// so a hostname could select a *tenant*; this selects a tenant *and* one of its
// pages. Both are consulted, and `page_domains` wins because it is the more
// specific answer - a hostname in both tables is a configuration mistake, and
// resolving it deterministically is better than resolving it by whichever query
// happened to run first.
//
// `hostname` is UNIQUE for the same reason it is on `org_domains`: a hostname
// that resolved to two pages would serve one customer's incidents under
// another's domain. The constraint cannot span the two tables, so the
// resolution order is what makes the overlap case safe.
//
// TLS is deliberately not modelled. Deployment is Docker Compose behind a
// reverse proxy, so certificates are Caddy's or Traefik's job; building ACME
// into the app would duplicate something the proxy already does better.

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable("page_domains")) return;

  await knex.schema.createTable("page_domains", (table) => {
    table.increments("id").primary();
    table.integer("org_id").notNullable().references("id").inTable("orgs").onDelete("CASCADE");
    // Deleting a page must not leave a hostname resolving to nothing, which
    // would 500 every request to it rather than falling through.
    table.integer("page_id").notNullable().references("id").inTable("pages").onDelete("CASCADE");

    table.string("hostname", 255).notNullable().unique();

    // Same vocabulary as `org_domains`: only ACTIVE resolves. A PENDING domain
    // is one an operator has added but not yet pointed at the instance, and it
    // must not start serving a page the moment somebody else's DNS is wrong.
    table.string("status", 32).notNullable().defaultTo("PENDING");

    // Which hostname to build absolute URLs with when a page has several.
    // Without it, "the page's URL" is whichever row came back first.
    table.string("is_primary", 15).notNullable().defaultTo("NO");

    // When it was last confirmed to reach this instance. Separate from `status`
    // on purpose: the status is the gate, this is the evidence behind it.
    table.integer("verified_at").nullable();

    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.timestamp("updated_at").defaultTo(knex.fn.now());

    table.index(["org_id"], "idx_page_domains_org_id");
    table.index(["page_id"], "idx_page_domains_page_id");
    // The resolution lookup: every public request does it.
    table.index(["status", "hostname"], "idx_page_domains_status_hostname");
  });
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("page_domains"))) return;
  await knex.schema.dropTable("page_domains");
}
