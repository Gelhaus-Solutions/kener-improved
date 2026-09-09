import type { DbTimestamp } from "./db.js";

/** Incident templates (C4). */

/** What kind of input a variable wants. */
export type TemplateVariableType = "text" | "textarea" | "select" | "number";
export const TEMPLATE_VARIABLE_TYPES: readonly TemplateVariableType[] = [
  "text",
  "textarea",
  "select",
  "number",
] as const;

/**
 * One variable an operator fills in before the template is applied.
 *
 * `key` is the Mustache name, so `{{service}}` is filled by the variable whose
 * key is `service`.
 */
export interface TemplateVariable {
  key: string;
  label: string;
  type: TemplateVariableType;
  required: boolean;
  /** Pre-filled in the form. Empty string means no default. */
  default: string;
  /** For `select`. Ignored otherwise. */
  options: string[];
}

/** A component the template attaches, and the impact it declares. */
export interface TemplateComponent {
  monitor_tag: string;
  component_impact: string;
}

/** A row of `incident_templates`, with the JSON columns still as text. */
export interface IncidentTemplateRecord {
  id: number;
  org_id: number;
  name: string;
  description: string | null;
  title_template: string;
  body_template: string | null;
  default_severity: string | null;
  default_state: string | null;
  /** JSON array of TemplateComponent. */
  default_components: string | null;
  /** JSON array of TemplateVariable. */
  variables: string | null;
  is_global: string;
  usage_count: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

/** A template with its JSON columns parsed. */
export interface IncidentTemplate extends Omit<IncidentTemplateRecord, "default_components" | "variables"> {
  default_components: TemplateComponent[];
  variables: TemplateVariable[];
}

/** What a caller may set. */
export interface IncidentTemplateInput {
  name?: string;
  description?: string | null;
  title_template?: string;
  body_template?: string | null;
  default_severity?: string | null;
  default_state?: string | null;
  default_components?: TemplateComponent[];
  variables?: TemplateVariable[];
  is_global?: string;
}

/**
 * What applying a template produces.
 *
 * Deliberately *not* an incident. It is the input a caller hands to the ordinary
 * create path, plus the first comment to post afterwards - so a template can
 * never become a second way to write an incident row.
 */
export interface AppliedTemplate {
  incident: {
    title: string;
    severity: string | null;
    state: string | null;
    template_id: number;
  };
  /** The rendered body, to post as the incident's first update. Null when the template has none. */
  first_comment: string | null;
  components: TemplateComponent[];
  /** Variable keys the template declared as required and the caller left empty. */
  missing_required: string[];
  /** Mustache names present in the templates that nothing resolved. */
  unresolved: string[];
}
