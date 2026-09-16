import db from "$lib/server/db/db.js";
import GC from "$lib/global-constants.js";
import { CreateMonitor, UpdateMonitor, GetMonitorsParsed } from "$lib/server/controllers/monitorsController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

/**
 * B12c. The regional endpoints of one multi-region service.
 *
 * **This is the only thing that materialises a regional endpoint**, and it is
 * deliberately one action rather than create/update/delete, because the three
 * cannot be reasoned about separately: moving a service from two regions to
 * three is an add, and from three to two is a removal that must not destroy
 * history. Given the whole list, all of that is one comparison.
 *
 * Each endpoint IS an ordinary monitor, hidden, carrying the parent's shared
 * configuration with its own URL. See B12a for why it has to be an ordinary
 * monitor: `monitoring_data` is keyed `(monitor_tag, region_id, timestamp)` and
 * that `region_id` is already the PROBE region, so a regional endpoint that was
 * not a monitor tag would need a fourth primary-key column on the largest table
 * in the schema.
 */

/**
 * **API only, for now, and stated rather than silently assumed.**
 *
 * A multi-region service is one deployment reached at several addresses, which
 * for HTTP is exactly one URL per region. PING and TCP do not have that shape:
 * their `type_data` holds an ARRAY of hosts, so "the address of this region"
 * is not a field but a question about what a multi-host regional endpoint would
 * mean. That is a design decision rather than a few more lines, and inventing an
 * answer here would bake it in.
 */
const SUPPORTED_ENDPOINT_TYPES = ["API"] as const;

/** Which `type_data` field carries the per-region address, by endpoint type. */
const ADDRESS_FIELD: Record<string, string> = { API: "url" };

interface EndpointInput {
  region_id?: number;
  address?: string;
}

interface Payload {
  monitor_tag?: string;
  endpoints?: EndpointInput[];
}

/**
 * The tag of the hidden monitor serving `regionCode` for `parentTag`.
 *
 * **Derived, but never parsed back.** Which region an endpoint serves is read
 * from `monitor_region_targets.region_id`, never from this string: a region can
 * be renamed and a tag cannot, since `monitoring_data` is keyed by it. The
 * derivation exists to produce a readable, stable name once.
 *
 * Double underscore because a single one is legal inside both a monitor tag and
 * a region code, so `shop_eu_central` would be ambiguous to a human reading a
 * log even though nothing in the code cares.
 */
function endpointTag(parentTag: string, regionCode: string): string {
  return `${parentTag}__${regionCode}`;
}

