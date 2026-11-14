import type { Knex } from "knex";
import { runAcrossOrgs, DEFAULT_ORG_ID } from "../orgContext.js";
import { isTenantTable } from "../tenantTables.js";

/**
 * Wraps a repository so every method runs outside any organisation (I3c).
 *
 * The repository unit tests build a fixture schema in an in-memory database and
 * call methods directly, with no request and therefore no org context. After
 * I3c that is a `MissingOrgContextError` on the first tenant table, which is the
 * guard working correctly rather than a problem with the tests: these tests are
 * about the SQL a method builds, not about tenancy, and their fixture tables do
 * not carry `org_id` at all.
 *
 * So they declare that explicitly, once per file, instead of every call site
 * repeating it. Using `runAcrossOrgs` rather than `runWithOrg(1, ...)` is the
 * accurate statement: there is no org here, not an org that happens to be the
 * default.
 *
 * Scoping itself is covered directly by `base.test.ts`.
 */
export function unscoped<T extends object>(repository: T): T {
  return new Proxy(repository, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (...args: any[]) => runAcrossOrgs(async () => value.apply(target, args));
    },
  });
}

/**
 * A knex whose inserts into tenant tables belong to the default org (I3).
 *
 * For integration tests that write fixtures with raw knex and read them back
 * through org-scoped repositories: a row with a null `org_id` is in no org, so
 * nothing would ever find it. Rows that name an `org_id` keep it.
 */
export function defaultOrgKnex(knex: Knex): Knex {
  return new Proxy(knex, {
    apply(target, thisArg, args: [string]) {
      const builder = Reflect.apply(target, thisArg, args) as Knex.QueryBuilder;
      if (!isTenantTable(args[0])) return builder;
      const insert = builder.insert.bind(builder) as (...a: unknown[]) => unknown;
      const stamp = (row: Record<string, unknown>) => ({ org_id: DEFAULT_ORG_ID, ...row });
      builder.insert = ((rows: Record<string, unknown> | Record<string, unknown>[], ...rest: unknown[]) =>
        insert(Array.isArray(rows) ? rows.map(stamp) : stamp(rows), ...rest)) as never;
      return builder;
    },
  });
}
