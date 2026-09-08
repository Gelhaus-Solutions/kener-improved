import type { Knex } from "knex";

// Outbound webhook endpoints: the first real consumer of the event bus.
//
// Note what is *not* here: a deliveries table. Attempts land in
// `event_deliveries` alongside every other outbound channel, which is the whole
// reason that table was built generic. One delivery screen then covers webhooks,
// email and legacy triggers together, and a webhook's dead letters are queryable
// the same way everything else's are.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("webhook_endpoints"))) {
    await knex.schema.createTable("webhook_endpoints", (table) => {
      table.increments("id").primary();

      // Present from birth, defaulted so this migration runs against a live
      // single-org install. P4 backfills rather than adds.
      table.integer("org_id").notNullable().defaultTo(1);

      table.string("name", 255).notNullable();
      table.text("url").notNullable();

      // Encrypted, not hashed: this secret has to be replayed to sign every
      // request, so it must come back out. See crypto/secretBox.ts.
      table.text("secret_encrypted").notNullable();
      // The last four characters, so the UI can say which secret is configured
      // without being able to show it.
      table.string("secret_hint", 32).nullable();

      // Set during a rotation, when both secrets sign for a grace period so a
      // receiver can be updated without dropping a single delivery.
      table.text("previous_secret_encrypted").nullable();
      table.integer("previous_secret_expires_at").nullable();

      // ACTIVE | DISABLED | DISABLED_AUTO
      //
      // DISABLED_AUTO is distinct from DISABLED on purpose: it means Kener
      // stopped sending, not that a human did, and the UI has to say so or the
      // operator goes looking for the colleague who turned it off.
      table.string("status", 32).notNullable().defaultTo("ACTIVE");

      // The payload envelope version this endpoint receives. Frozen per endpoint
      // so a future envelope change cannot break receivers already in the field.
      table.string("api_version", 16).notNullable().defaultTo("2026-09-08");

      // JSON array of {key, value}, matching the shape triggers already use.
      table.text("custom_headers").nullable();
      table.integer("timeout_ms").notNullable().defaultTo(10000);

      // Drives the auto-disable. Reset to zero by any success, so it counts a
      // *run* of failures rather than a lifetime total.
      table.integer("consecutive_failures").notNullable().defaultTo(0);
      table.integer("last_success_at").nullable();
      table.integer("last_failure_at").nullable();

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });

    await knex.schema.alterTable("webhook_endpoints", (table) => {
      // The relay's per-event lookup: active endpoints for one org.
      table.index(["org_id", "status"], "idx_webhook_endpoints_org_status");
    });
  }

  if (!(await knex.schema.hasTable("webhook_endpoint_events"))) {
    await knex.schema.createTable("webhook_endpoint_events", (table) => {
      table.increments("id").primary();
      table.integer("endpoint_id").unsigned().notNullable();

      // An exact type ("incident.resolved") or a domain wildcard
      // ("incident.*"). Two forms rather than a general glob: a wildcard that
      // can match anything is a wildcard somebody eventually points at
      // `user.*`, and administrative events must never be deliverable.
      table.string("event_type", 128).notNullable();

      table.unique(["endpoint_id", "event_type"], { indexName: "uq_webhook_endpoint_events" });
      table.index(["event_type"], "idx_webhook_endpoint_events_type");

      // Cascade here is right, unlike on the delivery tables: a subscription is
      // meaningless without its endpoint, and it is configuration rather than
      // evidence.
      table.foreign("endpoint_id").references("id").inTable("webhook_endpoints").onDelete("CASCADE");
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("webhook_endpoint_events");
  await knex.schema.dropTableIfExists("webhook_endpoints");
}
