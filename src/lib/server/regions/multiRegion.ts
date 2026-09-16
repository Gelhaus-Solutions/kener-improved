import db from "../db/db.js";

/**
 * B12b. Is this monitor a regional endpoint of a multi-region service?
 *
 * **The question the Q3 decision turns on.** Enno settled that alerting fires
 * per SERVICE and names the region, rather than per region. Under B12a's model
 * every regional endpoint is an ordinary monitor with its own tag, and
 * `monitor_alerts_config` is keyed on `monitor_tag` - so without this the
 * DEFAULT behaviour is the twelve-page storm that decision rejected.
 *
 * It is not hypothetical and it is not only about new configs. B12d folds an
 * EXISTING set of regional monitors into one service, and those monitors already
 * carry the alert configs that are how they are watched today. The moment they
 * become endpoints, every one of those configs is still attached and still
 * firing.
 */

/**
 * **Fails OPEN, and that is the same bargain `alertConfigTags.ts` makes.**
 *
 * A database error here cannot be allowed to decide that a monitor is an
 * endpoint, because the consequence of a wrong "yes" is an alert that never
 * fires - silently, during the outage it existed for. A wrong "no" costs
 * duplicate pages, which are loud, survivable and obvious. So every failure path
 * answers "not an endpoint" and lets the alert through.
 */
export async function isRegionalEndpoint(monitorTag: string): Promise<boolean> {
  try {
    return (await db.getRegionTargetByChild(monitorTag)) !== undefined;
  } catch (error) {
    console.warn(
      `multi-region: could not tell whether "${monitorTag}" is a regional endpoint, alerting on it anyway:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
