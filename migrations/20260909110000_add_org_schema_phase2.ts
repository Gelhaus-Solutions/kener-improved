import type { Knex } from "knex";

// Organisations, phase 2: the unique keys become per-org.
//
// Phase 1 (`20260909100000_add_org_schema_phase1.ts`) added every `org_id` and
// backfilled it. This phase makes the constraints match, so a second
// organisation can have its own home page, its own `siteName`, its own trigger
// named "slack" and its own subscriber with a given email address. Until this
// runs, all of those are instance-wide and `provisionOrg` can only provision
// roles and monitors.
//
// **NOT NULL is deliberately NOT here.** I3b originally specified it, but no
// insert path in the codebase sets `org_id` yet: only the event bus, webhooks,
// the audit log, sessions and api keys are org-aware. Making the column NOT NULL
// today would break creating a monitor, a page, an incident or a subscriber, and
// the only way to avoid that would be a `DEFAULT 1` on twenty-five columns -
// which is exactly the footgun that silently lands a mis-contexted row in the
// default org. NOT NULL belongs in I3d, once the repositories populate the
// column. The one exception is forced by SQL itself and called out below.
//
// **No dialect tiering, unlike phase 1**, and that is not an oversight. Every
// unique key this migration touches is a standalone `CREATE UNIQUE INDEX`, not a
// table-level constraint declared inside `createTable`, so dropping one is a
// plain `DROP INDEX` on every dialect: no table rebuild, and therefore none of
// the silent cascade data loss that forced phase 1 to skip foreign keys on
// SQLite. Verified against a populated database before this was written.
//
// The single rebuild is `general_email_templates`, whose primary key has to be
// widened. It has no child tables at all, so there is nothing for a rebuild to
// cascade into. That is what makes it safe, and it is why the check below is
// written as an assertion rather than a comment: if a future migration gives
// that table a child, this one must be revisited.

/** The org every pre-tenancy row belongs to. Mirrors phase 1; migrations stay self-contained. */
const DEFAULT_ORG_ID = 1;

/**
 * Global unique keys that become per-org.
 *
 * `from` is the index upstream created, `to` the composite that replaces it. The
 * names are knex's own convention (`<table>_<columns>_unique`) so that a future
 * `dropUnique([...])` finds them without being told.
 */
const UNIQUE_SWAPS: Array<{ table: string; column: string; from: string; to: string }> = [
  // Nothing has a foreign key to `pages.page_path` - `pages_monitors` references
  // `pages.id` - so this is the cheap one. Afterwards the home page
  // (`page_path = ''`) exists once per org, which is the point.
  { table: "pages", column: "page_path", from: "pages_page_path_unique", to: "pages_org_id_page_path_unique" },
  { table: "triggers", column: "name", from: "triggers_name_unique", to: "triggers_org_id_name_unique" },
  // A10's rotation renames rather than duplicates because this key exists. That
  // stays true, just within an org now.
  { table: "api_keys", column: "name", from: "api_keys_name_unique", to: "api_keys_org_id_name_unique" },
  { table: "site_data", column: "key", from: "site_data_key_unique", to: "site_data_org_id_key_unique" },
  {
    table: "subscriber_users",
    column: "email",
    from: "subscriber_users_email_unique",
    to: "subscriber_users_org_id_email_unique",
  },
  {
    table: "oidc_group_role_mappings",
    column: "oidc_group",
    from: "oidc_group_role_mappings_oidc_group_unique",
    to: "oidc_group_role_mappings_org_id_oidc_group_unique",
  },
];

/**
 * Composite keys with no global predecessor.
 *
 * `monitors.slug` and `roles.role_key` were added nullable and backfilled by
 * phase 1 and have never had a constraint. `monitors.tag` and `roles.id` stay
 * globally unique underneath them, on purpose: see phase 1's header for why the
 * tag is the immutable physical key.
 */
const NEW_UNIQUES: Array<{ table: string; column: string; name: string }> = [
  { table: "monitors", column: "slug", name: "monitors_org_id_slug_unique" },
  { table: "roles", column: "role_key", name: "roles_org_id_role_key_unique" },
];

function isSqlite(knex: Knex): boolean {
  const client = knex.client.config.client;
  return client === "better-sqlite3" || client === "sqlite3";
}

function isPostgres(knex: Knex): boolean {
  const client = knex.client.config.client;
  return client === "pg" || client === "postgres" || client === "postgresql";
}

