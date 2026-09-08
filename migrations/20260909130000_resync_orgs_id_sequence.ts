import type { Knex } from "knex";

// Puts `orgs.id`'s Postgres sequence back in step with the rows that exist.
//
// Phase 1 inserts the default org with an **explicit** `id`, because everything
// predating tenancy has to point at a known number. On Postgres an explicit id
// does not advance the identity sequence behind `increments()`, so the sequence
// still reports `last_value = 1, is_called = false` and the next `nextval` hands
// back 1 - the id the default org already holds.
//
// Nothing noticed while orgs were only ever created by a migration or a seed,
// both of which name their own id. I3f added the first insert that does not:
// creating an organisation from the admin. On any Postgres install the *first*
// one fails with
//
//   duplicate key value violates unique constraint "orgs_pkey"
//
// and it fails every time, because a failed insert does not advance the sequence
// either. SQLite is unaffected: its rowid allocator reads the table's maximum
// rather than a counter kept beside it.
//
// A migration rather than a fix in `createOrg`, because the desynchronised
// sequence is a property of the database that phase 1 left behind, and repairing
// it once is better than working around it on every insert. Phase 1's insert is
// the only place an org id is ever supplied by hand, so one resync is enough.

export async function up(knex: Knex): Promise<void> {
  const client = knex.client.config.client;
  if (client === "better-sqlite3" || client === "sqlite3") return;
  if (!(await knex.schema.hasTable("orgs"))) return;

  // `setval(..., max(id), true)` marks the sequence as called, so the next
  // `nextval` is `max(id) + 1`. `COALESCE` covers an orgs table that is somehow
  // empty, where the sequence should start at 1 and not yet be called.
  //
  // `pg_get_serial_sequence` rather than the literal `orgs_id_seq`: it resolves
  // the sequence actually attached to the column, so this keeps working under a
  // non-default schema and under an identity column.
  await knex.raw(`
    select setval(
      pg_get_serial_sequence('orgs', 'id'),
      coalesce((select max(id) from orgs), 1),
      (select count(*) > 0 from orgs)
    )
  `);
}

export async function down(): Promise<void> {
  // Nothing to undo. Winding the sequence back would only recreate the collision
  // this exists to remove, and a sequence's value is not state anyone can
  // meaningfully restore.
}
