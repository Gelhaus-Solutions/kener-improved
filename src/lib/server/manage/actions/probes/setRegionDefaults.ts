import db from "$lib/server/db/db.js";
import { MERGED_REGION_ID } from "$lib/server/db/regions.js";
import { coordinatesForCode } from "$lib/regions/coordinates.js";
import { SOURCE_MODES } from "$lib/server/probes/merge.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  region_id?: number;
  /** Null clears the override, so the region inherits the instance default again. */
  default_weight?: number | null;
  default_trust_rank?: number | null;
  default_mode?: string | null;
  /**
   * B13. Where the region is, for the map. Null clears it, and a region with no
   * coordinates stays fully usable and simply is not plotted.
   */
  latitude?: number | null;
  longitude?: number | null;
  /**
   * B13. Fill latitude and longitude from the built-in lookup for this region's
   * code, when it knows the code. Ignored if explicit coordinates are also sent.
   */
  use_known_coordinates?: boolean;
}

/**
 * Null means inherit, and 0 does not.
 *
 * This is the distinction the whole cascade rests on: a weight of 0 is a real
 * setting meaning "this region cannot carry a vote", so "not set" cannot be
 * spelled 0. An absent field is left alone; an explicit null clears it.
 */
function optionalNonNegative(raw: unknown, field: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ActionError(400, `${field} must be a number of 0 or more, or empty`);
  return Math.floor(n);
}

/**
 * B1d. A region's defaults: the middle level of the cascade.
 *
 * Applies to every monitor observed from this region unless that monitor says
 * otherwise. The local check has a region row of its own (`local`, id -1) so it
 * is configured through this same action rather than being special-cased into
 * its own screen.
 */
export default {
  action: "setRegionDefaults",
  audit: { targetType: "region" },
  handler: async (data: Payload) => {
    const regionId = Number(data.region_id);
    if (!Number.isFinite(regionId)) throw new ActionError(400, "region_id is required");

    // Region 0 is the computed verdict. Nothing observes there, so weighting it
    // would be configuring the answer rather than one of the inputs.
    if (regionId === MERGED_REGION_ID) {
      throw new ActionError(
        400,
        "The merged verdict is computed from the other regions and has no settings of its own",
      );
    }

    const region = (await db.getMergeRegions()).find((r) => r.id === regionId);
    if (!region) throw new ActionError(404, "That region does not exist");

    if (data.default_mode !== undefined && data.default_mode !== null && data.default_mode !== "") {
      if (!(SOURCE_MODES as readonly string[]).includes(String(data.default_mode))) {
        throw new ActionError(400, `default_mode must be one of ${SOURCE_MODES.join(", ")}`);
      }
    }

    const patch: Record<string, number | string | null> = {};

    // B13. Coordinates. Bounded rather than trusted: a latitude of 200 would put
    // a pin outside the canvas, and an out-of-range number is far more likely to
    // be a transposed pair than a real intent.
    const coordinate = (raw: unknown, field: string, limit: number): number | null | undefined => {
      if (raw === undefined) return undefined;
      if (raw === null || raw === "") return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < -limit || n > limit) {
        throw new ActionError(400, `${field} must be between -${limit} and ${limit}, or empty`);
      }
      return n;
    };

    const latitude = coordinate(data.latitude, "latitude", 90);
    const longitude = coordinate(data.longitude, "longitude", 180);
    if (latitude !== undefined) patch.latitude = latitude;
    if (longitude !== undefined) patch.longitude = longitude;

    // The convenience path, and it never overrides an explicit value: an
    // operator who typed coordinates meant them, and a lookup silently winning
    // would be the setting that does not stick.
    if (data.use_known_coordinates === true && latitude === undefined && longitude === undefined) {
      const known = coordinatesForCode(region.code);
      if (!known) {
        throw new ActionError(400, `No built-in coordinates for the region code "${region.code}"`);
      }
      patch.latitude = known.latitude;
      patch.longitude = known.longitude;
    }
    const weight = optionalNonNegative(data.default_weight, "default_weight");
    if (weight !== undefined) patch.default_weight = weight;
    const trustRank = optionalNonNegative(data.default_trust_rank, "default_trust_rank");
    if (trustRank !== undefined) patch.default_trust_rank = trustRank;
    if (data.default_mode !== undefined) {
      patch.default_mode = data.default_mode === null || data.default_mode === "" ? null : String(data.default_mode);
    }

    if (Object.keys(patch).length === 0) return { success: true, changed: 0 };

    const changed = await db.updateRegionDefaults(regionId, patch);
    return { success: true, changed };
  },
} satisfies ActionDefinition<Payload>;
