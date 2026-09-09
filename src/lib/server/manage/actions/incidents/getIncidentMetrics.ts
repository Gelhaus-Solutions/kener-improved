import { GetIncidentByIDDashboard, GetIncidentMonitors } from "$lib/server/controllers/controller.js";
import { computeIncidentDurations } from "$lib/server/incidents/metrics.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  incident_id?: number | string;
  id?: number | string;
}

/**
 * C2c: the lifecycle timestamps and the durations derived from them.
 *
 * Its own action rather than more fields on `getIncident`, because the true
 * outage start costs a scan of up to a day of samples per attached monitor and
 * `getIncident` is called every time the editor repaints. A screen that wants the
 * numbers asks for them; every other caller pays nothing.
 */
export default {
  action: "getIncidentMetrics",
  permission: "incidents.read",
  handler: async (data: Payload) => {
    const incidentId = Number(data.incident_id ?? data.id);
    if (!Number.isInteger(incidentId) || incidentId <= 0) {
      throw new ActionError(400, "An incident id is required");
    }

    const incident = await GetIncidentByIDDashboard({ incident_id: incidentId });
    if (!incident) {
      throw new ActionError(404, "Incident not found");
    }

    const monitors = await GetIncidentMonitors(incidentId);
    const durations = await computeIncidentDurations(
      incident,
      monitors.map((m) => m.monitor_tag),
    );

    return {
      timestamps: {
        start_date_time: incident.start_date_time,
        end_date_time: incident.end_date_time,
        detected_at: incident.detected_at,
        acknowledged_at: incident.acknowledged_at,
        acknowledged_by_user_id: incident.acknowledged_by_user_id,
        identified_at: incident.identified_at,
        mitigated_at: incident.mitigated_at,
        resolved_at: incident.resolved_at,
      },
      durations,
    };
  },
} satisfies ActionDefinition<Payload>;