/**
 * Whether an index exists, by name.
 *
 * Every step below is guarded on this rather than wrapped in try/catch, because
 * **on Postgres you cannot catch and continue inside a migration**: one failed
 * statement aborts the whole transaction, so every later statement dies with
 * "current transaction is aborted" no matter what the catch block does. Being
 * re-runnable means never issuing a statement that can fail.
 */
async function indexExists(knex: Knex, table: string, name: string): Promise<boolean> {
  if (isSqlite(knex)) {
    const row = await knex("sqlite_master").where({ type: "index", name }).first();
    return !!row;
  }
  if (isPostgres(knex)) {
    const result = await knex.raw("select 1 from pg_indexes where indexname = ? limit 1", [name]);
    return result.rows.length > 0;
  }
  // MySQL and MariaDB.
  const result = await knex.raw(
    "select 1 from information_schema.statistics where table_schema = database() and table_name = ? and index_name = ? limit 1",
    [table, name],
  );
  const rows = Array.isArray(result) ? result[0] : result;
  return Array.isArray(rows) && rows.length > 0;
}

/** The columns of a table's primary key, in order. Used to make the widening re-runnable. */
async function primaryKeyColumns(knex: Knex, table: string): Promise<string[]> {
  if (isSqlite(knex)) {
    const rows: Array<{ name: string; pk: number }> = await knex.raw(`pragma table_info(??)`, [table]);
    return rows
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
  }
  if (isPostgres(knex)) {
    const result = await knex.raw(
      `select a.attname as name
         from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = to_regclass(?) and i.indisprimary`,
      [table],
    );
    return result.rows.map((r: { name: string }) => r.name);
  }
  const result = await knex.raw(
    `select column_name as name from information_schema.statistics
      where table_schema = database() and table_name = ? and index_name = 'PRIMARY'
      order by seq_in_index`,
    [table],
  );
  const rows = Array.isArray(result) ? result[0] : result;
  return (rows as Array<{ name: string }>).map((r) => r.name);
}

/** Rows sharing a value that is about to become unique only within an org. Used by `down()`. */
async function hasGlobalDuplicates(knex: Knex, table: string, column: string): Promise<boolean> {
  const rows = await knex(table).select(column).count({ n: "*" }).groupBy(column).having(knex.raw("count(*) > 1"));
  return rows.length > 0;
}

