import { json, type RequestHandler } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import { UpdateIncident, DeleteIncident } from "$lib/server/controllers/controller.js";
import { serializeIncident, apiError } from "$lib/server/api/v5/incidents.js";
import { isIncidentSeverity, isComponentImpact } from "$lib/server/incidents/impact.js";

/**
 * One incident.
 *
 * `locals.incident` is already resolved by `apiAuthHandle`, which 404s an id
 * that does not exist before this handler runs. It is re-read here rather than
 * used directly because the hook's copy predates any write this request makes.
 */
export const GET: RequestHandler = async ({ params }) => {
  const row = await db.getIncidentById(Number(params.incident_id));
  if (!row) return json(apiError("NOT_FOUND", "Incident not found"), { status: 404 });
  return json({ incident: await serializeIncident(row, { comments: true, durations: true, postmortem: true }) });
};

interface PatchBody {
  title?: string;
  start_date_time?: number;
  end_date_time?: number | null;
  status?: string;
  state?: string;
  severity?: string;
  is_global?: boolean;
  impact_override?: string | null;
  /** When the transition being recorded actually happened. Defaults to now. */
  transition_at?: number;
}

export const PATCH: RequestHandler = async ({ params, request }) => {
  const incidentId = Number(params.incident_id);

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return json(apiError("BAD_REQUEST", "Invalid JSON body"), { status: 400 });
  }

  if (body.severity !== undefined && !isIncidentSeverity(body.severity)) {
    return json(apiError("BAD_REQUEST", "severity is not a recognised value"), { status: 400 });
  }
  if (body.impact_override !== undefined && body.impact_override !== null && !isComponentImpact(body.impact_override)) {
    return json(apiError("BAD_REQUEST", "impact_override is not a recognised value"), { status: 400 });
  }

  try {
    // Through the controller, so the C2c lifecycle stamps land and every
    // `incident.*` event fires. This is the single behavioural difference from
    // v4's PATCH, and it is the reason for the version.
    await UpdateIncident(incidentId, {
      title: body.title,
      start_date_time: body.start_date_time,
      end_date_time: body.end_date_time,
      status: body.status,
      state: body.state,
      severity: body.severity,
      is_global: body.is_global === undefined ? undefined : body.is_global ? "YES" : "NO",
      impact_override: body.impact_override,
      transition_at: body.transition_at,
    });
  } catch (e) {
    return json(apiError("BAD_REQUEST", e instanceof Error ? e.message : "Could not update the incident"), {
      status: 400,
    });
  }

  const row = await db.getIncidentById(incidentId);
  if (!row) return json(apiError("NOT_FOUND", "Incident not found"), { status: 404 });
  return json({ incident: await serializeIncident(row, { comments: true, durations: true, postmortem: true }) });
};

export const DELETE: RequestHandler = async ({ params }) => {
  try {
    await DeleteIncident(Number(params.incident_id));
  } catch (e) {
    return json(apiError("BAD_REQUEST", e instanceof Error ? e.message : "Could not delete the incident"), {
      status: 400,
    });
  }
  return new Response(null, { status: 204 });
};
