import { json, type RequestHandler } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import type {
  GetIncidentResponse,
  UpdateIncidentRequest,
  UpdateIncidentResponse,
  DeleteIncidentResponse,
  IncidentDetailResponse,
  BadRequestResponse,
} from "$lib/types/api";
import { GetMinuteStartTimestampUTC, parseDbTimestamp } from "$lib/server/tool";
import { GetSiteURL } from "$lib/server/controllers/siteDataController";
import {
  AddIncidentMonitor,
  ClearIncidentEndTime,
  DeleteIncident,
  RemoveIncidentMonitor,
  UpdateIncident,
} from "$lib/server/controllers/incidentController";
import serverResolver from "$lib/server/resolver";
import GC from "$lib/global-constants";

const VALID_IMPACTS: string[] = [GC.DOWN, GC.DEGRADED, GC.MAINTENANCE];

async function buildIncidentResponse(incidentId: number): Promise<IncidentDetailResponse | null> {
  const incident = await db.getIncidentById(incidentId);
  if (!incident) return null;

  const monitors = await db.getIncidentMonitorsByIncidentID(incidentId);

  // Get full incident record for incident_source
  const fullIncident = await db.getIncidentsPaginated(1, 1, { id: incidentId });
  const incidentSource = fullIncident.length > 0 ? fullIncident[0].incident_source : "MANUAL";

  return {
    id: incident.id,
    title: incident.title,
    start_date_time: incident.start_date_time,
    end_date_time: incident.end_date_time,
    state: incident.state,
    incident_type: incident.incident_type,
    incident_source: incidentSource,
    monitors: monitors.map((m) => ({
      monitor_tag: m.monitor_tag,
      impact: m.monitor_impact || "DOWN",
    })),
    created_at: parseDbTimestamp(incident.created_at).toISOString(),
    updated_at: parseDbTimestamp(incident.updated_at).toISOString(),
    url: (await GetSiteURL()) + serverResolver(`/incidents/${incident.id}`),
  };
}

