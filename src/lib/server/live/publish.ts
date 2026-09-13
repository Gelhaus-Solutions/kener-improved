import { redisIOConnection } from "../redisConnector.js";
import { channelFor, sequenceKeyFor, type LiveEvent, type LiveMessage } from "./hub.js";

// G5: the publish half. Called from the two places a transition is already known.
//
// **Every failure here is swallowed, and that is the whole design rule.** This
// runs inside the monitor response worker and inside the page-status consumer -
// the paths that record that a customer's service went down. A live-update
// nicety must never be able to fail a check, fail a delivery, or make a job
// retry. A dropped event costs a viewer a stale bar until the next transition or
// their next reload; a thrown one costs a monitoring sample.

/**
 * The id is minted in Redis, not in the process.
 *
 * `INCR` per org gives ids that are globally ordered across every web and
 * scheduler process, which is what makes `Last-Event-ID` mean anything on an
 * instance running more than one. A process-local counter would produce two
 * events with id 7 that are not the same event.
 */
async function nextId(orgId: number): Promise<number> {
  const redis = redisIOConnection();
  return await redis.incr(sequenceKeyFor(orgId));
}

async function publish(orgId: number, event: LiveEvent): Promise<void> {
  try {
    const id = await nextId(orgId);
    const message: LiveMessage = { id, event };
    await redisIOConnection().publish(channelFor(orgId), JSON.stringify(message));
  } catch (error) {
    // See the header. Never rethrow.
    console.warn("live publish failed:", error instanceof Error ? error.message : String(error));
  }
}

/**
 * A monitor changed status.
 *
 * `monitor_tag` is the **physical** tag, matching what the public page holds in
 * `monitorTags` and keys `monitorBarDataByTag` by. Publishing the per-org slug
 * instead would mean every event on a prefixed org silently matched nothing in
 * the browser - a live stream that connects, delivers, and updates nothing.
 */
export async function publishMonitorStatus(
  orgId: number | null,
  data: { monitor_tag: string; status: string; previous_status: string | null; timestamp: number },
): Promise<void> {
  // No org means the caller is running across tenants and has nothing to
  // address; there is no sensible channel to publish on.
  if (orgId === null) return;
  await publish(orgId, { kind: "monitor_status", ...data });
}

/**
 * B13. One probe region reported for a monitor.
 *
 * **Published on every region sample, not only on a transition**, which is the
 * opposite of `publishMonitorStatus` and deliberate. The map shows a region's
 * CURRENT state including freshness, and a region that keeps reporting UP is
 * exactly the case a stale-data timer would otherwise turn grey. Skipping the
 * unchanged samples would make a healthy region fade to "no recent data" on a
 * viewer's open page while it was reporting perfectly well.
 *
 * The volume is bounded by probe regions rather than by monitors: a region is a
 * handful per instance, not hundreds.
 *
 * Never called for region 0. That is the merged verdict, it is not a place, and
 * it reaches the page as `monitor_status` like it always did.
 */
export async function publishRegionStatus(
  orgId: number | null,
  data: { monitor_tag: string; region_id: number; status: string; latency: number | null; timestamp: number },
): Promise<void> {
  if (orgId === null) return;
  // Guarded here as well as at the call site: a region 0 event on this channel
  // would put the merged verdict on the map as though it were a location.
  if (data.region_id <= 0) return;
  await publish(orgId, { kind: "region_status", ...data });
}

/** A status page's overall status changed. */
export async function publishPageStatus(
  orgId: number | null,
  data: {
    page_id: number;
    page_path: string;
    status: string;
    component_impact: string;
    status_summary: string;
  },
): Promise<void> {
  if (orgId === null) return;
  await publish(orgId, { kind: "page_status", ...data });
}
