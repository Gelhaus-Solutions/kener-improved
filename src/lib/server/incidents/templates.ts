import Mustache from "mustache";
import db from "../db/db.js";
import { GetAllSiteData } from "../controllers/siteDataController.js";
import { siteDataToVariables } from "../notification/notification_utils.js";
import { isComponentImpact } from "./impact.js";
import {
  TEMPLATE_VARIABLE_TYPES,
  type AppliedTemplate,
  type IncidentTemplate,
  type IncidentTemplateRecord,
  type TemplateComponent,
  type TemplateVariable,
  type TemplateVariableType,
} from "../types/incidentTemplate.js";

/**
 * Incident templates (C4).
 *
 * **The structural rule this file exists to enforce: applying a template writes
 * nothing.** `ApplyTemplate` renders and returns; the caller submits the result
 * through `CreateIncident`, `AddIncidentMonitor` and `AddIncidentComment` like
 * any other incident. A "create from template" path that inserted the row itself
 * would be a second write path, and every future change to incident creation
 * would have to be made in both - with the copy nobody remembers being the one
 * that quietly stops emitting events.
 *
 * That is also why `ApplyTemplate` returns `missing_required` and `unresolved`
 * rather than throwing. The manage UI previews exactly what would be created,
 * and a preview that refuses to render because a box is empty is a preview that
 * cannot show you which box.
 */

/** Mustache is already the renderer for trigger bodies, so the syntax is one operators know. */
function render(template: string, variables: Record<string, string>): string {
  // Escaping off, for the same reason `webhook_notification.ts` turns it off: the
  // output is markdown destined for `mdToHTML`, which sanitises. Escaping here
  // would turn an apostrophe in a service name into `&#39;` in the incident
  // title, visible to every customer.
  return Mustache.render(template, variables, {}, { escape: (text) => text });
}

/** Mustache names a template references, deduplicated. */
export function templateVariableNames(template: string): string[] {
  const names = new Set<string>();
  for (const [type, name] of Mustache.parse(template)) {
    // "name" is an interpolation, "&" is an unescaped one. Sections and
    // comments are deliberately not collected: a section name is control flow,
    // not a value somebody is expected to type into a form.
    if (type === "name" || type === "&") names.add(String(name));
  }
  return [...names];
}

function safeJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isVariableType(value: unknown): value is TemplateVariableType {
  return typeof value === "string" && (TEMPLATE_VARIABLE_TYPES as readonly string[]).includes(value);
}

/**
 * Coerces stored or submitted JSON into variable declarations.
 *
 * A variable with no key is dropped: `{{}}` resolves to nothing, so a declaration
 * without one can never be referenced and only clutters the form.
 */
export function parseVariables(value: unknown): TemplateVariable[] {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(raw)) return [];

  const variables: TemplateVariable[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (key === "") continue;

    variables.push({
      key,
      label: typeof record.label === "string" && record.label.trim() !== "" ? record.label.trim() : key,
      type: isVariableType(record.type) ? record.type : "text",
      required: record.required === true,
      default: typeof record.default === "string" ? record.default : "",
      options: Array.isArray(record.options)
        ? record.options.filter((o): o is string => typeof o === "string" && o.trim() !== "")
        : [],
    });
  }
  return variables;
}

/**
 * Coerces stored or submitted JSON into components.
 *
 * An unrecognised impact becomes MAJOR_OUTAGE rather than being dropped, because
 * a template that names a component clearly means to attach it, and losing the
 * component entirely is a worse answer than attaching it at the wrong severity -
 * one is visible on the incident and correctable in seconds, the other is
 * invisible until a customer asks why their service was not listed.
 */
export function parseComponents(value: unknown): TemplateComponent[] {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(raw)) return [];

  const components: TemplateComponent[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const tag = typeof record.monitor_tag === "string" ? record.monitor_tag.trim() : "";
    if (tag === "") continue;
    components.push({
      monitor_tag: tag,
      component_impact: isComponentImpact(record.component_impact) ? record.component_impact : "MAJOR_OUTAGE",
    });
  }
  return components;
}

