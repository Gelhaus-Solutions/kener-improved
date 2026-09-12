import GC from "../../global-constants.js";

// The one-way projection between the two impact layers.
//
// There are two vocabularies for "how bad is this", they are not the same
// question, and this module is the only place that is allowed to know how one
// becomes the other.
//
//   monitor_impact     mechanical. What the monitor's timeline shows for this
//                      window: DOWN | DEGRADED | MAINTENANCE. Drives the
//                      synthetic monitoring_data rows, the 90-day bars, the
//                      uptime percentages and alert evaluation.
//
//   component_impact   communication. What a customer reads: OPERATIONAL |
//                      DEGRADED_PERFORMANCE | PARTIAL_OUTAGE | MAJOR_OUTAGE |
//                      UNDER_MAINTENANCE.
//
// **Users only ever set `component_impact`.** `monitor_impact` is derived here on
// write and is never edited directly again. That direction is deliberate and the
// reverse is not supported for live writes: the projection is lossy, because
// DEGRADED_PERFORMANCE and PARTIAL_OUTAGE both mean DEGRADED to a timeline that
// has exactly one word for "not right". Deriving communication *from* mechanics
// would have to guess which, and guessing wrong in the customer-facing direction
// is the expensive mistake. `componentImpactFromMonitorImpact` exists only for
// the migration backfill, where there is no better information to be had.
//
// Why a projection at all, rather than one widened column: keeping
// `monitor_impact` at exactly three values means `monitorExecuteQueue` - the
// overlay merge, the confirmation-threshold freeze gate, ninety days of stored
// history - is not touched. A fourth or fifth value there would have to be taught
// to every one of those, and the freeze gate is not a thing to teach a new state
// casually.

/** The communication vocabulary, worst last. */
export const COMPONENT_IMPACTS = [
  "OPERATIONAL",
  "UNDER_MAINTENANCE",
  "DEGRADED_PERFORMANCE",
  "PARTIAL_OUTAGE",
  "MAJOR_OUTAGE",
] as const;

export type ComponentImpact = (typeof COMPONENT_IMPACTS)[number];

/**
 * Severity order, and it is **not** the array order above.
 *
 * The array is written worst-last for reading; this is the precedence used to
 * pick a winner, and it follows ADR 0007 exactly: a problem outranks maintenance,
 * and maintenance outranks healthy. A maintenance window must never mask a real
 * failure that happened to overlap it, and a window that passed cleanly must
 * still read as maintenance rather than disappearing into OPERATIONAL.
 */
const IMPACT_RANK: Record<ComponentImpact, number> = {
  OPERATIONAL: 0,
  UNDER_MAINTENANCE: 1,
  DEGRADED_PERFORMANCE: 2,
  PARTIAL_OUTAGE: 3,
  MAJOR_OUTAGE: 4,
};

export function isComponentImpact(value: unknown): value is ComponentImpact {
  return typeof value === "string" && (COMPONENT_IMPACTS as readonly string[]).includes(value);
}

/**
 * The mechanical value this communication value projects onto.
 *
 * **Returns null for OPERATIONAL, and that null is load-bearing.** It means "write
 * no overlay row at all", not "write an UP row": the overlay merge in
 * `monitorExecuteQueue` layers incident and maintenance status *over* realtime
 * data, so an OPERATIONAL component must leave the realtime status showing
 * through. Writing UP would assert health the monitor has not actually reported,
 * which is the one thing ADR 0007 says a status page must never do.
 */
export function monitorImpactFor(impact: ComponentImpact): string | null {
  switch (impact) {
    case "OPERATIONAL":
      return null;
    case "DEGRADED_PERFORMANCE":
    case "PARTIAL_OUTAGE":
      return GC.DEGRADED;
    case "MAJOR_OUTAGE":
      return GC.DOWN;
    case "UNDER_MAINTENANCE":
      return GC.MAINTENANCE;
  }
}

