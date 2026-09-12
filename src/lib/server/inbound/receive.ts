import db from "../db/db.js";
import GC from "../../global-constants.js";
import { runWithOrg } from "../db/orgContext.js";
import { CreateHash } from "../controllers/commonController.js";
import { CreateIncident, AddIncidentMonitor, AddIncidentComment } from "../controllers/incidentController.js";
import type { InboundAlertRecord, InboundEndpointRecord } from "../db/repositories/inbound.js";
import { parseInboundPayload } from "./parsers.js";
import { impactFor, parseMappingRules, resolveMonitorTag, severityFor } from "./mapping.js";
import type { InboundProvider, NormalisedAlert } from "./types.js";
import { signatureHeaderFor, verifySignature } from "./signature.js";
import { open as openSealed } from "../crypto/secretBox.js";

/**
 * H1. What happens when somebody else's alerting posts to Kener.
 *
 * **The whole job is being idempotent.** Alertmanager re-sends a firing alert
 * every `repeat_interval` for as long as it fires, and every other provider here
 * does something similar. The naive receiver opens an incident per notification
 * and buries the status page in duplicates of one outage - the most visible
 * possible failure for a status page, and the reason this file is written around
 * `(endpoint_id, fingerprint)` rather than around the request.
 *
 * So the shape is: the fingerprint decides which alert row this is, the alert
 * row remembers which incident it opened, and the incident is opened once. A
 * second notification about the same problem moves `last_seen_at` and nothing
 * else.
 *
 * **The token decides the org, before anything else happens.** These URLs are
 * public. The endpoint is found across orgs by its hashed token and every
 * subsequent read and write runs inside that endpoint's org, so an alert can
 * only ever reach the tenant whose token was presented.
 */

export type ReceiveResult =
  | {
      ok: true;
      /** Alerts understood in this payload. Zero is legitimate: a heartbeat notification carries none. */
      accepted: number;
      opened: number;
      resolved: number;
      /** Understood, recorded, and deliberately not turned into an incident. */
      unmapped: number;
    }
  | { ok: false; status: number; reason: string };

/** Why an incident was not opened, in the words the screen shows an operator. */
const NO_COMPONENT = "no mapping rule matched and the endpoint has no default component";

function labelsJson(alert: NormalisedAlert): string | null {
  const entries = Object.entries(alert.labels);
  return entries.length > 0 ? JSON.stringify(alert.labels) : null;
}

/**
 * Opens the incident one firing alert deserves.
 *
 * **Components are attached before the first comment, deliberately.** The
 * comment is what notifies subscribers, and subscriber scoping resolves from the
 * incident's attached components: posting the comment first sends it to nobody,
 * because at that instant the incident is about nothing. This is the ordering
 * the v5 incidents route documents, and the reason this does not use
 * `CreateNewIncidentWithCommentAndMonitor`, which comments first.
 */
async function openIncidentFor(
  alert: NormalisedAlert,
  endpoint: InboundEndpointRecord,
  monitorTag: string,
  at: number,
): Promise<number> {
  const { incident_id } = await CreateIncident({
    title: alert.title,
    start_date_time: alert.startsAt ?? at,
    status: "OPEN",
    state: GC.INVESTIGATING,
    incident_type: "INCIDENT",
    // Distinct from "ALERT", which is Kener's own checks. An operator looking at
    // an incident needs to know whether Kener decided this or was told it.
    incident_source: "INBOUND",
    severity: severityFor(alert, endpoint.default_severity),
    detected_at: alert.startsAt ?? at,
  });

  await AddIncidentMonitor(incident_id, monitorTag, impactFor(endpoint.default_impact));

  await AddIncidentComment(
    incident_id,
    alert.description?.trim() ? alert.description : alert.title,
    GC.INVESTIGATING,
    at,
  );

  return incident_id;
}

/**
 * Closes the incident a resolved alert opened, if it is still open.
 *
 * Guarded rather than attempted, in the same shape as `alertingQueue.closeIncident`:
 * a provider re-sending its resolved notification must not post a second
 * RESOLVED comment, and an incident a human already closed must not be reopened
 * and re-closed by a late webhook.
 */
