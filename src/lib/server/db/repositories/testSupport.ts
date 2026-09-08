import { runAcrossOrgs } from "../orgContext.js";

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
