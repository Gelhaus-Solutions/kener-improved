import db from "../db/db.js";
import GC from "../../global-constants.js";
import { CreateIncident, AddIncidentComment, AddIncidentMonitor } from "../controllers/incidentController.js";
import { isComponentImpact, monitorImpactFor, type ComponentImpact } from "./impact.js";
import backfillQueue from "../queues/backfillQueue.js";

/**
 * C7: recording an incident that happened before Kener was watching.
 *
 * The point is truthfulness. An instance stood up in June with an outage in
 * March shows a green March, and every uptime percentage and SLA report computed
 * over that window is wrong in the flattering direction. This writes the missing
 * history: the incident, its timeline, its components, and the `monitoring_data`
 * overlay without which none of it reaches the bars.
 *
 * **Three things make this different from creating an incident, and all three
 * are ways it could go badly wrong:**
 *
 *  1. **It must notify nobody.** A backfilled timeline is N comments, and
 *     `incident.comment_added` is the single event the subscribers consumer
 *     mails on. Six comments about last March would be six emails. Handled by
 *     `suppress_notifications` on the incident, which the controller turns into
 *     `suppress: true` on every event it emits, and by the explicit guard on the
 *     legacy notifier - which does not go through the bus and would otherwise
 *     keep sending on any install not yet flipped.
 *
 *  2. **It writes a lot of rows.** One `monitoring_data` row per monitor per
 *     minute: a week-long outage across three components is thirty thousand.
 *     Capped, and run as a job, so a request can never be the thing waiting for
 *     it.
 *
 *  3. **It creates a closed incident.** `CreateIncident` clamps an
 *     INCIDENT-typed row's end time to null, because live incidents close by
 *     being resolved. A historical one has no live timeline to resolve, so the
 *     clamp is skipped - explicitly, via `backfill: true`, and by nothing else.
 */

/**
 * The longest window one backfill may cover.
 *
 * Ninety days, matching the C7 item. At one row per minute per monitor that is
 * ~130k rows for a single component, which is already more than anyone should
 * write in one operation - and a window this long almost always means somebody
 * typed the wrong year rather than that a service was down for a quarter.
 */
export const MAX_BACKFILL_WINDOW_SECONDS = 90 * 24 * 60 * 60;

/**
 * The most `monitoring_data` rows one backfill may write.
 *
 * Counted across every component, because the cost is the product of the two:
 * ninety days is fine for one monitor and is 780k rows for six.
 */
export const MAX_BACKFILL_ROWS = 100_000;

export interface BackfillComponent {
  monitor_tag: string;
  component_impact: string;
}

export interface BackfillComment {
  comment: string;
  state?: string;
  commented_at?: number;
}

export interface BackfillInput {
  title: string;
  start_date_time: number;
  end_date_time: number;
  severity?: string;
  components?: BackfillComponent[];
  comments?: BackfillComment[];
  /**
   * Whether to write the `monitoring_data` overlay.
   *
   * On by default, because an incident that leaves no mark on the bars is the
   * problem this feature exists to fix. Off is for re-recording an outage whose
   * timeline Kener already captured correctly and which only needs the incident
   * written up.
   */
  write_timeline?: boolean;
  /** C2c, where the importer knows them. */
  detected_at?: number | null;
  acknowledged_at?: number | null;
  identified_at?: number | null;
  mitigated_at?: number | null;
  resolved_at?: number | null;
}

