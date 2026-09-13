import type { Knex } from "knex";

// E11 part 3: an endpoint subscribes to a set of monitors or pages, not to
// everything on the instance.
//
// An endpoint today receives its event types for the whole org, so a per-team
// Discord channel wired to `incident.*` hears about every other team's services.
// This adds the filter.
//
// **A table rather than a column, for the same reason `webhook_endpoint_events`
// is one.** A scope is a set, it is queried by the relay on every event, and a
// JSON column would mean either parsing every endpoint's blob per event or
// writing a JSON query that differs on all three supported databases.
//
// **`scope_value` is a string, and for monitors it stores the TAG rather than
// the id.** The tag is what an event actually carries: `monitor_alerts_v2` has
// `monitor_tag`, `incident_monitors` has `monitor_tag`, and the serializers
// publish tags. Storing ids would mean a join on every event to answer a
// question the event already answered. A monitor that is deleted and recreated
// under the same tag keeps its subscriptions, which is the behaviour an operator
// expects from a name they chose.
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable("webhook_endpoint_scopes")) return;

  await knex.schema.createTable("webhook_endpoint_scopes", (table) => {
    table.increments("id").primary();
    table.integer("endpoint_id").unsigned().notNullable();

    // MONITOR | PAGE. Two kinds rather than one opaque value, because they are
    // resolved from different parts of an event and a future kind (a category,
    // say) must not be mistaken for either.
    table.string("scope_type", 32).notNullable();

    // A monitor tag or a page slug.
    table.string("scope_value", 255).notNullable();

    table.unique(["endpoint_id", "scope_type", "scope_value"], { indexName: "uq_webhook_endpoint_scopes" });

    // The relay's lookup: every scope for one endpoint, once per event.
    table.index(["endpoint_id"], "idx_webhook_endpoint_scopes_endpoint");

    // Cascade, matching `webhook_endpoint_events`: a scope is configuration
    // rather than evidence, and it is meaningless without its endpoint.
    table.foreign("endpoint_id").references("id").inTable("webhook_endpoints").onDelete("CASCADE");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("webhook_endpoint_scopes");
}
