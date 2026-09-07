import type { Knex } from "knex";

// The v1 subscriber tables (created by 20250417144954_add_subscription_tables)
// were superseded by subscriber_users / subscriber_methods / user_subscriptions_v2
// in 20260128120000_redesign_subscription_system, but were never dropped.
// Verified: zero references anywhere outside their own creating migration.
//
// Dropping them now rather than later keeps the tenancy migration honest, since
// otherwise every dead table needs either a pointless org_id backfill or a
// permanent exception, and it frees the name `subscriptions`.
//
// Rows are archived rather than deleted. Most installs upgraded before v1 ever
// collected a subscriber, so the archive table is created only when there is
// something to put in it. A second migration drops the archive a release later,
// which is the whole point of splitting this in two: this one stays reversible
// for one release.
const V1_TABLES = ["subscription_triggers", "subscriptions", "subscribers"] as const;
const ARCHIVE_TABLE = "subscriptions_archive_v1";

export async function up(knex: Knex): Promise<void> {
  const present: string[] = [];
  for (const table of V1_TABLES) {
    if (await knex.schema.hasTable(table)) present.push(table);
  }

  if (present.length === 0) {
    console.log("v1 subscriber tables: none present, nothing to drop");
    return;
  }

  const rowsByTable = new Map<string, Record<string, unknown>[]>();
  let totalRows = 0;
  for (const table of present) {
    const rows = await knex(table).select("*");
    rowsByTable.set(table, rows);
    totalRows += rows.length;
    console.log(`v1 subscriber tables: ${table} has ${rows.length} row(s)`);
  }

  if (totalRows > 0) {
    if (!(await knex.schema.hasTable(ARCHIVE_TABLE))) {
      await knex.schema.createTable(ARCHIVE_TABLE, (table) => {
        table.increments("id").primary();
        table.string("source_table", 255).notNullable();
        // JSON in a text column rather than a json type: the three dialects
        // disagree on json support and nothing queries into this, it only has
        // to survive one release so the rows can be recovered by hand.
        table.text("row_json").notNullable();
        table.timestamp("archived_at").defaultTo(knex.fn.now());
        table.index(["source_table"], "idx_subscriptions_archive_v1_source_table");
      });
    }

    for (const [table, rows] of rowsByTable) {
      if (rows.length === 0) continue;
      const archived = rows.map((row) => ({
        source_table: table,
        row_json: JSON.stringify(row),
      }));
      // Chunked: SQLite caps bound variables per statement, and these tables
      // have no bound on how many rows an old install accumulated.
      await knex.batchInsert(ARCHIVE_TABLE, archived, 200);
    }
    console.log(`v1 subscriber tables: archived ${totalRows} row(s) into ${ARCHIVE_TABLE}`);
  } else {
    console.log("v1 subscriber tables: all empty, dropping without an archive");
  }

  // Child before parent: subscriptions references subscriber ids by convention
  // (no enforced FK), and this order is the one the original down() used.
  for (const table of V1_TABLES) {
    await knex.schema.dropTableIfExists(table);
  }
}

export async function down(knex: Knex): Promise<void> {
  // Recreates the schemas exactly as 20250417144954 defined them. Rows are NOT
  // restored: they are still in subscriptions_archive_v1 (when one was created)
  // and can be replayed from there by hand. Nothing reads these tables, so an
  // empty rollback is enough to put the schema back.
  if (!(await knex.schema.hasTable("subscribers"))) {
    await knex.schema.createTable("subscribers", (table) => {
      table.increments("id").primary();
      table.string("subscriber_send").notNullable();
      table.text("subscriber_meta").nullable();
      table.string("subscriber_type").notNullable();
      table.string("subscriber_status").notNullable();
      table.datetime("created_at").defaultTo(knex.fn.now());
      table.datetime("updated_at").defaultTo(knex.fn.now());
      table.unique(["subscriber_send", "subscriber_type"]);
      table.index(["subscriber_send"]);
    });
  }

  if (!(await knex.schema.hasTable("subscriptions"))) {
    await knex.schema.createTable("subscriptions", (table) => {
      table.increments("id").primary();
      table.integer("subscriber_id").unsigned().notNullable();
      table.string("subscriptions_status").notNullable();
      table.string("subscriptions_monitors").notNullable();
      table.text("subscriptions_meta").nullable();
      table.datetime("created_at").defaultTo(knex.fn.now());
      table.datetime("updated_at").defaultTo(knex.fn.now());
      table.unique(["subscriber_id", "subscriptions_monitors"]);
      table.index(["subscriptions_status", "subscriptions_monitors"]);
    });
  }

  if (!(await knex.schema.hasTable("subscription_triggers"))) {
    await knex.schema.createTable("subscription_triggers", (table) => {
      table.increments("id").primary();
      table.string("subscription_trigger_type").notNullable().unique();
      table.string("subscription_trigger_status").notNullable();
      table.text("config").nullable();
      table.datetime("created_at").defaultTo(knex.fn.now());
      table.datetime("updated_at").defaultTo(knex.fn.now());
    });
  }
}
