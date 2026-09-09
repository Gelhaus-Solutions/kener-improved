import type { Knex } from "knex";

// E1: subscriptions that can name a scope, a severity floor and a channel.
//
// Today a subscription is all-or-nothing per event class: `user_subscriptions_v2`
// carries an `event_type` of `incidents` or `maintenances` and nothing else, so a
// customer who cares about one component has to take every notification the
// instance sends or none of them. Requested upstream three times.
//
// **A new table rather than columns on the old one.** Adding `scope_type` and
// friends to `user_subscriptions_v2` would mean widening its UNIQUE, which is
// `(subscriber_user_id, subscriber_method_id, event_type)` - a table rebuild on
// SQLite with everything that implies, and a migration that cannot be rolled back
// without losing rows. A second table is additive, and it lets the old one keep
// being written for a release so a rollback is a redeploy rather than a restore.
// Subscriber lists are not something to reconstruct.
//
// Note the name: `subscriptions` is taken by a dead v1 table until Z7 drops it.

const TABLE = "subscriber_subscriptions";

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (table) => {
    table.increments("id").primary();
    // Not nullable from birth. Every tenant table added after I3b starts this
    // way; the phase 3 migration exists only because the older ones did not.
    table.integer("org_id").notNullable();
    table.integer("subscriber_user_id").notNullable();
    // The channel. A person with an email address and a webhook can want
    // different things on each, which is the whole reason this is per method
    // rather than per user.
    table.integer("subscriber_method_id").notNullable();

    // ALL | PAGE | COMPONENT | GROUP.
    table.string("scope_type", 20).notNullable().defaultTo("ALL");
    /**
     * The page id or monitor tag this subscription is about.
     *
     * **Empty string for ALL, never null.** It is part of the UNIQUE below, and a
     * NULL in a unique index does not deduplicate on either dialect - so a null
     * here would let one subscriber accumulate unlimited identical ALL-scope
     * rows and be emailed once per row.
     */
    table.string("scope_id", 255).notNullable().defaultTo("");

    // `incidents` | `maintenances`, matching user_subscriptions_v2.event_type.
    table.string("event_class", 50).notNullable();

    /**
     * The lowest incident severity worth an email, or ANY.
     *
     * **Incidents only.** Maintenance notifications are governed solely by
     * subscribing to the maintenance class, because `MAINTENANCE` ranks below
     * `MINOR` in the incident vocabulary and letting this filter both would mean
     * a customer who set a severity floor silently stopped hearing about
     * scheduled work. A severity floor must not become a maintenance opt-out.
     */
    table.string("min_severity", 20).notNullable().defaultTo("ANY");

    /** JSON array of event types, or NULL for the class default. */
    table.text("notify_on").nullable();

    table.string("status", 20).notNullable().defaultTo("ACTIVE");
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.timestamp("updated_at").defaultTo(knex.fn.now());

    table.foreign("subscriber_user_id").references("id").inTable("subscriber_users").onDelete("CASCADE");
    table.foreign("subscriber_method_id").references("id").inTable("subscriber_methods").onDelete("CASCADE");

    // One subscription per channel per scope per class. Keyed on the method
    // rather than the user because the method is the thing that receives.
    table.unique(["subscriber_method_id", "scope_type", "scope_id", "event_class"], {
      indexName: "subscriber_subscriptions_method_scope_class_unique",
    });
    table.index(["org_id"], "idx_subscriber_subscriptions_org_id");
    table.index(["event_class", "status"], "idx_subscriber_subscriptions_class_status");
  });

  // ---- backfill: every existing subscription, unchanged in effect ---------
  //
  // ALL scope and no severity floor, which is exactly what the old row meant.
  // The acceptance criterion for this item is that an existing subscriber
  // receives precisely what they did before, and this is the line that has to be
  // right for that to hold.
  if (!(await knex.schema.hasTable("user_subscriptions_v2"))) return;

  const existing = await knex("user_subscriptions_v2").select(
    "org_id",
    "subscriber_user_id",
    "subscriber_method_id",
    "event_type",
    "status",
  );
  if (existing.length === 0) return;

  const rows = existing.map((row) => ({
    org_id: row.org_id ?? 1,
    subscriber_user_id: row.subscriber_user_id,
    subscriber_method_id: row.subscriber_method_id,
    scope_type: "ALL",
    scope_id: "",
    event_class: row.event_type,
    min_severity: "ANY",
    notify_on: null,
    status: row.status ?? "ACTIVE",
  }));

  // Chunked because an instance with a large subscriber list would otherwise
  // build one statement with tens of thousands of bound parameters, which
  // SQLite refuses outright.
  for (let i = 0; i < rows.length; i += 200) {
    await knex(TABLE).insert(rows.slice(i, i + 200));
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
