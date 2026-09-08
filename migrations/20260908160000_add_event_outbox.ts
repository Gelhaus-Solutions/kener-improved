import type { Knex } from "knex";

// The transactional outbox: the source of truth for everything that happens.
//
// The problem this solves is that Redis is not in the database transaction.
// Enqueueing a BullMQ job after a commit loses the job if the process dies in
// between; enqueueing before the commit lets a worker pick it up and read state
// that was then rolled back. Neither is acceptable for a webhook a customer is
// paying attention to. So the event is written *in the same transaction as the
// state change it describes*, and a relay turns committed rows into delivery
// attempts afterwards. Redis becomes a delivery accelerator that can be flushed
// without losing anything.
//
// Two tables, on purpose:
//
//   event_outbox      what happened, once, in a total order
//   event_deliveries  every attempt to tell somebody about it
//
// event_deliveries deliberately holds webhooks, emails and legacy triggers in
// one table rather than one table per channel. That is what lets a single admin
// screen (E9) show every outbound attempt the system has ever made, and it makes
// the DEAD rows a queryable, retryable dead-letter queue instead of today's
// invisible BullMQ failed set.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("event_outbox"))) {
    await knex.schema.createTable("event_outbox", (table) => {
      // Publish order. Monotonic, database-assigned, and the only thing that
      // defines "before" across the whole instance. Consumers carry it as `seq`
      // so an unordered receiver can still sort.
      table.bigIncrements("id").primary();

      // ULID: sortable like the id, but generatable client-side, which is what
      // lets emit() return an id the caller can reference before the relay has
      // seen the row. 26 chars, Crockford base32.
      table.string("event_id", 26).notNullable().unique();

      // Present from birth, never defaulted at the emit() call site. P4 only has
      // to backfill values here, not add the column and hunt for every writer.
      // DEFAULT 1 keeps this migration runnable against a live single-org
      // install; the *code* still requires org_id explicitly.
      table.integer("org_id").notNullable().defaultTo(1);

      // Dotted taxonomy, e.g. "incident.created". Defined in H8b.
      table.string("type", 128).notNullable();

      table.string("aggregate_type", 64).nullable();
      table.string("aggregate_id", 128).nullable();

      // Denormalised like audit_log's actor, and for the same reason: a user row
      // can be deleted, and an event that can no longer say who caused it has
      // stopped being useful.
      table.string("actor_type", 32).notNullable();
      table.string("actor_id", 128).nullable();
      table.string("actor_label", 255).nullable();

      // UTC seconds, matching every other timestamp in this schema. Distinct
      // from `id` order: occurred_at is when the thing happened, id is when it
      // was committed, and a backfilled incident makes them disagree.
      table.integer("occurred_at").notNullable();

      // JSON text rather than a json column: the three supported dialects
      // disagree on json support and nothing queries inside these.
      table.text("payload").nullable();
      table.text("diff").nullable();

      table.string("correlation_id", 64).nullable();
      table.string("causation_id", 64).nullable();

      // The idempotency guarantee. Nullable, because most events are naturally
      // unique and inventing a key for them is noise; when it is set, a repeated
      // emit() collapses via onConflict().ignore(). All three dialects allow
      // repeated NULLs in a unique index, which is exactly the behaviour wanted.
      table.string("idempotency_key", 255).nullable().unique();

      // Recorded but never delivered. The escape hatch for a bulk import or a
      // replay that must not page anyone at 3am.
      table.boolean("suppress").notNullable().defaultTo(false);
      table.integer("schema_version").notNullable().defaultTo(1);

      // Relay bookkeeping. claimed_by holds a per-relay-run token so a claim can
      // be verified after the fact on dialects without SKIP LOCKED, and
      // claimed_at gives the claim an expiry so a killed relay releases its work.
      table.integer("claimed_at").nullable();
      table.string("claimed_by", 64).nullable();
      table.integer("published_at").nullable();
    });

    await knex.schema.alterTable("event_outbox", (table) => {
      // The relay's scan: unpublished rows in id order. Leading with
      // published_at keeps the claimable set at one end of the index instead of
      // spread through it, which matters once the table is mostly published.
      table.index(["published_at", "id"], "idx_event_outbox_unpublished");
      // Reclaiming expired claims.
      table.index(["claimed_at"], "idx_event_outbox_claimed_at");
      // The delivery-log and per-object history reads.
      table.index(["org_id", "occurred_at"], "idx_event_outbox_org_occurred");
      table.index(["aggregate_type", "aggregate_id", "id"], "idx_event_outbox_aggregate");
      table.index(["type", "id"], "idx_event_outbox_type");
    });
  }

  if (!(await knex.schema.hasTable("event_deliveries"))) {
    await knex.schema.createTable("event_deliveries", (table) => {
      table.bigIncrements("id").primary();

      // Joined on the ULID rather than event_outbox.id so a delivery row can be
      // written by anything holding the event, and so the pair survives a
      // logical dump and reload that renumbers. No foreign key: deliveries are
      // pruned by date like the events are, and a cascade would silently delete
      // the evidence of a failed delivery when its event aged out.
      table.string("event_id", 26).notNullable();
      table.integer("org_id").notNullable().defaultTo(1);

      table.string("consumer", 64).notNullable();

      // NOT NULL with an empty-string default rather than nullable, and this is
      // load-bearing: a UNIQUE index containing a NULL does not deduplicate,
      // because NULL is not equal to NULL. Nullable target columns would let the
      // relay insert the same consumer-level delivery twice after a crash, which
      // is precisely the duplicate this constraint exists to collapse.
      table.string("target_type", 64).notNullable().defaultTo("");
      table.string("target_id", 128).notNullable().defaultTo("");

      // PENDING | IN_FLIGHT | DELIVERED | FAILED | DEAD | SKIPPED | SHADOW
      table.string("status", 16).notNullable();
      table.integer("attempts").notNullable().defaultTo(0);

      // The retry ladder lives here, not in BullMQ. A customer endpoint that is
      // down for an hour needs hours of backoff, and BullMQ's per-queue attempts
      // cannot express that per delivery.
      table.integer("next_attempt_at").nullable();
      table.integer("last_attempt_at").nullable();

      table.integer("response_code").nullable();
      // Truncated by the dispatcher before it gets here. Kept because "it
      // returned 400" without the body is not actionable for whoever has to fix
      // the endpoint.
      table.text("response_body").nullable();
      table.text("error").nullable();

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();

      // The idempotency guarantee on the delivery side. The relay may run twice
      // for the same event after a crash; this is where the second run collapses.
      table.unique(["event_id", "consumer", "target_type", "target_id"], {
        indexName: "uq_event_deliveries_event_consumer_target",
      });
    });

    await knex.schema.alterTable("event_deliveries", (table) => {
      // The sweeper: rows due for another attempt.
      table.index(["status", "next_attempt_at"], "idx_event_deliveries_due");
      // The E9 delivery-log listing.
      table.index(["org_id", "created_at"], "idx_event_deliveries_org_created");
      // Everything that happened to one event.
      table.index(["event_id"], "idx_event_deliveries_event");
      // Per-endpoint health, for showing "this webhook has failed 40 times".
      table.index(["consumer", "target_type", "target_id", "status"], "idx_event_deliveries_target");
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("event_deliveries");
  await knex.schema.dropTableIfExists("event_outbox");
}
