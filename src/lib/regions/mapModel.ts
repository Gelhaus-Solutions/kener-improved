import type { PlottableRegion } from "./projection.js";

/**
 * B13. What the map is allowed to say about a region.
 *
 * Shared by the server that builds the model and the component that draws it,
 * so the two cannot disagree about what a colour means.
 */

/**
 * The states a region can be in on the map.
 *
 * **NO_DATA is a first-class state, not an absence**, and it is the single
 * easiest way to make this feature lie. A region whose agents are offline has no
 * samples; colouring that red announces an outage that is not happening, and
 * colouring it green announces health nobody observed. It gets its own colour
 * and its own word, consistent with `NO_DATA` everywhere else in the codebase.
 */
export type RegionMapStatus = "UP" | "DEGRADED" | "DOWN" | "MAINTENANCE" | "NO_DATA";

export interface RegionMapEntry extends PlottableRegion {
  status: RegionMapStatus;
  /** UTC seconds of the sample this status came from. Null when NO_DATA. */
  observedAt: number | null;
  latencyMs: number | null;
  /**
   * B1d. The region is recorded but does not vote.
   *
   * Must be visibly distinct on the map, or it implies the region influenced a
   * verdict it cannot influence. A DISPLAY_ONLY region showing red next to a
   * green headline is not a contradiction; it is the point of the mode.
   */
  displayOnly: boolean;
  /** How many probe agents this region holds, for the hover. */
  agentCount: number;
}

/**
 * How stale a sample may be and still count as current, in seconds.
 *
 * Five minutes: monitors check at most once a minute, so a region that has
 * missed five consecutive checks has stopped reporting rather than been slow.
 * Anything longer keeps a dead region's last known colour on screen, and a stale
 * green is the most dangerous thing a status map can show.
 */
export const REGION_FRESHNESS_SECONDS = 300;

/** The order states are listed in, worst first, for the accompanying table. */
const SEVERITY: Record<RegionMapStatus, number> = {
  DOWN: 0,
  DEGRADED: 1,
  MAINTENANCE: 2,
  NO_DATA: 3,
  UP: 4,
};

/**
 * Sorts regions worst-first, then by name.
 *
 * The table beside the map is the accessible equivalent of the picture, and a
 * sighted reader's eye goes to the red pin first. Alphabetical order would make
 * the screen-reader user hunt for the problem the map hands everyone else
 * immediately.
 */
export function sortForTable(entries: RegionMapEntry[]): RegionMapEntry[] {
  return [...entries].sort((a, b) => {
    const bySeverity = SEVERITY[a.status] - SEVERITY[b.status];
    return bySeverity !== 0 ? bySeverity : a.name.localeCompare(b.name);
  });
}

/**
 * The status a region's newest sample implies.
 *
 * `null` means no sample fresh enough to trust, which is NO_DATA rather than a
 * guess in either direction.
 */
export function statusFromSample(
  sample: { status?: string | null; timestamp?: number | null } | null | undefined,
  now: number,
  freshnessSeconds = REGION_FRESHNESS_SECONDS,
): RegionMapStatus {
  if (!sample || typeof sample.timestamp !== "number") return "NO_DATA";
  if (now - sample.timestamp > freshnessSeconds) return "NO_DATA";

  switch (sample.status) {
    case "UP":
      return "UP";
    case "DEGRADED":
      return "DEGRADED";
    case "DOWN":
      return "DOWN";
    case "MAINTENANCE":
      return "MAINTENANCE";
    default:
      // An unrecognised status is not an outage. Saying NO_DATA is the honest
      // answer to "we do not know what this means".
      return "NO_DATA";
  }
}

/** A short sentence for a hover or a table cell. */
export function describeEntry(entry: RegionMapEntry): string {
  const where = entry.displayOnly ? `${entry.name} (recorded, does not vote)` : entry.name;
  if (entry.status === "NO_DATA") return `${where}: no recent reports`;
  const latency = entry.latencyMs !== null ? `, ${entry.latencyMs}ms` : "";
  return `${where}: ${entry.status.toLowerCase()}${latency}`;
}
