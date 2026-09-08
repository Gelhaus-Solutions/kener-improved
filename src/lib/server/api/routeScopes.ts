/**
 * Which permission each public API route and method requires.
 *
 * Before this file the `(api)/api/v4/*` routes were not permission-mapped at
 * all: `apiAuthHandle` checked that the bearer token resolved to an ACTIVE key
 * and then let it through to anything. That was not a missing feature, it was a
 * missing authorization check, and the whole surface behaved as if every key
 * were an owner.
 *
 * The shape deliberately mirrors `ROUTE_PERMISSION_MAP` in `allPerms.ts`, keyed
 * by SvelteKit route id, so the two read the same way. It differs in one respect:
 * the value is keyed by HTTP method, because a route id covers both the GET and
 * the DELETE of the same resource and those are obviously not one permission.
 *
 * **Fail closed.** A route id absent from this map, or a method absent from its
 * entry, is a 403 for a scoped key. That matches the convention
 * `(manage)/+layout.server.ts` already applies to admin routes: a route nobody
 * has assigned a permission to is a route nobody has decided is safe.
 *
 * Keys holding the `*` scope skip this map; see `WILDCARD_SCOPE`.
 */

/** Method to required permission id, for one route. */
type MethodScopes = Partial<Record<string, string>>;

export const ROUTE_SCOPE_MAP: Record<string, MethodScopes> = {
  // Monitors
  "/(api)/api/v4/monitors": { GET: "monitors.read", POST: "monitors.write" },
  "/(api)/api/v4/monitors/[monitor_tag]": {
    GET: "monitors.read",
    PATCH: "monitors.write",
    DELETE: "monitors.write",
  },
  // Pushing heartbeat/status samples. A write even though it creates no monitor:
  // it is what decides whether a status page shows green.
  "/(api)/api/v4/monitors/[monitor_tag]/data": { GET: "monitors.read", PATCH: "monitors.write" },
  "/(api)/api/v4/monitors/[monitor_tag]/data/[timestamp]": { GET: "monitors.read", PATCH: "monitors.write" },

  // Incidents
  "/(api)/api/v4/incidents": { GET: "incidents.read", POST: "incidents.write" },
  "/(api)/api/v4/incidents/[incident_id]": {
    GET: "incidents.read",
    PATCH: "incidents.write",
    DELETE: "incidents.write",
  },
  "/(api)/api/v4/incidents/[incident_id]/comments": { GET: "incidents.read", POST: "incidents.write" },
  "/(api)/api/v4/incidents/[incident_id]/comments/[comment_id]": {
    GET: "incidents.read",
    PATCH: "incidents.write",
    DELETE: "incidents.write",
  },

  // Maintenances
  "/(api)/api/v4/maintenances": { GET: "maintenances.read", POST: "maintenances.write" },
  "/(api)/api/v4/maintenances/[maintenance_id]": {
    GET: "maintenances.read",
    PATCH: "maintenances.write",
    DELETE: "maintenances.write",
  },
  "/(api)/api/v4/maintenances/[maintenance_id]/events": { GET: "maintenances.read" },
  "/(api)/api/v4/maintenances/[maintenance_id]/events/[event_id]": {
    GET: "maintenances.read",
    PATCH: "maintenances.write",
    DELETE: "maintenances.write",
  },
  "/(api)/api/v4/maintenances/events": { GET: "maintenances.read" },

  // Pages
  "/(api)/api/v4/pages": { GET: "pages.read", POST: "pages.write" },
  "/(api)/api/v4/pages/[page_path]": { GET: "pages.read", PATCH: "pages.write", DELETE: "pages.write" },

  // Site configuration. Mapped to the same `settings.*` pair the admin API uses
  // rather than being made unreachable by key: one vocabulary, no special cases,
  // and no existing narrow key can hold `settings.write` by accident because
  // narrow keys only exist from this release onwards.
  "/(api)/api/v4/site": { GET: "settings.read" },
  "/(api)/api/v4/site/[config_key]": { GET: "settings.read", PATCH: "settings.write" },
};

/**
 * The permission `routeId` + `method` requires, or `undefined` when unmapped.
 *
 * `undefined` is the fail-closed answer and callers must treat it as a denial,
 * never as "no permission needed". HEAD is answered by the GET handler in
 * SvelteKit, so it is resolved against GET here too.
 */
export function requiredScopeForRoute(routeId: string | null, method: string): string | undefined {
  if (!routeId) return undefined;
  const entry = ROUTE_SCOPE_MAP[routeId];
  if (!entry) return undefined;
  const key = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return entry[key];
}
