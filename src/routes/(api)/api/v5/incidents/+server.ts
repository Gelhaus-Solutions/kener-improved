import { json, type RequestHandler } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import {
  CreateIncident,
  UpdateIncident,
  AddIncidentComment,
  AddIncidentMonitor,
} from "$lib/server/controllers/controller.js";
import { serializeIncident, apiError } from "$lib/server/api/v5/incidents.js";
import { isIncidentSeverity } from "$lib/server/incidents/impact.js";

/**
 * v5 incidents.
 *
 * Everything here goes through the controller, which is the whole reason v5
 * exists: v4's write paths call the repository directly and therefore emit no
 * events and stamp no lifecycle timestamps. See `$lib/server/api/v5/incidents.ts`.
 */

const MAX_LIMIT = 200;

export const GET: RequestHandler = async ({ url }) => {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));

  const filter: { start?: number; end?: number; status?: string; state?: string } = {};
  const start = Number(url.searchParams.get("start_ts"));
  const end = Number(url.searchParams.get("end_ts"));
  if (Number.isFinite(start) && start > 0) filter.start = start;
  if (Number.isFinite(end) && end > 0) filter.end = end;
  const status = url.searchParams.get("status");
  if (status) filter.status = status;
  const state = url.searchParams.get("state");
  if (state) filter.state = state;

  const rows = await db.getIncidentsPaginated(page, limit, Object.keys(filter).length > 0 ? filter : null);
  const incidents = await Promise.all(rows.map((row) => serializeIncident(row)));

  return json({ incidents, page, limit });
};

interface CreateBody {
  title?: string;
  start_date_time?: number;
  end_date_time?: number | null;
  state?: string;
  status?: string;
  severity?: string;
  incident_type?: string;
  is_global?: boolean;
  impact_override?: string | null;
  components?: Array<{ monitor_tag?: string; component_impact?: string; monitor_impact?: string }>;
  comments?: Array<{ comment?: string; state?: string; commented_at?: number }>;
}

export const POST: RequestHandler = async ({ request }) => {
  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return json(apiError("BAD_REQUEST", "Invalid JSON body"), { status: 400 });
  }

  if (!body.title || typeof body.title !== "string") {
    return json(apiError("BAD_REQUEST", "title is required"), { status: 400 });
  }
  if (!Number.isFinite(body.start_date_time)) {
    return json(apiError("BAD_REQUEST", "start_date_time is required, in UTC seconds"), { status: 400 });
  }
  if (body.severity !== undefined && !isIncidentSeverity(body.severity)) {
    return json(apiError("BAD_REQUEST", "severity is not a recognised value"), { status: 400 });
  }

  let created;
  try {
    created = await CreateIncident({
      title: body.title,
      start_date_time: Number(body.start_date_time),
      end_date_time: body.end_date_time ?? null,
      state: body.state,
      status: body.status,
      severity: body.severity,
      incident_type: body.incident_type,
      incident_source: "API",
      is_global: body.is_global === false ? "NO" : "YES",
      impact_override: body.impact_override ?? null,
    });
  } catch (e) {
    return json(apiError("BAD_REQUEST", e instanceof Error ? e.message : "Could not create the incident"), {
      status: 400,
    });
  }

  // Components before comments, and the order is load-bearing: posting a comment
  // notifies subscribers, and E1 resolves who those are from the incident's
  // attached components. Attaching them afterwards would mail the wrong people,
  // or nobody, for the first update of every incident opened through this route.
  for (const component of body.components ?? []) {
    if (!component.monitor_tag) continue;
    try {
      await AddIncidentMonitor(
        created.incident_id,
        component.monitor_tag,
        component.component_impact ?? component.monitor_impact ?? "MAJOR_OUTAGE",
      );
    } catch (e) {
      return json(apiError("BAD_REQUEST", e instanceof Error ? e.message : "Could not attach a component"), {
        status: 400,
      });
    }
  }

  for (const comment of body.comments ?? []) {
    if (!comment.comment) continue;
    await AddIncidentComment(
      created.incident_id,
      comment.comment,
      comment.state ?? body.state ?? "INVESTIGATING",
      Number(comment.commented_at ?? body.start_date_time),
    );
  }

  // An end time given on a closed incident has to be applied through
  // `UpdateIncident`: `CreateIncident` clamps it to null for an INCIDENT-typed
  // row, which is the inherited rule C7 will make an explicit exception to.
  if (body.end_date_time && body.incident_type !== "MAINTENANCE") {
    await UpdateIncident(created.incident_id, { end_date_time: body.end_date_time });
  }

  const row = await db.getIncidentById(created.incident_id);
  if (!row) return json(apiError("NOT_FOUND", "Incident vanished after creation"), { status: 500 });

  return json({ incident: await serializeIncident(row, { comments: true }) }, { status: 201 });
};
