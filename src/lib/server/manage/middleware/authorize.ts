import { ACTION_PERMISSION_MAP } from "$lib/allPerms.js";
import { RequirePermission } from "$lib/server/controllers/userController.js";
import { ActionError } from "../types.js";
import type { AnyActionDefinition } from "../types.js";

/**
 * The permission map the pipeline authorizes against.
 *
 * `allPerms.ts` is kept byte-identical to upstream so its edits merge cleanly,
 * which is exactly why fork-invented actions cannot be added to it. They go in
 * `orgPerms.ts` and are merged here instead. Fork entries win on a key collision,
 * which is the only sane resolution: if upstream later ships an action we already
 * invented, our permission is the one our roles actually grant.
 *
 * The merge happens at this single consumer rather than being baked into a
 * combined module, so it stays obvious that two files feed it.
 */
const MERGED_ACTION_PERMISSION_MAP: Record<string, string | null> = {
  ...ACTION_PERMISSION_MAP,
  // P1/Z11 adds: ...ORG_ACTION_PERMISSION_MAP
};

/** Whether any layer knows this action string at all. */
export function isKnownAction(action: string, def: AnyActionDefinition | undefined): boolean {
  // Registered actions are known by definition. Everything else is known only if
  // the permission map lists it, which is precisely the test the inherited chain
  // applied before dispatching, so unmigrated actions keep their exact behaviour.
  return def !== undefined || action in MERGED_ACTION_PERMISSION_MAP;
}

/**
 * Enforces the permission for `action`, throwing 403 when the caller lacks it.
 *
 * Resolution order: an explicit `permission` on the definition, otherwise the
 * merged map. A definition that omits it therefore inherits upstream's mapping
 * automatically, which is the point: the permission is not duplicated into a
 * hundred action files where it would drift.
 *
 * `null` means authenticated-is-enough. **`undefined` means 403, not "allow".**
 * An action nobody has assigned a permission to is an action nobody has decided
 * is safe, and the failure has to be closed. This matches how
 * ROUTE_PERMISSION_MAP is treated in (manage)/+layout.server.ts.
 */
export function authorize(action: string, def: AnyActionDefinition | undefined, permissions: Set<string>): void {
  const required = def && def.permission !== undefined ? def.permission : MERGED_ACTION_PERMISSION_MAP[action];

  if (required === undefined) {
    throw new ActionError(403, "You do not have permission to perform this action");
  }
  if (required === null) {
    return;
  }

  try {
    RequirePermission(permissions, required);
  } catch {
    throw new ActionError(403, "You do not have permission to perform this action");
  }
}

/** The permission `action` resolves to, for the audit log. */
export function resolvedPermission(action: string, def: AnyActionDefinition | undefined): string | null | undefined {
  return def && def.permission !== undefined ? def.permission : MERGED_ACTION_PERMISSION_MAP[action];
}
