import db from "$lib/server/db/db.js";
import { GetMonitorsParsed } from "$lib/server/controllers/monitorsController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  monitor_tag?: string;
}

/**
 * B12c. One multi-region service's endpoints, for the editor.
 *
 * Returns the region list alongside them, because the editor needs to offer the
 * regions a service may be deployed IN - the Q1 marker - and asking for that
 * separately would let the two answers disagree about which regions exist.
 */
export default {
  action: "getMultiRegionEndpoints",
  handler: async (data: Payload) => {
    const parentTag = String(data.monitor_tag ?? "").trim();
    if (!parentTag) throw new ActionError(400, "monitor_tag is required");

    const [targets, regions] = await Promise.all([db.getRegionTargets(parentTag), db.getMergeRegions()]);
    const regionById = new Map(regions.map((region) => [region.id, region]));

    // The address lives in the endpoint monitor's own `type_data`, so the editor
    // reads what is actually being checked rather than a copy that could drift.
    const endpoints = [];
    for (const target of targets) {
      const child = (await GetMonitorsParsed({ tag: target.child_tag }))[0];
      const typeData = (child?.type_data ?? {}) as Record<string, unknown>;
      const region = regionById.get(target.region_id);
      endpoints.push({
        region_id: target.region_id,
        region_code: region?.code ?? String(target.region_id),
        region_name: region?.name ?? `Region ${target.region_id}`,
        child_tag: target.child_tag,
        address: String(typeData.url ?? ""),
        // So the editor can say "this endpoint exists but is not being checked",
        // which is what a monitor deleted out from under a target looks like.
        missing: !child,
      });
    }

    return {
      endpoints,
      // Only the regions a service may be deployed in. A probe-only region is a
      // place checks run FROM and must not be offerable here.
      deployable_regions: regions
        .filter((region) => region.id > 0 && region.usable_as_target)
        .map((region) => ({ id: region.id, code: region.code, name: region.name })),
    };
  },
} satisfies ActionDefinition<Payload>;
