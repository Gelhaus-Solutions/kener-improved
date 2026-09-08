import { ROUTE_PERMISSION_MAP } from "$lib/allPerms.js";
import { ORG_ROUTE_PERMISSION_MAP } from "$lib/orgPerms.js";

/**
 * Upstream's route map merged with the fork's.
 *
 * `allPerms.ts` stays byte-identical to upstream, so fork routes are declared in
 * `orgPerms.ts` instead; see the comment there. This module exists so the merge
 * happens in exactly one place: it used to be copy-pasted into the manage layout
 * and its server counterpart, and the section layouts added by I3f would have
 * made that three copies.
 */
export const MERGED_ROUTE_PERMISSION_MAP: Record<string, string | null> = {
  ...ROUTE_PERMISSION_MAP,
  ...ORG_ROUTE_PERMISSION_MAP,
};

/**
 * Whether a set of permissions may reach a route.
 *
 * Fail-closed: a route with no entry at all is unreachable, which is what makes
 * forgetting to map a new admin screen a 403 rather than a hole.
 */
export function canReachRoute(userPermissions: readonly string[] | undefined, routeId: string): boolean {
  const required = MERGED_ROUTE_PERMISSION_MAP[routeId];
  if (required === undefined) return false;
  if (required === null) return true;
  return (userPermissions ?? []).includes(required);
}

/** Route id for a `/manage/...` URL, as SvelteKit spells it. */
export function routeIdForManageUrl(url: string): string {
  return `/(manage)${url}`;
}
