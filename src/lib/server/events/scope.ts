import db from "../db/db.js";
import type { OutboxEvent } from "./types.js";

/**
 * E11 part 3. Which monitors and pages an event is about.
 *
 * **The whole design rests on one distinction, and it is the trap the item
 * warned about.** There are two different reasons an event yields no monitor:
 *
 *   - The event kind HAS no monitor dimension. `page.status_changed` is about a
 *     page, `probe.connected` about an agent, `report.delivered` about neither.
 *   - The event kind has one and this instance of it resolved to nothing. A
 *     global incident declared against no components is the case.
 *
 * Both return `null` here, and that is deliberate rather than sloppy: the rule
 * is that **a scope narrows what it can judge and abstains on what it cannot**.
 * An operator who scopes an endpoint to two services has said which services
 * they care about, not which kinds of event exist, so a page status change still
 * arrives. Silently withholding those would be the bug nobody reports, because
 * nothing arrives to report.
 *
 * So `null` means "do not filter this event" and an array means "filter it
 * against exactly these". A caller must not collapse the two into `[]`.
 *
 * **Dispatch is on `event.aggregate_type`, the stored column, not on the type
 * string.** That is what `serializeAggregate` switches on, the admin events
 * disagree with their own prefixes, and reading the column keeps this agreeing
 * with the serializers by construction rather than by a second transcription.
 *
 * Note `aggregate_id` is not uniformly numeric: for a monitor it IS the tag.
 */

/** What an event is about, for scoping. `null` means the scope must abstain. */
export interface EventScopeSubject {
  monitorTags: string[] | null;
  pageSlugs: string[] | null;
}

const ABSTAIN: EventScopeSubject = { monitorTags: null, pageSlugs: null };

/** An array only when it has something in it; otherwise abstain. See above. */
function orAbstain(values: (string | null | undefined)[]): string[] | null {
  const present = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  return present.length > 0 ? present : null;
}

/** The monitors an incident declares as components. */
async function incidentMonitors(incidentId: number): Promise<string[] | null> {
  const monitors = await db.getIncidentMonitorsByIncidentID(incidentId);
  return orAbstain(monitors.map((m) => m.monitor_tag));
}

/**
 * Resolves the monitors and pages an event concerns.
 *
 * One indexed read per event at worst, and none at all for the kinds that
 * abstain, which is most of the administrative traffic.
 */
export async function resolveEventScopeSubject(event: OutboxEvent): Promise<EventScopeSubject> {
  const id = event.aggregate_id;
  if (!id) return ABSTAIN;

  switch (event.aggregate_type) {
    // The monitor aggregate is keyed by TAG, not by a numeric id. See
    // `serializeMonitor`, which takes the same value straight to
    // `getMonitorByTag`.
    case "monitor":
      return { monitorTags: orAbstain([id]), pageSlugs: null };

    case "monitor_alert": {
      const alert = await db.getMonitorAlertV2ById(Number(id));
      return { monitorTags: orAbstain([alert?.monitor_tag]), pageSlugs: null };
    }

    case "incident":
      return { monitorTags: await incidentMonitors(Number(id)), pageSlugs: null };

    case "postmortem": {
      // A postmortem is its incident's published account of itself, so it scopes
      // exactly as that incident does.
      const postmortem = await db.getPostmortemById(Number(id));
      if (!postmortem?.incident_id) return ABSTAIN;
      return { monitorTags: await incidentMonitors(postmortem.incident_id), pageSlugs: null };
    }

    case "maintenance": {
      const monitors = await db.getMaintenanceMonitors(Number(id));
      return { monitorTags: orAbstain(monitors.map((m) => m.monitor_tag)), pageSlugs: null };
    }

    case "maintenance_event": {
      // An occurrence. Its monitors are the parent window's.
      const occurrence = await db.getMaintenanceEventById(Number(id));
      if (!occurrence?.maintenance_id) return ABSTAIN;
      const monitors = await db.getMaintenanceMonitors(occurrence.maintenance_id);
      return { monitorTags: orAbstain(monitors.map((m) => m.monitor_tag)), pageSlugs: null };
    }

    case "page": {
      // `page_path` is the page's stable public identity; there is no `slug`.
      const page = await db.getPageById(Number(id));
      return { monitorTags: null, pageSlugs: orAbstain([page?.page_path]) };
    }

    // Everything else - probes, reports, triggers, subscribers, and every
    // administrative aggregate - has no monitor or page dimension at all.
    default:
      return ABSTAIN;
  }
}

/** One endpoint's configured scope, as the relay reads it. */
export interface EndpointScope {
  monitorTags: string[];
  pageSlugs: string[];
}

type Decision = "match" | "miss" | "abstain";

function decide(scopeValues: string[], subjectValues: string[] | null): Decision {
  if (scopeValues.length === 0) return "abstain";
  if (subjectValues === null) return "abstain";
  return subjectValues.some((value) => scopeValues.includes(value)) ? "match" : "miss";
}

/**
 * Whether an endpoint scoped this way should receive this event.
 *
 * **Read the cases in order, because each one is a decision.**
 *
 *  1. An endpoint with no scope at all does not filter. An unscoped endpoint
 *     behaves exactly as it did before E11 part 3, which is what keeps this
 *     change free of a behaviour change for everybody who never sets a scope.
 *  2. An event that cannot be judged by any configured kind is delivered. This
 *     is the rule above, and the reason `null` is carried all the way here
 *     rather than flattened into an empty array earlier.
 *  3. Otherwise the event must overlap the scope on at least one kind.
 *
 * The two kinds are ORed rather than ANDed: an endpoint scoped to a monitor and
 * a page wants events about either, not events somehow about both. An AND would
 * make every mixed scope deliver nothing, because no event carries a monitor and
 * a page at once.
 */
export function endpointAcceptsEvent(scope: EndpointScope, subject: EventScopeSubject): boolean {
  const monitorDecision = decide(scope.monitorTags, subject.monitorTags);
  const pageDecision = decide(scope.pageSlugs, subject.pageSlugs);

  // Cases 1 and 2 together: nothing configured could judge this event.
  if (monitorDecision === "abstain" && pageDecision === "abstain") return true;

  return monitorDecision === "match" || pageDecision === "match";
}
