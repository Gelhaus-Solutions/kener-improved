import type { Knex } from "knex";

// G7. Full-text search over incident titles and incident comments.
//
// **Postgres only, and a no-op everywhere else.** AGENTS.md's tier-2 rule makes
// Postgres the reference implementation for search; SQLite and MySQL get a
// `LIKE` fallback in the repository, which is correct but cannot rank and cannot
// use an index. `capabilities.hasFullTextSearch()` is the single runtime gate,
// and it already documents why MySQL's `FULLTEXT` is deliberately not claimed:
// `MATCH ... AGAINST` shares no syntax with the Postgres path, so it would be a
// second implementation rather than a fallback.
//
// **Generated STORED columns rather than expression indexes.** An expression
// index on `to_tsvector('english', title)` only gets used when the query repeats
// that expression *exactly* - same function, same config argument, same casts - and
// nothing enforces it. A drift that loses the index is invisible: the query
// still returns the right rows, just by sequential scan, and nobody notices
// until the table is large. A stored column moves that agreement into the schema
// where it cannot drift, at the cost of some disk.
//
// `coalesce` because `to_tsvector` of NULL is NULL, which would make the column
// NULL and silently exclude the row from every search. `title` is NOT NULL today
// and `comment` is too, but a generated column outlives the constraint that
// happened to be there when it was written.
//
// The `'english'::regconfig` literal is what makes the expression IMMUTABLE and
// therefore legal in a generated column: the two-argument `to_tsvector` is
// immutable, while the one-argument form depends on a session GUC and is not.

const INCIDENT_INDEX = "idx_incidents_search_tsv";
const COMMENT_INDEX = "idx_incident_comments_search_tsv";

export async function up(knex: Knex): Promise<void> {
  if (knex.client.config.client !== "pg") return;

  if (await knex.schema.hasTable("incidents")) {
    if (!(await knex.schema.hasColumn("incidents", "search_tsv"))) {
      await knex.raw(
        `ALTER TABLE incidents ADD COLUMN search_tsv tsvector
         GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(title, ''))) STORED`,
      );
    }
    // Concurrently is not available inside knex's migration transaction, and a
    // status page's incident table is small enough that a plain build is a
    // non-event. `IF NOT EXISTS` keeps a re-run harmless.
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${INCIDENT_INDEX} ON incidents USING GIN (search_tsv)`);
  }

  if (await knex.schema.hasTable("incident_comments")) {
    if (!(await knex.schema.hasColumn("incident_comments", "search_tsv"))) {
      await knex.raw(
        `ALTER TABLE incident_comments ADD COLUMN search_tsv tsvector
         GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(comment, ''))) STORED`,
      );
    }
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${COMMENT_INDEX} ON incident_comments USING GIN (search_tsv)`);
  }

  // The keyset order is `(start_date_time DESC, id DESC)` within an org, so this
  // is the index that makes paging deep into history constant-time rather than
  // a sort of the whole table. Column order matters: `org_id` first because it
  // is the equality predicate.
  if (await knex.schema.hasTable("incidents")) {
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_incidents_org_start_id
       ON incidents (org_id, start_date_time DESC, id DESC)`,
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  if (knex.client.config.client !== "pg") return;

  await knex.raw(`DROP INDEX IF EXISTS ${INCIDENT_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${COMMENT_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS idx_incidents_org_start_id`);

  if (await knex.schema.hasTable("incidents")) {
    if (await knex.schema.hasColumn("incidents", "search_tsv")) {
      await knex.raw(`ALTER TABLE incidents DROP COLUMN search_tsv`);
    }
  }
  if (await knex.schema.hasTable("incident_comments")) {
    if (await knex.schema.hasColumn("incident_comments", "search_tsv")) {
      await knex.raw(`ALTER TABLE incident_comments DROP COLUMN search_tsv`);
    }
  }
}
