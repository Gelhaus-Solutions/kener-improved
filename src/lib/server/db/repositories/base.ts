import type { Knex as KnexType } from "knex";
import { getWorkerKnex } from "../poolContext.js";
import { getTrx } from "../trxContext.js";
import { requireOrgId } from "../orgContext.js";
import { isTenantTable } from "../tenantTables.js";

// Filter types for queries
export interface MonitorFilter {
  status?: string;
  category_name?: string;
  id?: number;
  monitor_type?: string;
  tag?: string;
  is_hidden?: string;
  tags?: string[];
  search?: string;
}

export interface TriggerFilter {
  status?: string;
  id?: number;
}

export interface IncidentFilter {
  status?: string;
  start?: number;
  end?: number;
  state?: string;
  id?: number;
  incident_type?: string;
  incident_source?: string;
  /**
   * G7. Free text, matched against the incident title and its ACTIVE comments.
   *
   * Interpreted by whichever search the dialect supports - Postgres full text,
   * `LIKE` elsewhere - so this is a user's words, never query syntax. See
   * `getPublicIncidentsPaginated`.
   */
  search?: string;
}

export interface CountResult {
  count: string | number;
}

/**
 * Base repository class that provides access to the Knex instance
 */
export abstract class BaseRepository {
  private readonly fallbackKnex: KnexType;

  constructor(knex: KnexType) {
    this.fallbackKnex = knex;
  }

  /**
   * The Knex instance for the current execution context, **unscoped by org**.
   *
   * Resolved per call, in priority order:
   *
   *   1. An ambient transaction, if one is open (db.withTransaction). Everything
   *      inside it must go through the same connection or it is not in the
   *      transaction at all, so this wins over any pool choice.
   *   2. The worker connection pool, when running inside a background job
   *      (set in queues/q.ts). This keeps a burst of jobs from exhausting the
   *      connections that serve page loads.
   *   3. The web pool this repository was constructed with: SvelteKit requests,
   *      startup, anything else.
   *
   * See trxContext.ts, poolContext.ts and knexfile.ts.
   *
   * **Named `knexUnscoped` rather than `knex` on purpose (I3c).** It is here for
   * `fn.now()`, `raw(...)`, `transaction(...)` and the handful of genuinely
   * instance-wide queries. Calling it with a tenant table name is a cross-tenant
   * read, and the name is the only thing standing between a reviewer and one:
   * `this.knexUnscoped("monitors")` should stop a reader the way `this.knex(...)`
   * never did.
   */
  protected get knexUnscoped(): KnexType {
    return getTrx() ?? getWorkerKnex() ?? this.fallbackKnex;
  }

  /**
   * A query builder for `spec`, scoped to the current organisation.
   *
   * **This is the chokepoint the whole tenancy design rests on.** The old
   * `this.knex` getter was removed rather than kept alongside, so a repository
   * that forgets to scope no longer typechecks: `this.knex("monitors")` is a
   * compile error, not a silent read across every tenant. That compile error is
   * the guarantee; everything else here is mechanism.
   *
   * For a table in `TENANT_TABLES` it applies `where org_id = ?` and, for an
   * insert, stamps `org_id` onto the rows instead - a `where` clause does
   * nothing on an insert, so scoping reads while leaving writes unattributed
   * would have been the worst of both. Rows that name their own `org_id` keep
   * it, which is what lets `provisionOrg` write into an org it is creating.
   *
   * With no org context at all this throws (`MissingOrgContextError`). Work that
   * genuinely spans orgs says so with `runAsSystem`, where `requireOrgId`
   * returns null and the builder comes back unscoped.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected table<TRecord extends object = any, TResult = any[]>(
    spec: string,
  ): KnexType.QueryBuilder<TRecord, TResult> {
    const knex = this.knexUnscoped;
    const { table, ref } = splitAlias(spec);

    if (!isTenantTable(table)) return knex(spec) as KnexType.QueryBuilder<TRecord, TResult>;

    const orgId = requireOrgId(table);
    // `runAsSystem`: deliberately every org.
    if (orgId === null) return knex(spec) as KnexType.QueryBuilder<TRecord, TResult>;

    // Qualified by the alias where there is one, so the clause survives a join
    // that brings in a second table also carrying `org_id`.
    const scoped = knex(spec).where(`${ref}.org_id`, orgId);

    return new Proxy(scoped, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (data: unknown, ...rest: unknown[]) => {
            const stamp = (row: unknown) =>
              row && typeof row === "object" ? { org_id: orgId, ...(row as Record<string, unknown>) } : row;
            const stamped = Array.isArray(data) ? data.map(stamp) : stamp(data);
            // A fresh builder: the `where` above is meaningless on an insert,
            // and an aliased spec is not insertable.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (knex(table).insert as any)(stamped, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as KnexType.QueryBuilder<TRecord, TResult>;
  }
}

/**
 * Splits `"monitors as m"` into the real table and the name columns are qualified by.
 *
 * Ten call sites across the repositories alias their table, and a `where` on the
 * bare table name is invalid SQL once an alias is in play.
 */
function splitAlias(spec: string): { table: string; ref: string } {
  const match = spec.match(/^(\S+)\s+(?:as\s+)?(\S+)$/i);
  if (match) return { table: match[1], ref: match[2] };
  return { table: spec, ref: spec };
}