export interface BackfillResult {
  incident_id: number;
  /** Rows the overlay job will write. Zero when the timeline was not requested. */
  overlay_rows: number;
  /** Whether an overlay job was enqueued. */
  timeline_queued: boolean;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** How many `monitoring_data` rows this window costs across these components. */
export function estimateOverlayRows(start: number, end: number, components: BackfillComponent[]): number {
  const minutes = Math.floor((end - start) / 60) + 1;
  // Only components that project onto a real overlay status. OPERATIONAL means
  // no overlay row at all - see incidents/impact.ts - so a component declared
  // operational during an incident costs nothing and must not be counted, or the
  // cap would refuse an import that writes far less than it claims.
  const writing = components.filter((c) => monitorImpactFor(c.component_impact as ComponentImpact) !== null);
  return minutes * writing.length;
}

/**
 * Validates a backfill without writing anything.
 *
 * Separate from performing it so the importer can show every problem in a CSV at
 * once, rather than failing on row three and leaving the operator to discover
 * rows seven and nine one at a time.
 */
export async function ValidateBackfill(input: BackfillInput): Promise<string[]> {
  const problems: string[] = [];

  if (!input.title?.trim()) problems.push("A title is required");
  if (!Number.isFinite(input.start_date_time)) problems.push("start_date_time must be UTC seconds");
  if (!Number.isFinite(input.end_date_time)) problems.push("end_date_time must be UTC seconds");
  if (problems.length > 0) return problems;

  if (input.end_date_time < input.start_date_time) {
    problems.push("The incident cannot end before it began");
  }

  // In the past, and the check is on the *end*: an incident that started
  // yesterday and is still running is an ordinary open incident, and creating it
  // through this path would produce a closed one that notifies nobody about a
  // problem customers are having right now.
  if (input.end_date_time > nowSeconds()) {
    problems.push("A backfilled incident must have already ended");
  }

  const window = input.end_date_time - input.start_date_time;
  if (window > MAX_BACKFILL_WINDOW_SECONDS) {
    problems.push(
      `A backfill may cover at most ${MAX_BACKFILL_WINDOW_SECONDS / 86400} days; this one covers ${Math.round(window / 86400)}`,
    );
  }

  const components = input.components ?? [];
  for (const component of components) {
    if (!component.monitor_tag) {
      problems.push("A component needs a monitor tag");
      continue;
    }
    if (!isComponentImpact(component.component_impact)) {
      problems.push(`"${component.component_impact}" is not a component impact`);
    }
    const monitor = await db.getMonitorByTag(component.monitor_tag);
    if (!monitor) problems.push(`No monitor with tag "${component.monitor_tag}"`);
  }

  if (input.write_timeline !== false) {
    const rows = estimateOverlayRows(input.start_date_time, input.end_date_time, components);
    if (rows > MAX_BACKFILL_ROWS) {
      problems.push(
        `This would write ${rows.toLocaleString()} timeline rows, over the ${MAX_BACKFILL_ROWS.toLocaleString()} limit. Split it or narrow the components.`,
      );
    }
  }

  for (const comment of input.comments ?? []) {
    if (!comment.comment?.trim()) problems.push("A timeline entry needs text");
    const at = comment.commented_at;
    if (at !== undefined && (!Number.isFinite(at) || at < input.start_date_time || at > input.end_date_time)) {
      problems.push("A timeline entry must fall inside the incident's window");
    }
  }

  return problems;
}

/**
 * Records one historical incident.
 *
 * Everything here goes through the ordinary controller functions. There is no
 * insert in this file, and that is on purpose: backfill is a *caller* of the
 * incident API, not a second implementation of it, so it inherits every event,
 * every C2c timestamp and every future change for free.
 */
export async function BackfillIncident(input: BackfillInput): Promise<BackfillResult> {
  const problems = await ValidateBackfill(input);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const components = input.components ?? [];
  const comments = input.comments ?? [];

  const created = await CreateIncident({
    title: input.title.trim(),
    start_date_time: input.start_date_time,
    end_date_time: input.end_date_time,
    status: "OPEN",
    // Closed, because it is. A backfilled incident has no live timeline for
    // anyone to move through.
    state: GC.RESOLVED,
    incident_type: GC.INCIDENT,
    incident_source: "BACKFILL",
    is_global: components.length === 0 ? "YES" : "NO",
    severity: input.severity,
    suppress_notifications: "YES",
    backfill: true,
    detected_at: input.detected_at ?? null,
    acknowledged_at: input.acknowledged_at ?? null,
    identified_at: input.identified_at ?? null,
    mitigated_at: input.mitigated_at ?? null,
    // The resolution is known: it is when the outage ended.
    resolved_at: input.resolved_at ?? input.end_date_time,
  });

  for (const component of components) {
    await AddIncidentMonitor(created.incident_id, component.monitor_tag, component.component_impact);
  }

  // The timeline, as ordinary comments with historical timestamps. Oldest first,
  // so the stored order is the order it happened.
  const ordered = [...comments].sort(
    (a, b) => (a.commented_at ?? input.start_date_time) - (b.commented_at ?? input.start_date_time),
  );
  for (const comment of ordered) {
    await AddIncidentComment(
      created.incident_id,
      comment.comment.trim(),
      comment.state ?? GC.INVESTIGATING,
      comment.commented_at ?? input.start_date_time,
    );
  }

  // The last comment moved the incident's state, so put it back where a closed
  // historical incident belongs. Without this an import whose final entry is an
  // IDENTIFIED note leaves a resolved outage sitting in IDENTIFIED forever.
  const last = ordered[ordered.length - 1];
  if (last && last.state !== GC.RESOLVED) {
    await AddIncidentComment(created.incident_id, "Resolved.", GC.RESOLVED, input.end_date_time);
  }

  const overlayRows =
    input.write_timeline === false ? 0 : estimateOverlayRows(input.start_date_time, input.end_date_time, components);

  let queued = false;
  if (overlayRows > 0) {
    await backfillQueue.push({
      incident_id: created.incident_id,
      start: input.start_date_time,
      end: input.end_date_time,
      components: components.map((c) => ({
        monitor_tag: c.monitor_tag,
        component_impact: c.component_impact,
      })),
    });
    queued = true;
  }

  return { incident_id: created.incident_id, overlay_rows: overlayRows, timeline_queued: queued };
}
