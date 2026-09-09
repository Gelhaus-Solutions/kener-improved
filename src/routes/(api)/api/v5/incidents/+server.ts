import { json, type RequestHandler } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import { CreateIncident, AddIncidentComment, AddIncidentMonitor } from "$lib/server/controllers/controller.js";
import { serializeIncident, apiError } from "$lib/server/api/v5/incidents.js";
import { isIncidentSeverity } from "$lib/server/incidents/impact.js";
import { BackfillIncident, ValidateBackfill } from "$lib/server/incidents/backfill.js";

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
  /**
   * C7. Records an incident that already ended, notifying nobody and writing the
   * historical timeline into `monitoring_data`.
   *
   * An explicit flag rather than something inferred from `end_date_time` being in
   * the past, and the difference matters: inferring it would mean a client that
   * mistyped a year silently created a suppressed historical incident instead of
   * being told the end time was wrong.
   */
  backfill?: boolean;
  /** Backfill only. Set false to record the incident without touching the bars. */
  write_timeline?: boolean;
  detected_at?: number | null;
  acknowledged_at?: number | null;
  identified_at?: number | null;
  mitigated_at?: number | null;
  resolved_at?: number | null;
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

  // ---- C7: the backfill path ---------------------------------------------
  //
  // Its own branch rather than flags threaded through the ordinary one, because
  // almost everything differs: it is created closed, it suppresses every event
  // it emits, it validates a window and a row count, and it enqueues an overlay
  // write. What it does *not* do is write anything itself - `BackfillIncident`
  // calls the same controller functions this route does.
  if (body.backfill === true) {
    if (body.end_date_time === undefined || body.end_date_time === null) {
      return json(apiError("BAD_REQUEST", "A backfilled incident needs an end_date_time"), { status: 400 });
    }

    const input = {
      title: body.title,
      start_date_time: Number(body.start_date_time),
      end_date_time: Number(body.end_date_time),
      severity: body.severity,
      write_timeline: body.write_timeline,
      detected_at: body.detected_at ?? null,
      acknowledged_at: body.acknowledged_at ?? null,
      identified_at: body.identified_at ?? null,
      mitigated_at: body.mitigated_at ?? null,
      resolved_at: body.resolved_at ?? null,
      components: (body.components ?? [])
        .filter((c): c is { monitor_tag: string; component_impact?: string } => !!c.monitor_tag)
        .map((c) => ({ monitor_tag: c.monitor_tag, component_impact: c.component_impact ?? "MAJOR_OUTAGE" })),
      comments: (body.comments ?? [])
        .filter((c): c is { comment: string; state?: string; commented_at?: number } => !!c.comment)
        .map((c) => ({ comment: c.comment, state: c.state, commented_at: c.commented_at })),
    };

    // Validated before anything is written, and every problem is returned at
    // once. An importer sending fifty rows should learn about all of them in one
    // response rather than one per round trip.
    const problems = await ValidateBackfill(input);
    if (problems.length > 0) {
      return json(apiError("BAD_REQUEST", problems.join("; ")), { status: 400 });
    }

    const result = await BackfillIncident(input);
    const row = await db.getIncidentById(result.incident_id);
    if (!row) return json(apiError("NOT_FOUND", "Incident vanished after creation"), { status: 500 });

    return json(
      {
        incident: await serializeIncident(row, { comments: true }),
        backfill: { overlay_rows: result.overlay_rows, timeline_queued: result.timeline_queued },
      },
      { status: 201 },
    );
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

  // **No end time is applied here, and an earlier draft of this route got that
  // wrong.** `CreateIncident` clamps an INCIDENT-typed row's end time to null,
  // because a live incident closes by being resolved. Re-applying the caller's
  // end time afterwards through `UpdateIncident` defeated the clamp and produced
  // an incident with an end time while its state still said INVESTIGATING - a row
  // that is simultaneously over and unresolved, which no reader can render
  // sensibly. A caller who wants a closed incident either posts a RESOLVED
  // comment or, for history, sets `backfill: true` above.

  const row = await db.getIncidentById(created.incident_id);
  if (!row) return json(apiError("NOT_FOUND", "Incident vanished after creation"), { status: 500 });

  return json({ incident: await serializeIncident(row, { comments: true }) }, { status: 201 });
};