async function closeIncidentFor(incidentId: number, alert: NormalisedAlert, at: number): Promise<boolean> {
  const incident = await db.getIncidentById(incidentId);
  if (!incident) return false;
  if (incident.status === GC.CLOSED || incident.state === GC.RESOLVED) return false;

  await AddIncidentComment(
    incidentId,
    alert.description?.trim() ? alert.description : `${alert.title} has cleared.`,
    GC.RESOLVED,
    at,
  );
  return true;
}

/**
 * Applies one parsed alert to the endpoint's state.
 *
 * Returns what it did, so the caller can report a summary to the sender: a
 * provider that gets a 200 with "0 opened" from a payload it believed was an
 * outage has a mapping problem, and saying so in the response is far cheaper
 * than making somebody read the database.
 */
async function applyAlert(
  alert: NormalisedAlert,
  endpoint: InboundEndpointRecord,
  rules: ReturnType<typeof parseMappingRules>,
  at: number,
): Promise<"opened" | "resolved" | "unmapped" | "noop"> {
  const monitorTag = resolveMonitorTag(alert, rules, endpoint.default_monitor_tag);
  const existing = await db.getInboundAlert(endpoint.id, alert.fingerprint);

  const common = {
    status: alert.status,
    monitor_tag: monitorTag,
    severity: alert.severity,
    title: alert.title,
    description: alert.description,
    labels: labelsJson(alert),
    last_seen_at: at,
  };

  if (!existing) {
    if (alert.status === "RESOLVED") {
      // A resolve for something we never saw fire. Recorded so the screen can
      // show it arrived, but there is no incident to close: inventing one and
      // immediately closing it would put a phantom outage in the public history.
      await insertAlertRow(endpoint, alert, { ...common, incident_id: null, resolved_at: at }, at);
      return "noop";
    }
    if (!monitorTag) {
      await insertAlertRow(endpoint, alert, { ...common, incident_id: null, resolved_at: null }, at);
      return "unmapped";
    }
    const incidentId = await openIncidentFor(alert, endpoint, monitorTag, at);
    await insertAlertRow(endpoint, alert, { ...common, incident_id: incidentId, resolved_at: null }, at);
    return "opened";
  }

  const count = Number(existing.notification_count ?? 0) + 1;

  if (alert.status === "RESOLVED") {
    const wasFiring = existing.status !== "RESOLVED";
    let closed = false;
    if (wasFiring && existing.incident_id && truthy(endpoint.auto_resolve)) {
      closed = await closeIncidentFor(existing.incident_id, alert, at);
    }
    await db.updateInboundAlert(existing.id, {
      ...common,
      notification_count: count,
      resolved_at: existing.resolved_at ?? at,
    });
    return closed ? "resolved" : "noop";
  }

  // Firing. Either this is a re-notification of an alert already open, or an
  // alert that resolved and has come back - which is a new outage and gets a new
  // incident, because the old one is closed and its history belongs to the
  // earlier event.
  const reFired = existing.status === "RESOLVED";
  if (!reFired && existing.incident_id) {
    await db.updateInboundAlert(existing.id, { ...common, notification_count: count });
    return "noop";
  }

  if (!monitorTag) {
    await db.updateInboundAlert(existing.id, {
      ...common,
      incident_id: null,
      resolved_at: null,
      notification_count: count,
    });
    return "unmapped";
  }

  const incidentId = await openIncidentFor(alert, endpoint, monitorTag, at);
  await db.updateInboundAlert(existing.id, {
    ...common,
    incident_id: incidentId,
    resolved_at: null,
    notification_count: count,
    // The alert is firing again, so this occurrence started now.
    first_seen_at: alert.startsAt ?? at,
  });
  return "opened";
}

/** SQLite stores booleans as 0/1, so `auto_resolve` arrives as either. */
function truthy(value: boolean | number): boolean {
  return value === true || value === 1;
}

