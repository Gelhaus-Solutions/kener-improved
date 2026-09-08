import type { Knex } from "knex";

// Organisations, phase 1: additive and re-runnable.
//
// Split from the constraint phase (I3b) on purpose. Everything here either
// creates something new or adds a nullable column, so a failure part-way leaves
// a database that still works and that re-running finishes. Nothing here makes a
// column NOT NULL, swaps a unique key, or drops anything - those all land in
// I3b, where a failure is recoverable precisely because this phase already
// completed.
//
// The model is "org owns config, shared infra": orgs own pages, monitors,
// incidents, maintenances, triggers, subscribers, api keys, roles and users (via
// membership). The scheduler, queues and probe layer stay tenant-unaware.
//
// **The decision this phase rests on: `monitors.tag` stays globally unique, and
// a new `monitors.slug` becomes the per-org name.** `tag` is a foreign key
// target five times over, it is half of the `monitoring_data` primary key, it is
// the Redis cache key in `cache/setGet.ts` and it is the BullMQ job-scheduler id
// in `appScheduler.ts`. Making it per-org unique would mean rewriting five
// composite foreign keys, the largest table's primary key and two keyspaces, for
// no user-visible gain. Instead `tag` is the immutable physical key and `slug` is
// the renameable display name, with `tag = tag_prefix ? prefix + "_" + slug : slug`.
//
// The default org gets `tag_prefix = ''`, which is what makes the whole upgrade
// invisible: the backfill is `slug = tag`, and every existing URL, badge, API
// path, Redis key and job id is byte-identical afterwards.
//
// **Postgres is the target, and the foreign keys are Postgres-only.** There it
// is all metadata: `ADD COLUMN` plus `ADD CONSTRAINT ... FOREIGN KEY` over an
// all-NULL column validates with nothing to scan. On SQLite the same call is a
// silent data-loss bug - see `supportsSafeForeignKeys` below for the mechanism -
// so SQLite gets the column and the index without the constraint, which costs
// nothing because this codebase never turns SQLite's foreign_keys pragma on.

/**
 * The org every existing row belongs to.
 *
 * Mirrors `DEFAULT_ORG_ID` in `src/lib/server/events/eventContext.ts`. It cannot
 * import it: a migration must stay self-contained, because it has to keep
 * working against a checkout of `src/` from any later point in time.
 */
const DEFAULT_ORG_ID = 1;

/** Owner tables: the row belongs to exactly one org. */
const OWNER_TABLES = [
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
];

/**
 * Junction tables, which get a denormalized `org_id`.
 *
 * Redundant by construction - the org is always reachable by joining - and that
 * is the point. Postgres row-level security (I3h) writes one predicate per
 * table, and a policy that has to join to find the tenant is both slow and easy
 * to get wrong. Carrying the column makes every policy the same one-line test.
 */
const JUNCTION_TABLES = [
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
];

/**
 * Whether this dialect can take a foreign key without destroying data.
 *
 * **SQLite cannot, and the failure is silent.** knex implements an FK-bearing
 * `ADD COLUMN` on SQLite as a table rebuild: create a temp table, copy the rows,
 * `DROP TABLE` the original, rename. It issues `PRAGMA foreign_keys = OFF` first
 * to stop that drop cascading - but **`PRAGMA foreign_keys` is a no-op inside a
 * transaction**, and knex runs every migration inside one. So the pragma is
 * ignored, foreign keys stay on, and dropping a parent cascades.
 *
 * Adding `org_id` to `roles` therefore deleted every row of `roles_permissions`
 * and `users_roles` through their `ON DELETE CASCADE`. No error, no warning: 77
 * permission grants became 0, and the instance came up with roles that granted
 * nothing. Verified by `scratch/verify-org-schema.ts`, which is the only reason
 * this was caught - a fresh database has nothing to lose, so it looks fine.
 *
 * Skipping the constraint on SQLite costs nothing real: this codebase never
 * enables the `foreign_keys` pragma, so SQLite has never enforced a foreign key
 * here anyway (see the note in `repositories/monitorAlertConfig.ts`). Postgres,
 * which is the deployment target, gets the full constraint.
 */
function supportsSafeForeignKeys(knex: Knex): boolean {
  return knex.client.config.client !== "better-sqlite3" && knex.client.config.client !== "sqlite3";
}

