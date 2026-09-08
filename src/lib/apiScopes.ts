import { permissions } from "./allPerms.js";
import { orgPermissions } from "./orgPerms.js";

/**
 * The scope vocabulary for API keys.
 *
 * There is no parallel, coarser set of API scopes, and inventing one was
 * explicitly rejected. A scope **is** a permission id, so:
 *
 *   - a key and a cookie session are authorized against the same names, and the
 *     answer to "what can this key do" is expressed in words an operator already
 *     understands from the roles screen;
 *   - there is one vocabulary to maintain rather than two that drift;
 *   - a permission upstream adds to `allPerms.ts` becomes scopeable here with no
 *     change to this file.
 *
 * Exactly one entry is synthetic and has no permission behind it: `*`.
 */

/**
 * Full access. Every key that predates scoping is backfilled to this, so
 * scoping changes nothing for anybody until they opt in.
 *
 * It **bypasses the route map entirely** rather than expanding to "every
 * permission currently known". That distinction matters on an upstream sync: a
 * new v4 route arriving without a `routeScopes.ts` entry stays reachable by a
 * `*` key, which is exactly the access that key had before this feature existed.
 * Narrow keys stay fail-closed on that same route. The alternative - failing
 * closed for `*` too - turns every upstream route addition into a silent
 * outage for every existing integration, which is a worse trade than a route
 * that is briefly as open as it was yesterday.
 */
export const WILDCARD_SCOPE = "*";

/** Every scope an operator may attach to a key, in the order the picker shows them. */
export const API_KEY_SCOPES: Array<{ id: string; permission_name: string }> = [...permissions, ...orgPermissions];

const KNOWN_SCOPES = new Set<string>([WILDCARD_SCOPE, ...API_KEY_SCOPES.map((p) => p.id)]);

/** Whether `scope` is a name this build knows how to grant. */
export function isKnownScope(scope: string): boolean {
  return KNOWN_SCOPES.has(scope);
}

/**
 * Whether a key holding `scopes` may perform an action requiring `required`.
 *
 * No prefix or hierarchy matching: `monitors.write` does not imply
 * `monitors.read`. That mirrors `RequirePermission`, which is a plain set
 * membership test, and keeping the two identical is the point of sharing the
 * vocabulary at all. A key that needs both gets both.
 */
export function scopeSatisfies(scopes: readonly string[], required: string): boolean {
  return scopes.includes(WILDCARD_SCOPE) || scopes.includes(required);
}

/**
 * Parses the `scopes` column.
 *
 * **Fails closed.** Anything that is not a JSON array of strings yields an empty
 * list, which authorizes nothing rather than everything. A corrupt row must not
 * be a skeleton key, and the backfill in the migration is what guarantees no
 * legitimate row reaches this path empty.
 */
export function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string");
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/** Human-readable summary for the key list, e.g. "Full access" or "3 scopes". */
export function describeScopes(scopes: readonly string[]): string {
  if (scopes.includes(WILDCARD_SCOPE)) return "Full access";
  if (scopes.length === 0) return "No access";
  if (scopes.length === 1) return scopes[0];
  return `${scopes.length} scopes`;
}