export const GET: RequestHandler = async ({ locals }) => {
  // Incident is validated by middleware and available in locals
  const incident = locals.incident!;

  const incidentResponse = await buildIncidentResponse(incident.id);

  if (!incidentResponse) {
    return json({ error: { code: "INTERNAL_ERROR", message: "Failed to build incident response" } }, { status: 500 });
  }

  const response: GetIncidentResponse = {
    incident: incidentResponse,
  };

  return json(response);
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
  // Incident is validated by middleware and available in locals
  const existingIncident = locals.incident!;

  let body: UpdateIncidentRequest;

  try {
    body = await request.json();
  } catch {
    const errorResponse: BadRequestResponse = {
      error: {
        code: "BAD_REQUEST",
        message: "Invalid JSON body",
      },
    };
    return json(errorResponse, { status: 400 });
  }

  // Validate monitors if provided
  if (body.monitors !== undefined) {
    if (!Array.isArray(body.monitors)) {
      const errorResponse: BadRequestResponse = {
        error: {
          code: "BAD_REQUEST",
          message: "monitors must be an array",
        },
      };
      return json(errorResponse, { status: 400 });
    }

    for (const monitor of body.monitors) {
      if (!monitor.monitor_tag || typeof monitor.monitor_tag !== "string") {
        const errorResponse: BadRequestResponse = {
          error: {
            code: "BAD_REQUEST",
            message: "Each monitor must have a valid monitor_tag",
          },
        };
        return json(errorResponse, { status: 400 });
      }

      // Verify monitor exists
      const existingMonitor = await db.getMonitorByTag(monitor.monitor_tag);
      if (!existingMonitor) {
        const errorResponse: BadRequestResponse = {
          error: {
            code: "BAD_REQUEST",
            message: `Monitor with tag '${monitor.monitor_tag}' not found`,
          },
        };
        return json(errorResponse, { status: 400 });
      }

      if (monitor.impact && !VALID_IMPACTS.includes(monitor.impact)) {
        const errorResponse: BadRequestResponse = {
          error: {
            code: "BAD_REQUEST",
            message: `Invalid impact '${monitor.impact}'. Must be one of: ${VALID_IMPACTS.join(", ")}`,
          },
        };
        return json(errorResponse, { status: 400 });
      }
    }
  }

<<<<<<< HEAD
  // Build update data - only include fields that are present in the request
  const updateData = {
    id: existingIncident.id,
    title: body.title !== undefined ? body.title : existingIncident.title,
    start_date_time:
      body.start_date_time !== undefined
        ? GetMinuteStartTimestampUTC(body.start_date_time)
        : existingIncident.start_date_time,
    end_date_time:
      body.end_date_time !== undefined
        ? body.end_date_time !== null
          ? GetMinuteStartTimestampUTC(body.end_date_time)
          : null
        : existingIncident.end_date_time,
    status: existingIncident.status,
    state: existingIncident.state,
    // These fields are required by IncidentRecord but not used by updateIncident
    created_at: existingIncident.created_at,
    updated_at: existingIncident.updated_at,
    incident_type: existingIncident.incident_type,
    incident_source: "", // Not used by updateIncident
    is_global: existingIncident.is_global,
    // Carried through unchanged. This endpoint does not edit them, and rebuilding
    // the record without them would write the column defaults over an operator's
    // severity every time somebody renamed an incident over the API.
    severity: existingIncident.severity,
    severity_changed_at: existingIncident.severity_changed_at,
    impact_override: existingIncident.impact_override,
    suppress_notifications: existingIncident.suppress_notifications,
    template_id: existingIncident.template_id,
    // C2c, carried for the same reason: this endpoint writes a whole record, so
    // a column it omits is a column it erases. Note that it also bypasses
    // `UpdateIncident`, so a v4 state change stamps no lifecycle timestamp and
    // emits nothing. That is inherited behaviour and v5 is where it is fixed;
    // v4 stays byte-compatible with what its callers already get.
    detected_at: existingIncident.detected_at,
    acknowledged_at: existingIncident.acknowledged_at,
    acknowledged_by_user_id: existingIncident.acknowledged_by_user_id,
    identified_at: existingIncident.identified_at,
    mitigated_at: existingIncident.mitigated_at,
    resolved_at: existingIncident.resolved_at,
  };
=======
  try {
    if (body.end_date_time === null) {
      await ClearIncidentEndTime(existingIncident.id);
    }
    await UpdateIncident(existingIncident.id, {
      title: body.title,
      start_date_time:
        body.start_date_time !== undefined ? GetMinuteStartTimestampUTC(body.start_date_time) : undefined,
      end_date_time: body.end_date_time ? GetMinuteStartTimestampUTC(body.end_date_time) : undefined,
    });
  } catch (err) {
    const errorResponse: BadRequestResponse = {
      error: {
        code: "BAD_REQUEST",
        message: err instanceof Error ? err.message : "Failed to update incident",
      },
    };
    return json(errorResponse, { status: 400 });
  }
>>>>>>> a91998781f15812adc6422ed05b0580b6f38d3b5

  if (body.monitors !== undefined) {
    const newMonitorTags = body.monitors.map((m) => m.monitor_tag);
    for (const current of await db.getIncidentMonitorsByIncidentID(existingIncident.id)) {
      if (!newMonitorTags.includes(current.monitor_tag)) {
        await RemoveIncidentMonitor(existingIncident.id, current.monitor_tag);
      }
    }
    for (const monitor of body.monitors) {
      await AddIncidentMonitor(existingIncident.id, monitor.monitor_tag, monitor.impact || "DOWN");
    }
  }

  // Fetch updated incident for response
  const incidentResponse = await buildIncidentResponse(existingIncident.id);

  if (!incidentResponse) {
    return json({ error: { code: "INTERNAL_ERROR", message: "Failed to build incident response" } }, { status: 500 });
  }

  const response: UpdateIncidentResponse = {
    incident: incidentResponse,
  };

  return json(response);
};

export const DELETE: RequestHandler = async ({ locals }) => {
  // Incident is validated by middleware and available in locals
  const incident = locals.incident!;

  await DeleteIncident(incident.id);

  const response: DeleteIncidentResponse = {
    message: `Incident with id '${incident.id}' deleted successfully`,
  };

  return json(response);
};