/** Adds a nullable `org_id` with its index, and its foreign key where that is safe. */
async function addOrgColumn(knex: Knex, table: string): Promise<void> {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, "org_id")) return;

  const withForeignKey = supportsSafeForeignKeys(knex);
  await knex.schema.alterTable(table, (t) => {
    if (withForeignKey) t.integer("org_id").nullable().references("id").inTable("orgs");
    else t.integer("org_id").nullable();
    t.index(["org_id"], `idx_${table}_org_id`);
  });
}

/**
 * Adds the foreign key and index to an `org_id` that already exists.
 *
 * P1, P2 and A10 each added a bare `org_id` ahead of this migration so their
 * rows could carry one from the start. Those columns are real and populated;
 * they just never had a table to point at.
 */
async function constrainExistingOrgColumn(knex: Knex, table: string): Promise<void> {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, "org_id"))) return;

  const indexName = `idx_${table}_org_id`;
  const withForeignKey = supportsSafeForeignKeys(knex);

  // **No try/catch here, deliberately.** The obvious way to make this
  // re-runnable is to attempt the change and swallow an "already exists" error,
  // and on Postgres that does not work: a failed statement aborts the whole
  // transaction, so every later statement in the migration fails with "current
  // transaction is aborted" no matter what the catch block does. Being
  // re-runnable on Postgres means never issuing a statement that can fail, so
  // `down()` removes both the constraint and the index and this simply builds
  // them again.
  await knex.schema.alterTable(table, (t) => {
    // Same rebuild hazard as `addOrgColumn`, for the same reason.
    if (withForeignKey) t.foreign("org_id").references("id").inTable("orgs");
    t.index(["org_id"], indexName);
  });
}

