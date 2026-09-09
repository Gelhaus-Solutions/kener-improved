import db from "../../db/db.js";
import { computeIncidentDurations, type IncidentDurations } from "../../incidents/metrics.js";
import { hydrate } from "../../incidents/postmortem.js";
import type { IncidentRecord } from "../../types/db.js";
import type { Postmortem, PostmortemRecord } from "../../types/postmortem.js";

/**
 * v5 incident shapes.
 *
 * **v5 exists because v4 is not fixable in place.** Its PATCH and its comment
 * POST call `db.updateIncident` directly, bypassing `UpdateIncident` entirely -
 * so a state change made over v4 emits no event, stamps no C2c lifecycle
 * timestamp, and reaches no consumer. Correcting that would change what every
 * existing v4 caller observes, which is exactly what a version number is for.
 *
 * So the rule for everything under `/api/v5/`: **go through the controller,
 * never through the repository.** A route that writes a row itself is a second
 * write path, and a second write path is how v4 ended up silently eventless.
 *
 * v4 is frozen. It keeps working, byte for byte, and gains nothing.
 */

export interface V5IncidentComponent {
  monitor_tag: string;
  component_impact: string | null;
  monitor_impact: string | null;
}

export interface V5IncidentComment {
  id: number;
  comment: string;
  state: string;
  commented_at: number;
  status: string;
}

export interface V5Incident {
  id: number;
  title: string;
  status: string;
  state: string;
  severity: string;
  incident_type: string;
  is_global: boolean;
  impact_override: string | null;
  start_date_time: number;
  end_date_time: number | null;
  /** The C2c lifecycle. Null where a step never happened. */
  timeline: {
    detected_at: number | null;
    acknowledged_at: number | null;
    identified_at: number | null;
    mitigated_at: number | null;
    resolved_at: number | null;
  };
  components: V5IncidentComponent[];
  comments?: V5IncidentComment[];
  durations?: IncidentDurations;
  postmortem?: V5Postmortem | null;
}

export interface V5Postmortem {
  id: number;
  incident_id: number;
  status: string;
  title: string;
  summary: string | null;
  root_cause: string | null;
  impact_description: string | null;
  resolution: string | null;
  body_md: string | null;
  action_items: Postmortem["action_items"];
  timeline_source: string;
  timeline_custom: Postmortem["timeline_custom"];
  published_at: number | null;
  notify_subscribers: boolean;
}

export function serializePostmortem(row: PostmortemRecord | Postmortem): V5Postmortem {
  const p = "action_items" in row && Array.isArray(row.action_items) ? (row as Postmortem) : hydrate(row as PostmortemRecord);
  return {
    id: p.id,
    incident_id: p.incident_id,
    status: p.status,
    title: p.title,
    summary: p.summary,
    root_cause: p.root_cause,
    impact_description: p.impact_description,
    resolution: p.resolution,
    body_md: p.body_md,
    action_items: p.action_items,
    timeline_source: p.timeline_source,
    timeline_custom: p.timeline_custom,
    published_at: p.published_at,
    // A boolean out, a "YES"/"NO" string in the column. The column keeps the
    // inherited convention every other flag in this schema uses; the API does
    // not have to inherit it.
    notify_subscribers: p.notify_subscribers === "YES",
  };
}

export interface SerializeOptions {
  /** Include the comment timeline. One extra query per incident. */
  comments?: boolean;
  /** Include the computed durations. Costs a sample walk per incident. */
  durations?: boolean;
  /** Include the postmortem, draft included. Callers here are already authenticated. */
  postmortem?: boolean;
}

/**
 * One incident, as v5 describes it.
 *
 * The expensive parts are opt-in rather than always present, because a list of a
 * hundred incidents that each walked a day of samples would be a list nobody
 * could load. The detail route asks for everything; the list route asks for
 * nothing beyond the components.
 */
export async function serializeIncident(
  incident: Omit<IncidentRecord, "incident_source"> | IncidentRecord,
  options: SerializeOptions = {},
): Promise<V5Incident> {
  const monitors = await db.getIncidentMonitorsByIncidentID(incident.id);

  const result: V5Incident = {
    id: incident.id,
    title: incident.title,
    status: incident.status,
    state: incident.state,
    severity: incident.severity,
    incident_type: incident.incident_type,
    is_global: incident.is_global === "YES",
    impact_override: incident.impact_override,
    start_date_time: incident.start_date_time,
    end_date_time: incident.end_date_time,
    timeline: {
      detected_at: incident.detected_at,
      acknowledged_at: incident.acknowledged_at,
      identified_at: incident.identified_at,
      mitigated_at: incident.mitigated_at,
      resolved_at: incident.resolved_at,
    },
    components: monitors.map((m) => ({
      monitor_tag: m.monitor_tag,
      component_impact: m.component_impact ?? null,
      monitor_impact: m.monitor_impact ?? null,
    })),
  };

  if (options.comments) {
    const comments = await db.getIncidentComments(incident.id);
    result.comments = comments.map((c) => ({
      id: c.id,
      comment: c.comment,
      state: c.state,
      commented_at: c.commented_at,
      status: c.status,
    }));
  }

  if (options.durations) {
    result.durations = await computeIncidentDurations(
      incident,
      monitors.map((m) => m.monitor_tag),
    );
  }

  if (options.postmortem) {
    const row = await db.getPostmortemByIncidentId(incident.id);
    result.postmortem = row ? serializePostmortem(row) : null;
  }

  return result;
}

/** A JSON error in the shape v4 already uses, so a client handling one handles both. */
export function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
