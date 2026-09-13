import db from "../db/db.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { GetNowTimestampUTC } from "../tool.js";
import { REGION_FRESHNESS_SECONDS, statusFromSample, type RegionMapEntry } from "$lib/regions/mapModel.js";

/**
 * B13. Builds the map's model, for both surfaces.
 *
 * **One builder rather than one per screen**, because the two would drift and
 * the drift would be invisible: the public page and the admin page would show
 * the same instance differently and neither would look wrong on its own.
 *
 * The exclusions live here, once:
 *
 *   - `MERGED_REGION_ID` (0) is the merged verdict. It is not a place. It
 *     belongs in the headline beside the map and never on it.
 *   - Negative ids are the local check (`LOCAL_REGION_ID`, -1), the server
 *     checking the thing itself. Also not a place.
 *   - A region with no coordinates is still RETURNED, because the table beside
 *     the map must account for it; the component drops it from the picture.
 */

/** The regions an operator could plot. Reserved ids are not locations. */
async function plottableRegions() {
  const regions = await db.getMergeRegions();
  return regions.filter((r) => r.id > MERGED_REGION_ID);
}

/** How many agents each region holds, for the hover text. */
async function agentCounts(): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  try {
    const fleet = (await db.getProbeAgents()) as Array<{ region_id?: number }>;
    for (const agent of fleet) {
      if (typeof agent.region_id !== "number") continue;
      counts.set(agent.region_id, (counts.get(agent.region_id) ?? 0) + 1);
    }
  } catch {
    // Degrades to "0 agents" rather than taking the page down. A count is
    // decoration; the status is the content.
  }
  return counts;
}

/**
 * One monitor's view: what each region is currently seeing.
 *
 * Regions that have never reported for THIS monitor are omitted entirely rather
 * than shown as NO_DATA. A region not watching this service has not failed to
 * report on it, and drawing it grey would imply it should have.
 */
export async function regionMapForMonitor(monitorTag: string): Promise<RegionMapEntry[]> {
  const now = GetNowTimestampUTC();
  // Wider than freshness, so a region that HAS been watching this monitor and
  // has just gone quiet still appears, correctly, as NO_DATA.
  const lookback = now - REGION_FRESHNESS_SECONDS * 4;

  const [regions, samples, agents] = await Promise.all([
    plottableRegions(),
    db.getLatestPerRegion(monitorTag, lookback),
    agentCounts(),
  ]);

  const byRegion = new Map(samples.map((s) => [s.region_id, s]));

  return regions
    .filter((region) => byRegion.has(region.id))
    .map((region) => {
      const sample = byRegion.get(region.id);
      const status = statusFromSample(sample ?? null, now);
      return {
        id: region.id,
        code: region.code,
        name: region.name,
        latitude: region.latitude,
        longitude: region.longitude,
        status,
        observedAt: status === "NO_DATA" ? null : (sample?.timestamp ?? null),
        latencyMs: status === "NO_DATA" ? null : typeof sample?.latency === "number" ? sample.latency : null,
        displayOnly: region.default_mode === "DISPLAY_ONLY",
        agentCount: agents.get(region.id) ?? 0,
      } satisfies RegionMapEntry;
    });
}

/**
 * The fleet view: which regions are producing data at all.
 *
 * Not per monitor, so it answers "is this region alive" rather than "is this
 * service up there". A region configured but reporting nothing is exactly what
 * an operator opens this screen to find, so unlike the per-monitor view every
 * configured region is listed, including the silent ones.
 */
export async function regionMapForFleet(): Promise<RegionMapEntry[]> {
  const now = GetNowTimestampUTC();
  const since = now - REGION_FRESHNESS_SECONDS;

  const [regions, reporting, agents] = await Promise.all([
    plottableRegions(),
    db.getReportingRegions(since),
    agentCounts(),
  ]);

  const byRegion = new Map(reporting.map((r) => [r.region_id, r]));

  return regions.map((region) => {
    const seen = byRegion.get(region.id);
    // Fleet health has no per-monitor status, so the question is simply whether
    // anything arrived. Reporting is UP; silence is NO_DATA, and silence is
    // explicitly NOT down: an operator who has configured a region and not yet
    // started an agent has no outage.
    const status: RegionMapEntry["status"] = seen ? "UP" : "NO_DATA";
    return {
      id: region.id,
      code: region.code,
      name: region.name,
      latitude: region.latitude,
      longitude: region.longitude,
      status,
      observedAt: seen?.latest ?? null,
      latencyMs: null,
      displayOnly: region.default_mode === "DISPLAY_ONLY",
      agentCount: agents.get(region.id) ?? 0,
    } satisfies RegionMapEntry;
  });
}