export default {
  action: "setMultiRegionEndpoints",
  audit: { targetType: "monitor" },
  handler: async (data: Payload) => {
    const parentTag = String(data.monitor_tag ?? "").trim();
    if (!parentTag) throw new ActionError(400, "monitor_tag is required");

    const parents = await GetMonitorsParsed({ tag: parentTag });
    const parent = parents[0];
    if (!parent) throw new ActionError(404, "That monitor does not exist");
    if (parent.monitor_type !== "MULTI_REGION") {
      throw new ActionError(400, "Only a multi-region service has regional endpoints");
    }

    const typeData = (parent.type_data ?? {}) as Record<string, unknown>;
    const endpointType = String(typeData.endpointType ?? "API");
    if (!(SUPPORTED_ENDPOINT_TYPES as readonly string[]).includes(endpointType)) {
      throw new ActionError(
        400,
        `A multi-region service's endpoints must be one of ${SUPPORTED_ENDPOINT_TYPES.join(", ")}`,
      );
    }
    const addressField = ADDRESS_FIELD[endpointType];

    const requested = Array.isArray(data.endpoints) ? data.endpoints : [];

    // Rejected here rather than left to the unique index, so the operator is
    // told which region they listed twice instead of reading a constraint name.
    const seen = new Set<number>();
    for (const endpoint of requested) {
      const regionId = Number(endpoint.region_id);
      if (!Number.isFinite(regionId)) throw new ActionError(400, "every endpoint needs a region");
      if (seen.has(regionId)) throw new ActionError(400, "a service may have only one endpoint per region");
      seen.add(regionId);
      if (!String(endpoint.address ?? "").trim()) {
        throw new ActionError(400, "every endpoint needs an address");
      }
    }

    const regions = await db.getMergeRegions();
    const regionById = new Map(regions.map((region) => [region.id, region]));

    /**
     * **Every region is checked before anything is written.**
     *
     * This used to happen inside the write loop, which meant a list whose second
     * endpoint named a probe-only region had already created the first one by
     * the time it was refused: the operator got an error and a half-built
     * service. Validation of the whole list up front is what makes the action
     * all-or-nothing from the caller's point of view.
     */
    for (const endpoint of requested) {
      const region = regionById.get(Number(endpoint.region_id));
      if (!region) throw new ActionError(404, `Region ${endpoint.region_id} does not exist`);
      // The Q1 marker, enforced rather than merely displayed. A probe-only
      // region is a place checks run FROM, and offering it as a place a service
      // is deployed IN is the axis confusion the marker exists to prevent.
      if (!region.usable_as_target) {
        throw new ActionError(400, `"${region.name}" is not marked as a place a service can be deployed`);
      }
    }

    const existing = await db.getRegionTargets(parentTag);
    const existingByRegion = new Map(existing.map((target) => [target.region_id, target]));

    /**
     * The shared configuration, minus the two keys that are not shared.
     *
     * `endpointType` says what KIND of check the endpoints are and is not part
     * of an endpoint's own config; the address field is per region by
     * definition. Everything else - method, headers, timeout, eval, redirects -
     * is copied to every endpoint, which is the point of the whole model.
     */
    const shared: Record<string, unknown> = { ...typeData };
    delete shared.endpointType;
    delete shared[addressField];

    let created = 0;
    let updated = 0;
    let removed = 0;

    for (const endpoint of requested) {
      const regionId = Number(endpoint.region_id);
      // Present and deployable: both established above, before any write.
      const region = regionById.get(regionId)!;

      const address = String(endpoint.address).trim();
      const childType = { ...shared, [addressField]: address };
      const target = existingByRegion.get(regionId);
      const tag = target?.child_tag ?? endpointTag(parentTag, region.code);

      const already = (await GetMonitorsParsed({ tag }))[0];

      if (already) {
        // **Reactivated rather than recreated.** A region removed and added back
        // finds its old monitor, and with it every bar that monitor ever
        // recorded: `monitoring_data` is keyed by tag, so reusing the tag is
        // what makes removal non-destructive.
        await UpdateMonitor({
          ...already,
          id: Number(already.id),
          status: GC.ACTIVE,
          is_hidden: GC.YES,
          cron: parent.cron,
          monitor_type: endpointType,
          type_data: JSON.stringify(childType),
        } as never);
        updated++;
      } else {
        await CreateMonitor({
          tag,
          name: `${parent.name} (${region.name})`,
          // Hidden is not cosmetic: `isPubliclyVisible` is the one definition of
          // what the public may see, and it is what keeps one service from
          // reappearing on the status page as three.
          is_hidden: GC.YES,
          status: GC.ACTIVE,
          cron: parent.cron,
          monitor_type: endpointType,
          type_data: JSON.stringify(childType),
          // Inherited so an endpoint judges itself exactly as the service would.
          confirmation_threshold: parent.confirmation_threshold,
          include_degraded_in_downtime: parent.include_degraded_in_downtime,
          day_degraded_minimum_count: parent.day_degraded_minimum_count,
          day_down_minimum_count: parent.day_down_minimum_count,
        } as never);
        created++;
      }

      if (!target) await db.addRegionTarget({ parentTag, childTag: tag, regionId });
    }

    for (const target of existing) {
      if (seen.has(target.region_id)) continue;

      // **Detached and deactivated, never deleted.** Deleting the monitor would
      // take ninety days of history with it, and an operator removing a region
      // from a service has not asked to destroy what that region reported. The
      // row stops being an endpoint; the monitor stops being checked; the bars
      // stay.
      const orphan = (await GetMonitorsParsed({ tag: target.child_tag }))[0];
      if (orphan) {
        await UpdateMonitor({ ...orphan, id: Number(orphan.id), status: "INACTIVE" } as never);
      }
      await db.removeRegionTarget(target.child_tag);
      removed++;
    }

    return { success: true, created, updated, removed };
  },
} satisfies ActionDefinition<Payload>;