export async function up(knex: Knex): Promise<void> {
  // ---- 1. The org tables -------------------------------------------------

  if (!(await knex.schema.hasTable("orgs"))) {
    await knex.schema.createTable("orgs", (table) => {
      table.increments("id").primary();

      // What appears in a URL once I3e adds `/o/<slug>/...`. Separate from the
      // display name so renaming an organisation does not break its links.
      table.string("slug", 255).notNullable().unique();
      table.string("name", 255).notNullable();
      table.string("status", 32).notNullable().defaultTo("ACTIVE");

      // Exactly one row carries this. It is the org that owns everything that
      // existed before tenancy, and the one a request falls back to when no
      // context has been established.
      table.boolean("is_default").notNullable().defaultTo(false);

      // Prepended to `monitors.slug` to build the globally unique
      // `monitors.tag`. **The default org's is the empty string**, which is the
      // single fact that makes this whole migration invisible to an existing
      // install: its tags are already exactly their slugs.
      //
      // UNIQUE so two orgs cannot mint colliding tags.
      table.string("tag_prefix", 64).notNullable().unique();

      table.timestamp("created_at").defaultTo(knex.fn.now());
      table.timestamp("updated_at").defaultTo(knex.fn.now());
    });
  }

  // The default org has to exist before anything can point at it.
  const existingDefault = await knex("orgs").where({ id: DEFAULT_ORG_ID }).first();
  if (!existingDefault) {
    // Named after the site, so an operator recognises it in the org switcher
    // rather than seeing "Default" next to eleven real customers. Read straight
    // from the table because a migration cannot import the site data controller.
    const siteName = await knex("site_data").where({ key: "siteName" }).first();
    const name = typeof siteName?.value === "string" && siteName.value.trim() ? siteName.value.trim() : "Default";

    await knex("orgs").insert({
      id: DEFAULT_ORG_ID,
      slug: "default",
      name,
      status: "ACTIVE",
      is_default: true,
      tag_prefix: "",
    });
  }

  if (!(await knex.schema.hasTable("org_members"))) {
    await knex.schema.createTable("org_members", (table) => {
      table.integer("org_id").notNullable().references("id").inTable("orgs").onDelete("CASCADE");
      table.integer("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");

      // Per-org ownership, as distinct from `users.is_owner`, which A10 and
      // everything before it used to mean "runs this instance". After P4 the two
      // are different jobs: an instance superadmin, and the owner of one tenant.
      table.boolean("is_org_owner").notNullable().defaultTo(false);

      // Bumped when this membership's permissions change, the same trick
      // `users.session_epoch` uses (A9). It lets a role change inside one org
      // invalidate sessions acting in that org without touching the user's
      // sessions in any other.
      table.integer("perms_epoch").notNullable().defaultTo(0);

      table.timestamp("created_at").defaultTo(knex.fn.now());
      table.timestamp("updated_at").defaultTo(knex.fn.now());

      table.primary(["org_id", "user_id"]);
      // "Which orgs am I in", for the switcher.
      table.index(["user_id"], "idx_org_members_user_id");
    });
  }

  if (!(await knex.schema.hasTable("org_domains"))) {
    // Shipped now even though host routing is P9's job. Adding it later would
    // mean a second migration over the same area, and this one is already the
    // risky pass over the schema.
    await knex.schema.createTable("org_domains", (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable().references("id").inTable("orgs").onDelete("CASCADE");

      // The discriminator for public traffic. UNIQUE across the instance: a
      // hostname can only ever resolve to one tenant, and the alternative is a
      // status page serving another customer's incidents.
      table.string("hostname", 255).notNullable().unique();
      table.string("status", 32).notNullable().defaultTo("PENDING");

      table.timestamp("created_at").defaultTo(knex.fn.now());
      table.timestamp("updated_at").defaultTo(knex.fn.now());

      table.index(["org_id"], "idx_org_domains_org_id");
    });
  }

  // ---- 2. Ownership columns ---------------------------------------------

  for (const table of OWNER_TABLES) {
    await addOrgColumn(knex, table);
  }
  for (const table of JUNCTION_TABLES) {
    await addOrgColumn(knex, table);
  }

  // Tables that already carried a bare `org_id` from an earlier phase.
  for (const table of ["audit_log", "event_outbox", "event_deliveries", "webhook_endpoints", "api_keys"]) {
    await constrainExistingOrgColumn(knex, table);
  }

  // `monitoring_data` is the one table treated differently, and deliberately.
  // No foreign key: `org_id` here is defence in depth for RLS, it is always
  // derivable from the globally unique `monitor_tag`, and this is the table
  // where a constraint-driven rewrite costs the most. The index is what RLS
  // actually needs.
  if (await knex.schema.hasTable("monitoring_data")) {
    if (!(await knex.schema.hasColumn("monitoring_data", "org_id"))) {
      await knex.schema.alterTable("monitoring_data", (t) => {
        t.integer("org_id").nullable();
        t.index(["org_id"], "idx_monitoring_data_org_id");
      });
    }
  }

  // ---- 3. Per-org monitor slugs -----------------------------------------

  if (!(await knex.schema.hasColumn("monitors", "slug"))) {
    await knex.schema.alterTable("monitors", (t) => {
      // Unique per org, but only from I3b: this phase adds no constraints.
      t.string("slug", 255).nullable();
    });
  }

  // ---- 4. Per-org roles --------------------------------------------------

  // `roles.id` stays a global string primary key and `role_key` carries the
  // per-org name. A new org gets namespaced ids (`o2_admin`) whose `role_key` is
  // still `admin`. Making `(org_id, id)` the primary key instead would rewrite
  // three foreign keys, both seeds and every `getRoleById` call site, to express
  // the same thing.
  if (!(await knex.schema.hasColumn("roles", "role_key"))) {
    await knex.schema.alterTable("roles", (t) => {
      t.string("role_key", 255).nullable();
    });
  }

  // ---- 5. Backfills ------------------------------------------------------
  //
  // Every one is conditional on the column still being NULL, so re-running this
  // migration is a no-op rather than a rewrite, and an interrupted run resumes.

  for (const table of [...OWNER_TABLES, ...JUNCTION_TABLES]) {
    if (!(await knex.schema.hasTable(table))) continue;
    await knex(table).whereNull("org_id").update({ org_id: DEFAULT_ORG_ID });
  }

  await knex("monitors")
    .whereNull("slug")
    .update({ slug: knex.ref("tag") });
  await knex("roles")
    .whereNull("role_key")
    .update({ role_key: knex.ref("id") });

  // Everyone who exists today is a member of the default org, and the instance
  // owner is also its org owner.
  const users: Array<{ id: number; is_owner: string | null }> = await knex("users").select("id", "is_owner");
  for (const user of users) {
    const existing = await knex("org_members").where({ org_id: DEFAULT_ORG_ID, user_id: user.id }).first();
    if (existing) continue;
    await knex("org_members").insert({
      org_id: DEFAULT_ORG_ID,
      user_id: user.id,
      is_org_owner: user.is_owner === "YES",
      perms_epoch: 0,
    });
  }

  // `monitoring_data` last, because it is the only backfill that can take real
  // time. Batched by timestamp window rather than by LIMIT, because Postgres has
  // no `UPDATE ... LIMIT` and a window is dialect-agnostic. `whereNull` makes
  // each window idempotent, so an interrupted run resumes from where it stopped
  // rather than starting again.
  if (await knex.schema.hasTable("monitoring_data")) {
    const bounds = await knex("monitoring_data")
      .whereNull("org_id")
      .min({ lo: "timestamp" })
      .max({ hi: "timestamp" })
      .first();

    const lo = bounds?.lo === null || bounds?.lo === undefined ? null : Number(bounds.lo);
    const hi = bounds?.hi === null || bounds?.hi === undefined ? null : Number(bounds.hi);

    if (lo !== null && hi !== null) {
      // A week of samples at a time: large enough that the loop is short even
      // over years of history, small enough that no single statement locks the
      // table for long.
      const WINDOW_SECONDS = 7 * 24 * 60 * 60;
      for (let start = lo; start <= hi; start += WINDOW_SECONDS) {
        await knex("monitoring_data")
          .whereNull("org_id")
          .andWhere("timestamp", ">=", start)
          .andWhere("timestamp", "<", start + WINDOW_SECONDS)
          .update({ org_id: DEFAULT_ORG_ID });
      }
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // **On SQLite this deliberately leaves the added columns behind.**
  //
  // `dropColumn` is a table rebuild there, and a rebuild of a parent table
  // inside a transaction cascades into its children for the reason spelled out
  // on `supportsSafeForeignKeys`. Dropping `monitors.slug` would therefore
  // delete every row of `pages_monitors`, `incident_monitors`,
  // `maintenance_monitors` and more, because they all cascade from
  // `monitors.tag`. A rollback that destroys data is worse than a rollback that
  // leaves a few unused nullable columns, and re-running `up()` treats them as
  // already done.
  const canDropSafely = supportsSafeForeignKeys(knex);

  if (canDropSafely) {
    for (const table of [...OWNER_TABLES, ...JUNCTION_TABLES]) {
      if (!(await knex.schema.hasTable(table))) continue;
      if (!(await knex.schema.hasColumn(table, "org_id"))) continue;
      // `api_keys.org_id` predates this migration (A10) and has to survive it.
      if (table === "api_keys") continue;
      await knex.schema.alterTable(table, (t) => t.dropColumn("org_id"));
    }

    if (await knex.schema.hasColumn("monitoring_data", "org_id")) {
      await knex.schema.alterTable("monitoring_data", (t) => t.dropColumn("org_id"));
    }
    if (await knex.schema.hasColumn("monitors", "slug")) {
      await knex.schema.alterTable("monitors", (t) => t.dropColumn("slug"));
    }
    if (await knex.schema.hasColumn("roles", "role_key")) {
      await knex.schema.alterTable("roles", (t) => t.dropColumn("role_key"));
    }
  } else {
    // Clear the values rather than the columns, so a re-applied `up()` backfills
    // them again from a clean state.
    for (const table of [...OWNER_TABLES, ...JUNCTION_TABLES]) {
      if (!(await knex.schema.hasTable(table))) continue;
      if (!(await knex.schema.hasColumn(table, "org_id"))) continue;
      if (table === "api_keys") continue;
      await knex(table).update({ org_id: null });
    }
    if (await knex.schema.hasColumn("monitoring_data", "org_id")) {
      await knex("monitoring_data").update({ org_id: null });
    }
    if (await knex.schema.hasColumn("monitors", "slug")) {
      await knex("monitors").update({ slug: null });
    }
    if (await knex.schema.hasColumn("roles", "role_key")) {
      await knex("roles").update({ role_key: null });
    }
  }

  // The five tables that carried an `org_id` before this migration keep their
  // column, but the foreign key this migration gave them has to go first:
  // Postgres refuses to drop `orgs` while anything still references it.
  for (const table of ["audit_log", "event_outbox", "event_deliveries", "webhook_endpoints", "api_keys"]) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, "org_id"))) continue;
    // Both halves of what `constrainExistingOrgColumn` added. The index has to
    // go too, or re-applying this migration tries to create one that is already
    // there and aborts the transaction on Postgres.
    await knex.schema.alterTable(table, (t) => {
      if (canDropSafely) t.dropForeign(["org_id"]);
      t.dropIndex(["org_id"], `idx_${table}_org_id`);
    });
  }

  // Safe on every dialect: nothing outside this migration points at these.
  await knex.schema.dropTableIfExists("org_domains");
  await knex.schema.dropTableIfExists("org_members");
  await knex.schema.dropTableIfExists("orgs");
}
