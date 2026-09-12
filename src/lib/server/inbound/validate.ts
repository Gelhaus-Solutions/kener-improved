import db from "$lib/server/db/db.js";
import { isComponentImpact, isIncidentSeverity } from "$lib/server/incidents/impact.js";
import { ActionError } from "../manage/types.js";

/**
 * H1. The fields an endpoint's create and update forms share.
 *
 * Validated in one place rather than twice, because the two paths drifting is
 * how an endpoint ends up holding a value the receiver then has to defend
 * against at read time. Everything here is optional: absent means "leave alone"
 * on update and "use the shipped default" on create.
 */
export interface EndpointFields {
  default_monitor_tag?: string | null;
  mapping_rules?: unknown;
  default_impact?: string | null;
  default_severity?: string | null;
  auto_resolve?: boolean;
}

export interface ValidatedEndpointPatch {
  default_monitor_tag?: string | null;
  mapping_rules?: string | null;
  default_impact?: string | null;
  default_severity?: string | null;
  auto_resolve?: boolean;
}

/**
 * Checks the parts of an endpoint an operator types.
 *
 * **Monitor tags are checked against real monitors**, and that is not
 * pedantry: a rule naming a monitor that does not exist matches an alert, claims
 * to have mapped it, and then fails when the incident tries to attach a
 * component. Catching it on the form is the difference between a validation
 * message and a silent gap discovered during an outage.
 */
export async function validateEndpointPatch(data: EndpointFields): Promise<ValidatedEndpointPatch> {
  const patch: ValidatedEndpointPatch = {};

  const knownTags = new Set<string>();
  const needsTags =
    data.default_monitor_tag !== undefined || (data.mapping_rules !== undefined && data.mapping_rules !== null);
  if (needsTags) {
    const monitors = await db.getMonitors({});
    for (const monitor of monitors as Array<{ tag: string }>) knownTags.add(monitor.tag);
  }

  if (data.default_monitor_tag !== undefined) {
    const tag = data.default_monitor_tag === null ? "" : String(data.default_monitor_tag).trim();
    if (tag && !knownTags.has(tag)) throw new ActionError(400, `No monitor has the tag "${tag}"`);
    patch.default_monitor_tag = tag === "" ? null : tag;
  }

  if (data.mapping_rules !== undefined) {
    if (data.mapping_rules === null) {
      patch.mapping_rules = null;
    } else {
      if (!Array.isArray(data.mapping_rules)) throw new ActionError(400, "mapping_rules must be a list");
      const rules: Array<{ label: string; equals: string; monitor_tag: string }> = [];
      for (const raw of data.mapping_rules) {
        const rule = (raw ?? {}) as Record<string, unknown>;
        const label = String(rule.label ?? "").trim();
        const equals = String(rule.equals ?? "").trim();
        const monitorTag = String(rule.monitor_tag ?? "").trim();
        if (!label || !equals || !monitorTag) {
          throw new ActionError(400, "Every rule needs a label, a value to match, and a component");
        }
        if (!knownTags.has(monitorTag)) throw new ActionError(400, `No monitor has the tag "${monitorTag}"`);
        rules.push({ label, equals, monitor_tag: monitorTag });
      }
      patch.mapping_rules = rules.length > 0 ? JSON.stringify(rules) : null;
    }
  }

  if (data.default_impact !== undefined) {
    const impact = data.default_impact === null ? "" : String(data.default_impact).trim();
    if (impact && !isComponentImpact(impact)) throw new ActionError(400, `"${impact}" is not a component impact`);
    patch.default_impact = impact === "" ? null : impact;
  }

  if (data.default_severity !== undefined) {
    const severity = data.default_severity === null ? "" : String(data.default_severity).trim();
    if (severity && !isIncidentSeverity(severity)) throw new ActionError(400, `"${severity}" is not a severity`);
    patch.default_severity = severity === "" ? null : severity;
  }

  if (data.auto_resolve !== undefined) patch.auto_resolve = data.auto_resolve === true;

  return patch;
}