/** A row, with its JSON columns parsed. */
export function hydrate(row: IncidentTemplateRecord): IncidentTemplate {
  return {
    ...row,
    default_components: parseComponents(row.default_components),
    variables: parseVariables(row.variables),
  };
}

export async function ListTemplates(): Promise<IncidentTemplate[]> {
  return (await db.getIncidentTemplates()).map(hydrate);
}

export async function GetTemplate(id: number): Promise<IncidentTemplate | null> {
  const row = await db.getIncidentTemplateById(id);
  return row ? hydrate(row) : null;
}

/**
 * The variables every template gets for free.
 *
 * Mirrors `siteDataToVariables()` so a template author sees the same names here
 * as in a trigger body, plus the three C4 names. `monitors` is the components
 * the template will attach, rendered as a readable list - which is the thing an
 * operator actually wants to interpolate into a sentence, and which they cannot
 * produce themselves because they do not know the monitor names, only the tags.
 */
export async function builtInVariables(
  components: TemplateComponent[],
  severity: string | null,
): Promise<Record<string, string>> {
  const site = siteDataToVariables(await GetAllSiteData());

  const names: string[] = [];
  for (const component of components) {
    const monitor = await db.getMonitorByTag(component.monitor_tag);
    // A tag whose monitor is gone falls back to the tag itself rather than
    // disappearing. A template written a year ago that names a deleted service
    // should still produce a sentence; silently shortening the list would make
    // the incident claim fewer things were affected than the operator selected.
    names.push(monitor?.name ?? component.monitor_tag);
  }

  return {
    ...site,
    monitors: names.join(", "),
    // ISO, because a template's `{{now}}` most often lands in text a customer
    // reads and an unambiguous instant beats a locale-dependent one.
    now: new Date().toISOString(),
    severity: severity ?? "",
  };
}

/**
 * Renders a template into an incident input plus a first comment.
 *
 * Writes nothing. See the note at the top of this file.
 */
export async function ApplyTemplate(templateId: number, values: Record<string, string>): Promise<AppliedTemplate> {
  const template = await GetTemplate(templateId);
  if (!template) throw new Error(`Template ${templateId} does not exist`);

  // Declared defaults first, then what the caller sent. An empty string from the
  // caller is treated as "not filled in" rather than as an override, so clearing
  // a pre-filled box falls back to the default instead of interpolating nothing -
  // which is what an operator means when they tab past a field.
  const resolved: Record<string, string> = {};
  const missingRequired: string[] = [];
  for (const variable of template.variables) {
    const supplied = values[variable.key];
    const value = supplied !== undefined && supplied !== "" ? supplied : variable.default;
    if (variable.required && value === "") missingRequired.push(variable.key);
    resolved[variable.key] = value;
  }

  const components = template.default_components;
  const builtIn = await builtInVariables(components, template.default_severity);

  // Built-ins first, so a declared variable named `severity` wins over the
  // built-in one. The operator's declaration is the more specific statement
  // about what this template means, and a template that could not shadow a
  // built-in name would have a reserved-words list nobody documented.
  const variables = { ...builtIn, ...resolved };

  const title = render(template.title_template, variables);
  const body = template.body_template ? render(template.body_template, variables) : null;

  // Names the template references that nothing resolved. Surfaced rather than
  // rendered as blanks, because a `{{}}` gap in a customer-facing title is the
  // kind of thing that gets screenshotted.
  const referenced = new Set([
    ...templateVariableNames(template.title_template),
    ...(template.body_template ? templateVariableNames(template.body_template) : []),
  ]);
  const unresolved = [...referenced].filter((name) => !(name in variables));

  return {
    incident: {
      title,
      severity: template.default_severity,
      state: template.default_state,
      template_id: template.id,
    },
    first_comment: body,
    components,
    missing_required: missingRequired,
    unresolved,
  };
}

/**
 * Records that a template was used.
 *
 * Separate from `ApplyTemplate` because applying happens on every keystroke of
 * the preview and using happens once. Counting previews would sort the list by
 * who fiddled with what rather than by what actually gets reached for during an
 * outage, which is the only thing the count is for.
 */
export async function NoteTemplateUsed(templateId: number): Promise<void> {
  await db.incrementIncidentTemplateUsage(templateId);
}
