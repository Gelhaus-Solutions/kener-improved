import type { NormalisedAlert } from "./types.js";
import { isComponentImpact, isIncidentSeverity, type ComponentImpact, type IncidentSeverity } from "../incidents/impact.js";

/**
 * H1. Which component an inbound alert is about, and how bad it is.
 *
 * **Pure, and separate from the receiver, because this is the part an operator
 * gets wrong.** A rule that silently matches nothing looks exactly like a rule
 * that matches, right up until an outage is announced against the wrong
 * component or against none. Keeping the decision in a function with no
 * database lets every combination be tested, and lets the screen show an
 * operator what their rules would do before an alert arrives.
 */

/** One rule: when this label equals this value, the alert is about this monitor. */
export interface MappingRule {
  label: string;
  equals: string;
  monitor_tag: string;
}

/**
 * Reads the rules an endpoint stored.
 *
 * Tolerant on purpose. The column is text holding JSON, so it can contain
 * anything a past version wrote or a hand-edited row carries, and a receiver
 * that throws on a malformed rule set would stop accepting alerts entirely.
 * A rule that cannot be understood is dropped, which degrades to the endpoint's
 * default rather than to silence.
 */
export function parseMappingRules(raw: unknown): MappingRule[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rules: MappingRule[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const rule = entry as Record<string, unknown>;
    const label = typeof rule.label === "string" ? rule.label.trim() : "";
    const equals = typeof rule.equals === "string" ? rule.equals.trim() : "";
    const monitorTag = typeof rule.monitor_tag === "string" ? rule.monitor_tag.trim() : "";
    if (!label || !equals || !monitorTag) continue;
    rules.push({ label, equals, monitor_tag: monitorTag });
  }
  return rules;
}

/**
 * The component this alert is about, or null when nothing claims it.
 *
 * **First match wins, in the order the operator wrote them.** Not "most
 * specific", which would need a specificity rule nobody can predict from looking
 * at the list. An ordered list is the one arrangement where the answer to "why
 * did this alert go there" is readable off the screen.
 *
 * Null is a real answer, not a failure: the alert is still recorded, and the
 * screen says it matched nothing. Guessing a component would put somebody else's
 * outage on a customer-facing page.
 */
export function resolveMonitorTag(
  alert: NormalisedAlert,
  rules: MappingRule[],
  defaultMonitorTag: string | null,
): string | null {
  for (const rule of rules) {
    if (alert.labels[rule.label] === rule.equals) return rule.monitor_tag;
  }
  return defaultMonitorTag && defaultMonitorTag.trim() !== "" ? defaultMonitorTag : null;
}

/**
 * How a provider's severity word maps onto Kener's incident severity.
 *
 * Every vendor spells this differently and several let the operator invent their
 * own words, so this recognises the common ones and falls back rather than
 * refusing. The fallback is MINOR rather than NONE: an alert somebody wired up
 * is by definition worth something, and NONE would publish an incident that
 * claims nothing is wrong.
 */
const SEVERITY_WORDS: Record<string, IncidentSeverity> = {
  critical: "CRITICAL",
  crit: "CRITICAL",
  fatal: "CRITICAL",
  emergency: "CRITICAL",
  p1: "CRITICAL",
  disaster: "CRITICAL",
  error: "MAJOR",
  major: "MAJOR",
  high: "MAJOR",
  p2: "MAJOR",
  warning: "MINOR",
  warn: "MINOR",
  minor: "MINOR",
  low: "MINOR",
  p3: "MINOR",
  info: "MINOR",
  average: "MAJOR",
};

export function severityFor(alert: NormalisedAlert, endpointDefault: string | null): IncidentSeverity {
  const word = (alert.severity ?? "").trim().toLowerCase();
  const mapped = SEVERITY_WORDS[word];
  if (mapped) return mapped;
  // The endpoint's own default beats the shipped one, and is validated rather
  // than trusted: it is a string column that a migration or a hand edit could
  // have left holding anything.
  if (endpointDefault && isIncidentSeverity(endpointDefault)) return endpointDefault;
  return "MINOR";
}

/**
 * The component impact an alert publishes, which is what the public page shows.
 *
 * **Deliberately not derived from severity.** Severity says how bad the incident
 * is for the team; component impact says what a customer sees, and the two are
 * different judgements. An endpoint that says nothing gets PARTIAL_OUTAGE, which
 * is the honest default for "something is alerting about this component": it is
 * neither the claim that everything is fine nor the claim that the whole service
 * is gone.
 */
export function impactFor(endpointDefault: string | null): ComponentImpact {
  if (endpointDefault && isComponentImpact(endpointDefault)) return endpointDefault;
  return "PARTIAL_OUTAGE";
}