export async function up(knex: Knex): Promise<void> {
  // ---- 1. The one table phase 1 missed ------------------------------------
  //
  // `oidc_group_role_mappings` is in neither of phase 1's lists, because it maps
  // an identity-provider group to a role and reads as instance-level. It is not:
  // the role it points at belongs to an org, so the mapping does too, and two
  // orgs federating from the same IdP will both want to map their own "eng"
  // group. Additive and backfilled here rather than in a third migration.
  if (
    (await knex.schema.hasTable("oidc_group_role_mappings")) &&
    !(await knex.schema.hasColumn("oidc_group_role_mappings", "org_id"))
  ) {
    // No foreign key, on any dialect. Phase 1's reasoning applies unchanged: an
    // FK-bearing ADD COLUMN is a table rebuild on SQLite, and a rebuild inside a
    // transaction cascades because `PRAGMA foreign_keys = OFF` is a no-op there.
    await knex.schema.alterTable("oidc_group_role_mappings", (t) => {
      t.integer("org_id").nullable();
      t.index(["org_id"], "idx_oidc_group_role_mappings_org_id");
    });
  }
  if (await knex.schema.hasColumn("oidc_group_role_mappings", "org_id")) {
    await knex("oidc_group_role_mappings").whereNull("org_id").update({ org_id: DEFAULT_ORG_ID });
  }

  // ---- 2. Backfill anything phase 1 left behind ---------------------------
  //
  // Phase 1's backfills are conditional on the column being NULL, so a row
  // inserted between the two migrations running has a NULL `org_id` and would
  // silently fall outside every composite index built below. Cheap to repeat.
  for (const { table } of [...UNIQUE_SWAPS, ...NEW_UNIQUES]) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, "org_id"))) continue;
    await knex(table).whereNull("org_id").update({ org_id: DEFAULT_ORG_ID });
  }
  if (await knex.schema.hasColumn("monitors", "slug")) {
    await knex("monitors")
      .whereNull("slug")
      .update({ slug: knex.ref("tag") });
  }
  if (await knex.schema.hasColumn("roles", "role_key")) {
    await knex("roles")
      .whereNull("role_key")
      .update({ role_key: knex.ref("id") });
  }

  // ---- 3. The swaps -------------------------------------------------------
  //
  // New index first, old index second. If the migration dies between the two the
  // table is over-constrained rather than under-constrained, which is a failure
  // that shows up as a rejected write instead of as duplicate rows.
  for (const swap of UNIQUE_SWAPS) {
    if (!(await knex.schema.hasTable(swap.table))) continue;
    if (!(await knex.schema.hasColumn(swap.table, "org_id"))) continue;

    if (!(await indexExists(knex, swap.table, swap.to))) {
      await knex.schema.alterTable(swap.table, (t) => {
        t.unique(["org_id", swap.column], { indexName: swap.to });
      });
    }
    if (await indexExists(knex, swap.table, swap.from)) {
      await knex.schema.alterTable(swap.table, (t) => {
        t.dropUnique([swap.column], swap.from);
      });
    }
  }

  for (const entry of NEW_UNIQUES) {
    if (!(await knex.schema.hasTable(entry.table))) continue;
    if (!(await knex.schema.hasColumn(entry.table, entry.column))) continue;
    if (await indexExists(knex, entry.table, entry.name)) continue;
    await knex.schema.alterTable(entry.table, (t) => {
      t.unique(["org_id", entry.column], { indexName: entry.name });
    });
  }

  // ---- 4. The email templates primary key ---------------------------------
  //
  // `general_email_templates` keys on `template_id` alone, so the five seeded
  // templates are instance-wide and a second org cannot have its own wording.
  // Widening the primary key is the only structural rewrite in this migration.
  //
  // **This is the one place `org_id` becomes NOT NULL**, and it is not a choice:
  // a primary key column cannot be nullable, so Postgres sets NOT NULL as part
  // of `ADD PRIMARY KEY`. Every writer of this table is org-aware as of the same
  // commit (`emailTemplateConfig.ts`), and the seed already sets `org_id`.
  if (await knex.schema.hasTable("general_email_templates")) {
    const pk = await primaryKeyColumns(knex, "general_email_templates");
    if (!pk.includes("org_id")) {
      // A rebuild on SQLite. Safe only because nothing references this table;
      // that is what makes the DROP TABLE inside knex's rebuild harmless. If a
      // child ever appears, this migration is the thing that breaks it.
      await knex("general_email_templates").whereNull("org_id").update({ org_id: DEFAULT_ORG_ID });
      await knex.schema.alterTable("general_email_templates", (t) => {
        t.dropPrimary();
        t.primary(["org_id", "template_id"]);
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Reverting is only possible while the data still fits a global key. Once a
  // second org has its own home page or its own `siteName`, restoring the global
  // unique index would fail - so each one is checked first and skipped loudly
  // rather than aborting the rollback. A partially reverted schema is recoverable;
  // a rollback that throws half way through is not.
  if (await knex.schema.hasTable("general_email_templates")) {
    const pk = await primaryKeyColumns(knex, "general_email_templates");
    if (pk.includes("org_id")) {
      if (await hasGlobalDuplicates(knex, "general_email_templates", "template_id")) {
        console.warn(
          "[org phase 2 down] general_email_templates has per-org duplicates; leaving the composite primary key in place",
        );
      } else {
        await knex.schema.alterTable("general_email_templates", (t) => {
          t.dropPrimary();
          t.primary(["template_id"]);
        });
      }
    }
  }

  for (const entry of NEW_UNIQUES) {
    if (!(await knex.schema.hasTable(entry.table))) continue;
    if (!(await indexExists(knex, entry.table, entry.name))) continue;
    await knex.schema.alterTable(entry.table, (t) => {
      t.dropUnique(["org_id", entry.column], entry.name);
    });
  }

  for (const swap of [...UNIQUE_SWAPS].reverse()) {
    if (!(await knex.schema.hasTable(swap.table))) continue;

    if (!(await indexExists(knex, swap.table, swap.from))) {
      if (await hasGlobalDuplicates(knex, swap.table, swap.column)) {
        console.warn(
          `[org phase 2 down] ${swap.table}.${swap.column} holds values that are unique only per org; ` +
            "the global unique index cannot be restored and is being skipped",
        );
      } else {
        await knex.schema.alterTable(swap.table, (t) => {
          t.unique([swap.column], { indexName: swap.from });
        });
      }
    }
    if (await indexExists(knex, swap.table, swap.to)) {
      await knex.schema.alterTable(swap.table, (t) => {
        t.dropUnique(["org_id", swap.column], swap.to);
      });
    }
  }

  // `oidc_group_role_mappings.org_id` is left in place on every dialect. It is
  // nullable and unreferenced, so it costs nothing, and dropping a column is a
  // table rebuild on SQLite - the operation phase 1 established we do not do.
}
