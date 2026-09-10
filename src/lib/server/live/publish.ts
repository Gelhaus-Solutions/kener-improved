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
