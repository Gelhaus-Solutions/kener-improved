import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import {
  GetIncidentById,
  GetIncidentCommentsByIncidentId,
  GetAffectedMonitorsByIncidentId,
} from "$lib/server/controllers/dashboardController.js";
import { GetPublishedPostmortem } from "$lib/server/incidents/postmortem.js";

export const load: PageServerLoad = async ({ params }) => {
  const { incident_id } = params;
  const incidentIdNum = Number(incident_id);
  if (isNaN(incidentIdNum)) {
    throw error(400, { message: "Invalid incident ID" });
  }

  // Fetch incident details
  const incident = await GetIncidentById(incidentIdNum);
  if (!incident) {
    throw error(404, { message: "Incident not found" });
  }
  // Fetch incident comments
  const comments = await GetIncidentCommentsByIncidentId(incidentIdNum);

  // Fetch affected monitors
  const affectedMonitors = await GetAffectedMonitorsByIncidentId(incidentIdNum);

  // C1. `GetPublishedPostmortem` rather than the draft-inclusive reader, and the
  // two are separate functions rather than one with a flag precisely so that this
  // line cannot accidentally publish a draft somebody is still writing.
  const postmortem = await GetPublishedPostmortem(incidentIdNum);

  return {
    ...{ incident, comments, affectedMonitors, postmortem },
  };
};
