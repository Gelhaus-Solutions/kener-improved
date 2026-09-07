import type { Knex } from "knex";
import knexOb from "../../../../knexfile.js";

// The single home for "which database are we on" outside of migrations.
//
// AGENTS.md splits database work into two tiers: Tier 1 (core schema and CRUD)
// must work identically on SQLite, PostgreSQL and MySQL, while Tier 2 (rollups,
// partitioning, full-text search, reporting, row-level security) treats
// PostgreSQL as the reference implementation and gives the other two a
// correct-but-slower fallback or disables the feature at runtime.
//
// Deciding that per feature needs a dialect check somewhere. The rule is that
// it happens here and nowhere else: a repository asks whether a *capability* is
// available, never whether the client string is "pg". That keeps the list of
// things Postgres does better in one readable file instead of scattered across
// twelve repositories, and it means adding a dialect later is one edit.
//
// Migrations are the deliberate exception: they run outside the app and check
// `knex.client.config.client` directly. See
// migrations/20260831120000_monitoring_data_autovacuum.ts for that pattern.

export type Dialect = "postgresql" | "mysql" | "sqlite";

// Knex identifies a connection by driver name; knexfile.ts calls the same thing
// by URL scheme. Both spellings map onto one dialect.
const DIALECT_BY_CLIENT: Record<string, Dialect> = {
  pg: "postgresql",
  postgres: "postgresql",
  postgresql: "postgresql",
  mysql: "mysql",
  mysql2: "mysql",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  "better-sqlite3": "sqlite",
};

/**
 * The dialect in use.
 *
 * Pass a Knex instance to ask about that specific connection; this matters for
 * tests, which build their own in-memory better-sqlite3 instance rather than
 * the one knexfile.ts configured. With no argument it answers for the app's
 * configured database.
 */
export function dialectOf(knex?: Knex): Dialect {
  const client = knex ? ((knex.client as { config?: { client?: string } })?.config?.client ?? "") : knexOb.databaseType;
  const dialect = DIALECT_BY_CLIENT[String(client).toLowerCase()];
  if (!dialect) {
    // knexfile.ts already exits on an unknown database type, so reaching this
    // means a Knex instance was built by hand with an unfamiliar driver.
    // Treat it as the least capable dialect rather than guessing upward.
    console.warn(`Unknown database client "${client}", assuming SQLite capabilities`);
    return "sqlite";
  }
  return dialect;
}

/**
 * Native declarative table partitioning (`PARTITION BY RANGE`).
 *
 * Postgres only. SQLite and MySQL get a single unpartitioned table plus
 * range-delete retention, which is correct but slower to prune.
 */
export function hasDeclarativePartitioning(knex?: Knex): boolean {
  return dialectOf(knex) === "postgresql";
}

/**
 * Server-side full-text search (`tsvector` / `to_tsquery`).
 *
 * Postgres only. SQLite and MySQL get a `LIKE`-based fallback: correct, but it
 * cannot rank and does not use an index. MySQL's `FULLTEXT` is deliberately not
 * claimed here, because its `MATCH ... AGAINST` syntax shares nothing with the
 * Postgres query path and would be a second implementation, not a fallback.
 */
export function hasFullTextSearch(knex?: Knex): boolean {
  return dialectOf(knex) === "postgresql";
}

/**
 * `INSERT ... RETURNING`, so a write can read back the stored row without a
 * follow-up SELECT.
 *
 * Everything except MySQL, where knex silently ignores `.returning()` and hands
 * back an insert id instead, which is a different shape rather than an error.
 * MySQL therefore re-SELECTs after the write: one extra round trip, identical
 * result.
 *
 * SQLite is included on evidence, not on the version number. Verified against
 * this repo's knex 3.1 and better-sqlite3 12.6: an
 * `insert ... onConflict().merge().returning("*")` compiles to a statement
 * ending in `returning *` and returns the full row for both the insert and the
 * update path.
 *
 * Note that the twelve inherited `GetDbType() === "postgresql"` branches in the
 * repositories are narrower than this, since they predate the check. They stay
 * correct, just Postgres-only; fold them in as you touch them.
 */
export function supportsInsertReturning(knex?: Knex): boolean {
  return dialectOf(knex) !== "mysql";
}

/**
 * Row-level security policies (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`).
 *
 * Postgres only, and it is defence in depth rather than the primary control:
 * SQLite and MySQL rely solely on the application-level org scoping, which runs
 * on every dialect including Postgres.
 */
export function hasRowLevelSecurity(knex?: Knex): boolean {
  return dialectOf(knex) === "postgresql";
}

/**
 * A `FLOOR()` function in SQL.
 *
 * Everything except SQLite, which needs `CAST(x AS INT)` instead. Both truncate
 * toward zero, which is the same thing for the non-negative timestamp
 * arithmetic this is used for.
 */
export function hasFloorFunction(knex?: Knex): boolean {
  return dialectOf(knex) !== "sqlite";
}