/**
 * The live direction: what a monitor's *current* observed status communicates.
 *
 * **Separate from the backfill below, and the difference is one word on a public
 * page.** DEGRADED resolves to `DEGRADED_PERFORMANCE` here, not `PARTIAL_OUTAGE`,
 * because there is nothing to infer: the monitor is reporting slowness right
 * now, and "Partial System Outage" tells a customer something is down when
 * nothing is. That was reaching the public page - a monitor answering in 1.34s
 * announced an outage, and through C3's rollup it announced one on every parent
 * that depends on it.
 *
 * Safe to change because `monitorImpactFor` projects `DEGRADED_PERFORMANCE` and
 * `PARTIAL_OUTAGE` onto the same `GC.DEGRADED`: no bar, no count, no collapse and
 * no page status moves. Only the wording does.
 *
 * The backfill keeps the weaker claim, for the reason stated on it.
 */
export function liveComponentImpactFor(monitorStatus: string | null | undefined): ComponentImpact {
  switch (monitorStatus) {
    case GC.DOWN:
      return "MAJOR_OUTAGE";
    case GC.DEGRADED:
      return "DEGRADED_PERFORMANCE";
    case GC.MAINTENANCE:
      return "UNDER_MAINTENANCE";
    default:
      return "OPERATIONAL";
  }
}

/**
 * The backfill direction. For the migration and for rows written before C2.
 *
 * DEGRADED resolves to PARTIAL_OUTAGE rather than DEGRADED_PERFORMANCE because it
 * is the weaker claim: "part of this was affected" rather than "all of this was
 * slow". For an incident nobody can go back and reassess, the weaker claim is the
 * honest one.
 */
export function componentImpactFromMonitorImpact(monitorImpact: string | null | undefined): ComponentImpact {
  switch (monitorImpact) {
    case GC.DOWN:
      return "MAJOR_OUTAGE";
    case GC.DEGRADED:
      return "PARTIAL_OUTAGE";
    case GC.MAINTENANCE:
      return "UNDER_MAINTENANCE";
    default:
      return "OPERATIONAL";
  }
}

/**
 * The worst of a set, or OPERATIONAL for an empty one.
 *
 * Note the difference from ADR 0007's `CollapseStatusCounts`, which returns
 * NO_DATA for an empty bucket. That function collapses *observations*, where
 * emptiness means the monitor stopped reporting and must be surfaced. This one
 * collapses *declarations*, where emptiness means nobody has declared a problem -
 * which is genuinely operational, not unknown.
 */
export function worstComponentImpact(impacts: Iterable<ComponentImpact>): ComponentImpact {
  let worst: ComponentImpact = "OPERATIONAL";
  for (const impact of impacts) {
    if (IMPACT_RANK[impact] > IMPACT_RANK[worst]) worst = impact;
  }
  return worst;
}

/** True when `a` is worse than `b`. */
export function isWorseImpact(a: ComponentImpact, b: ComponentImpact): boolean {
  return IMPACT_RANK[a] > IMPACT_RANK[b];
}

// ---------------------------------------------------------------- severity

/** Incident severity, worst last. About customer impact, not about the rule. */
export const INCIDENT_SEVERITIES = ["NONE", "MAINTENANCE", "MINOR", "MAJOR", "CRITICAL"] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export function isIncidentSeverity(value: unknown): value is IncidentSeverity {
  return typeof value === "string" && (INCIDENT_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Alert severity to incident severity, for an incident opened by the alerting
 * queue.
 *
 * **The two vocabularies stay separate on purpose.** `monitor_alerts_config.severity`
 * is CRITICAL|WARNING and describes how serious the *rule* considers itself;
 * `incidents.severity` describes how serious the *outage* is for customers. They
 * correlate and they are not the same, and unifying them is a one-way door: once
 * one column means both, there is no way left to say "a critical rule caught a
 * minor problem". So this is a mapping at the boundary, applied once when an
 * alert opens an incident, and an operator is free to change it afterwards.
 *
 * CRITICAL maps to MAJOR rather than CRITICAL because a rule firing is evidence
 * of an outage, not an assessment of its blast radius. Reserving CRITICAL for a
 * human keeps it meaning something.
 */
export function incidentSeverityFromAlertSeverity(alertSeverity: string | null | undefined): IncidentSeverity {
  return alertSeverity === "CRITICAL" ? "MAJOR" : "MINOR";
}
