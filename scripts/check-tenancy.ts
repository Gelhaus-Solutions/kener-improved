/**
 * Checks the tenancy registration against the schema that actually exists (Z).
 *
 * `npm run db:check-tenancy`
 *
 * **The guarantee this fills in.** Tenancy rests on a compile-time property:
 * `this.knex("monitors")` does not exist, so a repository that forgets to scope
 * a query does not build. That covers forgetting to scope. It does not cover
 * forgetting to *declare a table* - `TENANT_TABLES` is a set of strings looked
 * up at runtime, and a table missing from it is passed through unscoped and
 * unstamped.
 *
 * KENER-124 is what that looks like. `monitor_rollup_15m` was created, wired
 * into the fold chain, the read path and retention, and typechecked clean; the
 * first write died with `null value in column "org_id"`. Had the column been
 * nullable it would instead have written rows belonging to no tenant and
 * readable by all of them, with nothing to notice.
 *
 * `tenantTables.test.ts` covers what can be known without a database. This is
 * the half that cannot: it asks the database for every table carrying `org_id`
 * and compares the two directions.
 *
 *   - a table with `org_id` that is not registered   -> unscoped, cross-tenant
 *   - a registered table with no `org_id` column     -> `where org_id = ?`
 *                                                       against a column that
 *                                                       does not exist
 *
 * Exits non-zero on either, so it can be a deploy gate.
 */

import knexLib from "knex";
import type { Knex } from "knex";
import knexOb from "../knexfile.js";
import { TENANT_TABLES, INSTANCE_TABLES } from "../src/lib/server/db/tenantTables.js";

const isPg = knexOb.databaseType === "postgresql";

/**
 * Tables that carry `org_id` and are deliberately not scoped by it.
 *
 * Both are how an org is *found*. Scoping `org_members` by the current org would
 * mean needing the org in order to find the org. They are in `INSTANCE_TABLES`
 * for the same reason, and repeated here so this script says out loud which
 * exceptions it is willing to accept rather than deriving the answer from the
 * thing it is checking. (`orgs` itself is absent because its key is `id`, not
 * `org_id`, so it never matches in the first place.)
 */
const CARRIES_ORG_ID_UNSCOPED: ReadonlySet<string> = new Set(["org_members", "org_domains"]);

async function rows(
  knex: Knex,
  sql: string,
  bindings: Knex.RawBinding[] = [],
): Promise<Array<Record<string, unknown>>> {
  const result = await knex.raw(sql, bindings);
  if (Array.isArray(result)) return (Array.isArray(result[0]) ? result[0] : result) as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<Record<string, unknown>>;
}

/**
 * Every base table in the schema, and whether it has an `org_id` column.
 *
 * **Partition children are excluded, not filtered by name.** `monitoring_data`
 * and three of the rollup grains are declaratively partitioned, so the schema
 * holds `monitor_rollup_5m_y2026m06` and dozens like it. Each inherits `org_id`
 * from its parent and none is a table any code names, so every one of them would
 * be reported as an unregistered tenant table. Matching on a name pattern would
 * work until a real table happened to look like a partition; asking `pg_inherits`
 * is the question actually being asked.
 */
async function tablesWithOrgId(knex: Knex): Promise<{ withOrgId: Set<string>; all: Set<string> }> {
  if (isPg) {
    const all = await rows(
      knex,
      `select c.relname as name,
              exists (
                select 1 from pg_attribute a
                 where a.attrelid = c.oid and a.attname = 'org_id'
                   and a.attnum > 0 and not a.attisdropped
              ) as has_org_id
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relkind in ('r', 'p')
          and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)`,
    );
    return {
      all: new Set(all.map((row) => String(row.name))),
      withOrgId: new Set(all.filter((row) => row.has_org_id === true).map((row) => String(row.name))),
    };
  }

  // SQLite has no partitioning, so every table in `sqlite_master` is a base
  // table and `PRAGMA table_info` is the whole answer.
  const names = await rows(knex, `select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`);
  const all = new Set<string>();
  const withOrgId = new Set<string>();
  for (const row of names) {
    const name = String(row.name);
    all.add(name);
    const columns = await rows(knex, `PRAGMA table_info(${JSON.stringify(name)})`);
    if (columns.some((column) => String(column.name) === "org_id")) withOrgId.add(name);
  }
  return { all, withOrgId };
}

async function main(): Promise<void> {
  const knex = knexLib(knexOb as unknown as Knex.Config);
  console.log(`\n=== db:check-tenancy (${knexOb.databaseType}) ===`);

  let failures = 0;
  const fail = (label: string, tables: string[], why: string) => {
    if (tables.length === 0) return;
    failures += tables.length;
    console.log(`\n  FAIL ${label}`);
    console.log(`    ${why}`);
    for (const table of tables.sort()) console.log(`      - ${table}`);
  };

  try {
    const { all, withOrgId } = await tablesWithOrgId(knex);
    console.log(`  ${all.size} base table(s), ${withOrgId.size} carrying org_id`);
    console.log(`  ${TENANT_TABLES.size} registered as tenant-scoped\n`);

    if (all.size === 0) {
      console.log("  No tables at all. Has this database been migrated?\n");
      process.exit(1);
    }

    // Direction 1: the dangerous one. A table the database scopes by org that
    // the runtime does not.
    const unregistered = [...withOrgId].filter(
      (table) => !TENANT_TABLES.has(table) && !CARRIES_ORG_ID_UNSCOPED.has(table) && !INSTANCE_TABLES.has(table),
    );
    fail(
      "tables carry org_id but are not registered in TENANT_TABLES",
      unregistered,
      "Queries against these are unscoped and cross-tenant, and inserts never stamp the org.",
    );

    // Direction 2: a registered table whose column is missing. Every read
    // against it is `where org_id = ?` on a column that does not exist, which is
    // an error at the database rather than a wrong answer - but only on the code
    // path that happens to touch it.
    const missingColumn = [...TENANT_TABLES].filter((table) => all.has(table) && !withOrgId.has(table));
    fail(
      "tables are registered as tenant-scoped but have no org_id column",
      missingColumn,
      "Every scoped query against these fails at the database.",
    );

    // Not a failure. A table can be registered before its migration has run on
    // this particular instance, which is ordinary mid-deploy state, and the
    // fork's own tables legitimately do not exist on an older schema.
    const absent = [...TENANT_TABLES].filter((table) => !all.has(table));
    if (absent.length > 0) {
      console.log(`  NOTE registered but not present in this database (${absent.length}):`);
      for (const table of absent.sort()) console.log(`      - ${table}`);
    }

    console.log(
      failures === 0
        ? `\nALL PASS - the registration and the schema describe the same set of tables\n`
        : `\n${failures} PROBLEM(S)\n`,
    );
  } finally {
    await knex.destroy();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
