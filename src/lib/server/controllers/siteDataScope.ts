import type { SiteData } from "../types/db.js";

/**
 * Which `site_data` keys belong to the instance, and how the two layers combine (I3g).
 *
 * **Fork-owned, and separate from `siteDataKeys.ts` on purpose.** That file is
 * upstream's list of every key and its validator, and it churns whenever
 * upstream adds a setting. Scope is a fork concept that upstream has no notion
 * of, so it lives here and the two are merged by the readers. Adding a key
 * upstream therefore costs nothing here, and a key added here never conflicts
 * there.
 *
 * ## The two layers
 *
 * `org_id = 0` holds the instance layer. A read takes the instance rows and
 * overlays the current org's on top, so an org stores a row only for a setting
 * it has actually changed, and a new org starts with none at all.
 *
 * Instance-scoped keys invert that: they live only at org 0, an org row is never
 * consulted, and the write path sends them to org 0 rather than to the caller's
 * org. That asymmetry is the point - an override that silently did nothing would
 * be worse than no override at all.
 */

/**
 * The instance layer's org.
 *
 * A sentinel `orgs` row exists for it so `site_data.org_id`'s foreign key holds.
 * Its status is deliberately not ACTIVE, which keeps it out of
 * `getActiveOrgIds` and therefore out of every scheduler fan-out.
 */
export const INSTANCE_ORG_ID = 0;

/**
 * Keys the instance owns outright.
 *
 * Each decides something a tenant administrator must not decide for everybody:
 *
 *   - `oidcSettings`        the identity provider every login goes through.
 *   - `mfaPolicy`           whether a second factor is mandatory.
 *   - `dataRetentionPolicy` how long history is kept: the operator's disk.
 *   - `auditRetentionDays`  the same, for the record of who did what.
 *   - `eventBusConsumers`   whether customer notifications are sent at all.
 *
 * Everything else is a tenant's own - branding, colours, i18n, nav, hero,
 * footer, subscriptions, announcements - which is most of what makes a status
 * page look like theirs.
 */
export const INSTANCE_SCOPED_KEYS: ReadonlySet<string> = new Set([
  "oidcSettings",
  "mfaPolicy",
  "dataRetentionPolicy",
  "auditRetentionDays",
  "eventBusConsumers",
]);

export function isInstanceScoped(key: string): boolean {
  return INSTANCE_SCOPED_KEYS.has(key);
}

/**
 * The org a write to `key` belongs in.
 *
 * The single place that decision is made. `InsertKeyValue`, the v4 config API
 * and the instance console all route through this, so a key cannot be
 * instance-scoped on one path and org-scoped on another.
 */
export function writeOrgFor(key: string, currentOrgId: number): number {
  return isInstanceScoped(key) ? INSTANCE_ORG_ID : currentOrgId;
}

/**
 * Combines the instance rows with one org's into the rows that org sees.
 *
 * Pure, and given both layers in one list because they come back from one query.
 * The rules, in full:
 *
 *   - An instance-scoped key takes the instance row and ignores any org row.
 *     Such a row should not exist - the migration cleared them and the write
 *     path cannot create one - but ignoring it is what makes that guarantee
 *     hold rather than assume.
 *   - Any other key prefers the org's row, falling back to the instance's.
 *   - A key present in neither is simply absent, exactly as before I3g.
 */
export function overlaySiteData(rows: SiteData[], orgId: number): SiteData[] {
  const instance = new Map<string, SiteData>();
  const own = new Map<string, SiteData>();

  for (const row of rows) {
    if (Number(row.org_id) === INSTANCE_ORG_ID) instance.set(row.key, row);
    else if (Number(row.org_id) === orgId) own.set(row.key, row);
  }

  const merged = new Map<string, SiteData>(instance);
  for (const [key, row] of own) {
    if (isInstanceScoped(key)) continue;
    merged.set(key, row);
  }
  return [...merged.values()];
}

/** The one row for `key` that `orgId` should see, or undefined. */
export function overlaySiteDataKey(rows: SiteData[], key: string, orgId: number): SiteData | undefined {
  let instance: SiteData | undefined;
  let own: SiteData | undefined;
  for (const row of rows) {
    if (row.key !== key) continue;
    if (Number(row.org_id) === INSTANCE_ORG_ID) instance = row;
    else if (Number(row.org_id) === orgId) own = row;
  }
  return isInstanceScoped(key) ? instance : (own ?? instance);
}
