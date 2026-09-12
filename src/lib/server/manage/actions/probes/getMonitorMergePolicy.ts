import db from "$lib/server/db/db.js";
import { GetSiteDataByKey } from "$lib/server/controllers/siteDataController.js";
import { MERGED_REGION_ID } from "$lib/server/db/regions.js";
import { LOCAL_REGION_ID, parseMergeDefaults, resolveMergeConfig } from "$lib/server/probes/merge.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  monitor_tag?: string;
}

/**
 * B1d. One monitor's merge settings, and what they actually resolve to.
 *
 * **Returns both the overrides and the resolved values**, because a cascade the
 * operator cannot see through is a cascade they will misconfigure. The form
 * edits `override`; `effective` is what the merge would use right now, so every
 * field can be shown as its own value or as the inherited one without the screen
 * having to reimplement the resolution order and drift from it.
 */
export default {
  action: "getMonitorMergePolicy",
  handler: async (data: Payload) => {
    const monitorTag = String(data.monitor_tag ?? "").trim();
    if (!monitorTag) throw new ActionError(400, "monitor_tag is required");

    const monitor = await db.getMonitorsByTag(monitorTag);
    if (!monitor) throw new ActionError(404, "That monitor does not exist");

    const [stored, regions, policyRow, sourceRows, targets] = await Promise.all([
      GetSiteDataByKey("probeMergePolicy"),
      db.getMergeRegions(),
      db.getMonitorMergePolicy(monitorTag),
      db.getMonitorSourcePolicies(monitorTag),
      db.getProbeTargetsForMonitor(monitorTag),
    ]);

    // Which sources this monitor could actually hear from. Local always
    // participates: either the server checks it or an agent does so on the
    // server's behalf, and an agent at region 0 means the latter.
    const participating = [
      LOCAL_REGION_ID,
      ...targets.map((t) => (t.region_id === MERGED_REGION_ID ? LOCAL_REGION_ID : t.region_id)),
    ];

    const instance = parseMergeDefaults(stored);
    const effective = resolveMergeConfig({
      instance,
      regions,
      monitorPolicy: policyRow ?? null,
      monitorSources: sourceRows,
      participatingRegions: participating,
    });

    const regionById = new Map(regions.map((r) => [r.id, r]));
    return {
      monitor_tag: monitorTag,
      instance,
      override: {
        policy: policyRow?.policy ?? null,
        quorum_threshold: policyRow?.quorum_threshold ?? null,
        degraded_on_disagreement:
          policyRow?.degraded_on_disagreement === null || policyRow?.degraded_on_disagreement === undefined
            ? null
            : !!policyRow.degraded_on_disagreement,
        sources: sourceRows.map((row) => ({
          region_id: row.region_id,
          weight: row.weight,
          trust_rank: row.trust_rank,
          mode: row.mode,
        })),
      },
      effective: {
        policy: effective.policy,
        quorum_threshold: effective.quorumThreshold,
        degraded_on_disagreement: effective.degradedOnDisagreement,
        sources: [...effective.sources.values()]
          .sort((a, b) => a.regionId - b.regionId)
          .map((source) => ({
            region_id: source.regionId,
            region_name:
              source.regionId === LOCAL_REGION_ID
                ? "Local check"
                : (regionById.get(source.regionId)?.name ?? `Region ${source.regionId}`),
            weight: source.weight,
            trust_rank: source.trustRank,
            mode: source.mode,
          })),
      },
    };
  },
} satisfies ActionDefinition<Payload>;
