import type { Knex } from "knex";

// Organisations, phase 3: `org_id` becomes NOT NULL.
//
// Deferred from I3b, and deliberately so. At that point no insert path set
// `org_id` at all, so adding the constraint would have broken creating a
// monitor. I3c/I3d made `BaseRepository.table()` stamp it onto every insert into
// a tenant table, so the column is now populated by construction and the
// constraint records a fact rather than imposing one.
//
// **Postgres only, and that is not a shortcut.** knex implements
// `.notNullable().alter()` on SQLite as a table rebuild - create a temp table,
// copy, `DROP TABLE` the original, rename - and `PRAGMA foreign_keys = OFF` is a
// no-op inside a transaction, which every knex migration runs in. So the drop
// cascades: making `roles.org_id` NOT NULL on SQLite would silently delete every
// row of `roles_permissions` and `users_roles` through their ON DELETE CASCADE.
// That is the same mechanism phase 1 documents at length, and it is why foreign
// keys are Postgres-only there. This codebase never enables SQLite's
// `foreign_keys` pragma and Postgres is the deployment target, so SQLite keeps a
// nullable column and loses nothing it ever had.
//
// **Deploy note: this scans every table it touches**, under ACCESS EXCLUSIVE,
// because `SET NOT NULL` has to prove no row violates it. On `monitoring_data`
// that is the whole table. The usual trick for avoiding the exclusive scan - a
// `NOT VALID` CHECK, validated under a weaker lock, which `SET NOT NULL` then
// reuses - buys nothing here: knex runs the migration in one transaction, so the
// first statement's ACCESS EXCLUSIVE lock is held until commit regardless. Treat
// this as a maintenance-window migration on an instance with a large history.

/**
 * The org every row predating tenancy belongs to.
 *
 * Mirrors `DEFAULT_ORG_ID` in `src/lib/server/db/orgContext.ts`. It cannot
 * import it: a migration must stay self-contained, because it has to keep
 * working against a checkout of `src/` from any later point in time.
 */
const DEFAULT_ORG_ID = 1;

/**
 * Every tenant table, mirroring `TENANT_TABLES` in `src/lib/server/db/tenantTables.ts`.
 *
 * Copied rather than imported, for the self-containment reason above. The two
 * lists agreeing is what makes the constraint and the runtime scoping describe
 * the same set of tables; a table added to one and not the other is either an
 * unscoped read or a column that can go null behind the scoping.
 *
 * `orgs`, `org_members` and `org_domains` are absent on purpose. They are how an
 * org is *found*, they are not tenant-scoped, and the two that carry `org_id`
 * were created NOT NULL already.
 */
const TENANT_TABLES = [
  // Owner tables
  "monitors",
  "pages",
  "incidents",
  "maintenances",
  "triggers",
  "api_keys",
  "images",
  "general_email_templates",
  "site_data",
  "subscriber_users",
  "roles",
  "monitor_alerts_config",
  "invitations",
  "oidc_group_role_mappings",

  // Junctions, carrying a denormalized org_id
  "pages_monitors",
  "incident_monitors",
  "incident_comments",
  "maintenance_monitors",
  "maintenances_events",
  "monitor_alerts_config_triggers",
  "monitor_alerts_config_monitors",
  "monitor_alerts_v2",
  "subscriber_methods",
  "user_subscriptions_v2",
  "users_roles",
  "roles_permissions",

  // Fork-added, org-aware from the day they were built
  "audit_log",
  "event_outbox",
  "event_deliveries",
  "webhook_endpoints",

  // The big one. See the deploy note above.
  "monitoring_data",
];

/**
 * Whether this dialect can take the constraint without destroying data.
 *
 * See the header: on SQLite `.alter()` is a table rebuild and the rebuild
 * cascades. Same test phase 1 uses for foreign keys, for the same mechanism.
 */
function supportsSafeAlter(knex: Knex): boolean {
  return knex.client.config.client !== "better-sqlite3" && knex.client.config.client !== "sqlite3";
}

/**
 * Whether `table.org_id` already refuses nulls.
 *
 * Asked rather than attempted. The obvious way to make this re-runnable is to
 * issue the change and swallow the error, and on Postgres that does not work: a
 * failed statement aborts the whole transaction, so every later statement fails
 * with "current transaction is aborted" no matter what the catch block does.
 * Being re-runnable on Postgres means never issuing a statement that can fail.
 */
async function isNotNull(knex: Knex, table: string): Promise<boolean> {
  const result = await knex.raw(
    `select is_nullable from information_schema.columns
     where table_schema = current_schema() and table_name = ? and column_name = 'org_id'`,
    [table],
  );
  const rows = (result as { rows?: Array<{ is_nullable: string }> }).rows ?? [];
  return rows[0]?.is_nullable === "NO";
}

/**
 * Whether `table.org_id` is part of the primary key.
 *
 * Where it is, the NOT NULL belongs to the primary key and not to this
 * migration: Postgres derives it, `up()` finds the column already non-nullable
 * and skips it, and `down()` must skip it too - `DROP NOT NULL` on a primary key
 * column is refused outright (42P16), which would make the rollback fail
 * part-way through.
 *
 * I3b keyed `general_email_templates` on `(org_id, template_id)`, which is how
 * this arose. Found by running `down()` against real Postgres; SQLite cannot see
 * it at all, because it never applies the constraint in the first place.
 */
async function isInPrimaryKey(knex: Knex, table: string): Promise<boolean> {
  const result = await knex.raw(
    `select 1 from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.contype = 'p' and c.conrelid = ?::regclass and a.attname = 'org_id'`,
    [table],
  );
  return ((result as { rows?: unknown[] }).rows ?? []).length > 0;
}

export async function up(knex: Knex): Promise<void> {
  // The backfill runs on **every** dialect, even where the constraint does not.
  //
  // A null `org_id` behind a scoped query is a row no tenant can see: the
  // repository's `where org_id = ?` never matches it. The fork's own tables had
  // real ones - `audit_log` carried rows written before I3c gave the audit
  // middleware an org - so this is repairing data, not merely preparing for a
  // constraint, and a SQLite install deserves the repair as much as a Postgres
  // one does.
  for (const table of TENANT_TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, "org_id"))) continue;
    await knex(table).whereNull("org_id").update({ org_id: DEFAULT_ORG_ID });
  }

  if (!supportsSafeAlter(knex)) return;

  for (const table of TENANT_TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, "org_id"))) continue;
    if (await isNotNull(knex, table)) continue;

    // Raw rather than `.notNullable().alter()`: knex's alter rewrites the whole
    // column definition, which on Postgres re-issues the type and drops the
    // default. This says the one thing that is meant.
    await knex.raw(`alter table ?? alter column "org_id" set not null`, [table]);
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!supportsSafeAlter(knex)) return;

  for (const table of TENANT_TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, "org_id"))) continue;
    if (!(await isNotNull(knex, table))) continue;
    if (await isInPrimaryKey(knex, table)) continue;

    await knex.raw(`alter table ?? alter column "org_id" drop not null`, [table]);
  }

  // The backfill is deliberately not undone. Which rows were null before is not
  // recorded anywhere, and inventing nulls again would put rows back out of
  // reach of every scoped query - a worse database than the one this started
  // from.
}