async function insertAlertRow(
  endpoint: InboundEndpointRecord,
  alert: NormalisedAlert,
  fields: Omit<Parameters<typeof db.insertInboundAlert>[0], "endpoint_id" | "fingerprint" | "first_seen_at">,
  at: number,
): Promise<void> {
  await db.insertInboundAlert({
    ...fields,
    endpoint_id: endpoint.id,
    fingerprint: alert.fingerprint,
    first_seen_at: alert.startsAt ?? at,
  });
}

/**
 * The receive path, from a presented token to whatever it changed.
 *
 * Errors are returned rather than thrown, with the status the sender should see.
 * A webhook sender reads the status code and retries on 5xx, so the difference
 * between "your token is wrong" (401, never retry) and "we broke" (500, please
 * retry) is a behaviour difference at the other end, not a log entry.
 */
export async function receiveInboundAlert(
  token: string,
  payload: unknown,
  at: number = Math.floor(Date.now() / 1000),
  /**
   * The body exactly as it arrived, and the headers it arrived with.
   *
   * Needed only when the endpoint is configured to verify a signature, and the
   * *raw* body specifically: re-serialising the parsed object would change key
   * order and whitespace, so the HMAC would never match what the sender
   * computed. Omitted by callers that have already established trust, such as a
   * test driver.
   */
  signed?: { raw: string; header: (name: string) => string | null },
): Promise<ReceiveResult> {
  if (!token || token.trim() === "") return { ok: false, status: 401, reason: "unauthorized" };

  // Across orgs: this lookup is what *determines* the org.
  const endpoint = await db.findEndpointByTokenHash(CreateHash(token));
  if (!endpoint) return { ok: false, status: 401, reason: "unauthorized" };

  if (endpoint.status !== "ACTIVE") {
    await runWithOrg(endpoint.org_id, () =>
      db.recordEndpointRequest(endpoint.id, { ok: false, error: "endpoint is disabled", at }),
    );
    return { ok: false, status: 403, reason: "this endpoint is disabled" };
  }

  return await runWithOrg(endpoint.org_id, async () => {
    // An endpoint that holds a signing secret refuses anything unsigned. A check
    // that can be skipped by leaving out the header is not a check.
    if (endpoint.signing_secret_encrypted) {
      const secret = openSealed(endpoint.signing_secret_encrypted, "inbound_signing_secret");
      if (!secret) {
        await db.recordEndpointRequest(endpoint.id, { ok: false, error: "signing secret unreadable", at });
        return { ok: false as const, status: 500, reason: "this endpoint's signing secret could not be read" };
      }
      const header = signatureHeaderFor(endpoint.provider as InboundProvider);
      const verdict = verifySignature(signed?.raw ?? "", signed?.header(header) ?? null, secret);
      if (!verdict.ok) {
        await db.recordEndpointRequest(endpoint.id, { ok: false, error: verdict.reason, at });
        return { ok: false as const, status: 401, reason: verdict.reason };
      }
    }

    let alerts: NormalisedAlert[];
    try {
      alerts = parseInboundPayload(endpoint.provider as InboundProvider, payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "could not read that payload";
      await db.recordEndpointRequest(endpoint.id, { ok: false, error: reason, at });
      return { ok: false as const, status: 400, reason };
    }

    let opened = 0;
    let resolved = 0;
    let unmapped = 0;

    for (const alert of alerts) {
      // One bad alert must not discard the rest of a batch: Alertmanager sends
      // a whole group at once, and failing the request would make it retry the
      // ones that already succeeded.
      try {
        const outcome = await applyAlert(alert, endpoint, parseMappingRules(endpoint.mapping_rules), at);
        if (outcome === "opened") opened++;
        else if (outcome === "resolved") resolved++;
        else if (outcome === "unmapped") unmapped++;
      } catch (error) {
        console.error(`Inbound alert ${alert.fingerprint} on endpoint ${endpoint.id} failed:`, error);
        await db.recordEndpointRequest(endpoint.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          at,
        });
      }
    }

    await db.recordEndpointRequest(endpoint.id, {
      ok: true,
      at,
      error: unmapped > 0 ? NO_COMPONENT : null,
    });

    return { ok: true as const, accepted: alerts.length, opened, resolved, unmapped };
  });
}

export type { InboundAlertRecord, InboundEndpointRecord };
