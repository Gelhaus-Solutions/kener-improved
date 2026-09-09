/**
 * The region convention `monitoring_data` is keyed on (B1a).
 *
 * `monitoring_data`'s primary key is `(monitor_tag, region_id, timestamp)`. That
 * shape exists so a monitor can be checked from more than one place without two
 * reports of the same minute colliding on the way in - under the old
 * `(monitor_tag, timestamp)` key they did, silently, because both write paths
 * name the key as their `onConflict` target and the merge would simply overwrite
 * whichever sample lost the race.
 *
 * **Region 0 is the merged, authoritative verdict.** It is the one every read in
 * Kener goes through, and it is what the local scheduler writes today. Probe
 * regions report alongside it at `>= 1`; nothing renders them directly, and
 * merging them down into region 0 is the probe workstream's job (P10), not this
 * layer's.
 *
 * The value of the convention is that it froze the meaning of every existing
 * query at the moment it was adopted. Each one gained exactly one predicate,
 * `region_id = 0`, and can never quietly start averaging across regions later.
 * Without it, `getLatestMonitoringData`, `getLastKnownStatus`,
 * `consecutivelyStatusFor` and the confirmation threshold would each begin
 * seeing N rows per minute the day a second region appeared, and each would be
 * wrong in its own way.
 *
 * **Deletes are the deliberate exception.** Retention and delete-by-tag operate
 * on every region, because keeping a probe's samples after pruning the verdict
 * they were merged into would leave history nothing reads and nothing prunes.
 * See `MonitoringRepository.background` and `deleteMonitorDataByTag`.
 */
export const MERGED_REGION_ID = 0;

/**
 * A row of the `regions` catalogue.
 *
 * `org_id` is null on exactly one row - id 0, which belongs to the instance
 * rather than to a tenant. `regions` is in `TENANT_TABLES`, so a scoped read
 * deliberately never returns it: region 0 is a constant, not something to look
 * up.
 */
export interface Region {
  id: number;
  org_id: number | null;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
}
