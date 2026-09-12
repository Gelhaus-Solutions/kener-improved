import Mustache from "mustache";
import type { WebhookEnvelope } from "./webhook_delivery.js";

/**
 * E11. What shape an endpoint receives, and what the operator wrote in it.
 *
 * **Why a format at all.** `sendWebhook` posts Kener's own envelope, which is
 * right for a receiver written against Kener and wrong for a chat service that
 * has its own required body. A Discord webhook URL configured today rejects
 * every delivery and the endpoint auto-disables after twenty failures, which
 * reads to the operator as "Kener is broken" rather than "that is the wrong
 * shape". The grain already exists: `api_version` is frozen per endpoint for
 * exactly this kind of reason.
 *
 * **Why a template.** A notification that cannot mention anybody is a
 * notification nobody reads at 3am. The point of wiring Discord up is
 * `<@&ROLE_ID>`, so the operator has to be able to say what arrives, not only
 * whether something does.
 */

export const WEBHOOK_FORMATS = ["GENERIC", "DISCORD"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export function isWebhookFormat(value: unknown): value is WebhookFormat {
  return typeof value === "string" && (WEBHOOK_FORMATS as readonly string[]).includes(value);
}

/** Discord's documented limits. Exceeding either is a 400, not a truncation. */
const CONTENT_LIMIT = 2000;
const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_FIELD_VALUE_LIMIT = 1024;

const ROLE_MENTION = /<@&(\d+)>/g;
const USER_MENTION = /<@!?(\d+)>/g;

/** Discord embed colours, as the decimal integers its API wants. */
const COLOUR = {
  red: 0xe5484d,
  amber: 0xf5a524,
  green: 0x46a758,
  blue: 0x3b82f6,
  grey: 0x60646c,
};

export interface DiscordBody {
  content: string;
  embeds: Array<{
    title: string;
    description?: string;
    color: number;
    url?: string;
    timestamp: string;
    fields?: Array<{ name: string; value: string; inline: boolean }>;
    footer?: { text: string };
  }>;
  allowed_mentions: { parse: string[]; roles: string[]; users: string[] };
}

/**
 * Which mentions Discord is permitted to actually ping.
 *
 * **Derived from the TEMPLATE, never from the rendered message, and that is the
 * whole security property.** An incident title is operator-supplied text that
 * lands in the same string; without this, typing `@everyone` into a title would
 * notify an entire server from a status page. Discord resolves a mention by
 * parsing the content it receives, so the only way to stop that is to tell it
 * explicitly which ids are allowed, and the only ids we can vouch for are the
 * ones whoever configured the endpoint typed themselves.
 *
 * `parse: []` blocks `@everyone` and `@here` outright. They are re-enabled only
 * when the template itself contains one, because an operator who wrote it meant
 * it - and Discord spells both of those `everyone`.
 */
export function allowedMentionsFor(template: string): DiscordBody["allowed_mentions"] {
  const roles = [...template.matchAll(ROLE_MENTION)].map((m) => m[1]);
  const users = [...template.matchAll(USER_MENTION)].map((m) => m[1]);
  const parse: string[] = /@everyone|@here/.test(template) ? ["everyone"] : [];

  return { parse, roles: [...new Set(roles)], users: [...new Set(users)] };
}

/** The variables a template can read. */
export function templateView(envelope: WebhookEnvelope, extra?: { site_name?: string; site_url?: string }) {
  return {
    type: envelope.type,
    id: envelope.id,
    seq: envelope.seq,
    occurred_at: envelope.occurred_at,
    object: envelope.data.object ?? {},
    previous: envelope.data.previous ?? {},
    site_name: extra?.site_name ?? "",
    site_url: extra?.site_url ?? "",
  };
}

/**
 * Renders a template against an envelope.
 *
 * **Escaping is turned off deliberately.** Mustache HTML-escapes by default,
 * which is right for an email body and wrong here: Discord is not HTML, and
 * escaping would turn `&` into `&amp;` and mangle the `<@&123>` mention syntax
 * this feature exists to support. The per-call `escape` in Mustache 4.2 keeps
 * that decision local rather than reaching for the global `Mustache.escape`,
 * which would change every other template in the process.
 *
 * A template that throws - unbalanced braces, usually - must not take the
 * delivery down with it, so it falls back to naming the event.
 */
export function renderTemplate(
  template: string,
  envelope: WebhookEnvelope,
  extra?: { site_name?: string; site_url?: string },
): string {
  try {
    return Mustache.render(template, templateView(envelope, extra), {}, { escape: (v: unknown) => String(v ?? "") });
  } catch {
    return envelope.type;
  }
}

/** Cuts a string to a limit without a silent 400 from the far end. */
function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit - 1) + "…";
}

/** A readable string for a value that may be anything the payload carried. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * The colour of the bar down the side of the embed.
 *
 * Read from the event type first and the payload second, because the type is
 * always present and always means the same thing, while a payload's shape
 * varies by domain.
 */
export function colourFor(envelope: WebhookEnvelope): number {
  const type = envelope.type;
  const object = envelope.data.object ?? {};
  const status = asText(object.status) ?? asText(object.state);

  if (type.endsWith(".resolved") || type.endsWith(".completed") || status === "UP") return COLOUR.green;
  if (type.startsWith("maintenance.")) return COLOUR.blue;
  if (type === "monitor.alert_resolved") return COLOUR.green;
  if (status === "DEGRADED") return COLOUR.amber;
  if (status === "DOWN" || type === "monitor.alert_triggered" || type === "incident.created") return COLOUR.red;
  return COLOUR.grey;
}

/** The default message when an endpoint has no template of its own. */
export const DEFAULT_DISCORD_TEMPLATE = "**{{type}}**";

/**
 * Builds the body Discord expects.
 *
 * The template is the `content`, which is the part that can mention people, and
 * the envelope's detail goes in an embed underneath. Splitting them that way
 * means an operator editing the template is editing exactly the line that pings
 * their team, and never has to reproduce the event detail by hand.
 */
export function toDiscordBody(
  envelope: WebhookEnvelope,
  template: string | null,
  extra?: { site_name?: string; site_url?: string },
): DiscordBody {
  const source = template && template.trim() ? template : DEFAULT_DISCORD_TEMPLATE;
  const content = clamp(renderTemplate(source, envelope, extra), CONTENT_LIMIT);

  const object = envelope.data.object ?? {};
  const title = asText(object.title) ?? asText(object.name) ?? envelope.type;
  const description = asText(object.description) ?? asText(object.comment);

  const fields: DiscordBody["embeds"][number]["fields"] = [];
  for (const [label, key] of [
    ["Status", "status"],
    ["State", "state"],
    ["Severity", "severity"],
    ["Monitor", "monitor_tag"],
  ] as const) {
    const value = asText(object[key]);
    if (value !== null) fields.push({ name: label, value: clamp(value, EMBED_FIELD_VALUE_LIMIT), inline: true });
  }

  return {
    content,
    embeds: [
      {
        title: clamp(title, 256),
        ...(description ? { description: clamp(description, EMBED_DESCRIPTION_LIMIT) } : {}),
        color: colourFor(envelope),
        // Seconds in the envelope, milliseconds in an ISO string.
        timestamp: new Date(envelope.occurred_at * 1000).toISOString(),
        ...(fields.length > 0 ? { fields } : {}),
        footer: { text: extra?.site_name ? `${extra.site_name} - ${envelope.type}` : envelope.type },
      },
    ],
    // From `source`, the template as written, not from `content` as rendered.
    allowed_mentions: allowedMentionsFor(source),
  };
}

/** The body for an endpoint, given its format. GENERIC is the envelope itself. */
export function formatEnvelope(
  format: WebhookFormat,
  envelope: WebhookEnvelope,
  template: string | null,
  extra?: { site_name?: string; site_url?: string },
): unknown {
  return format === "DISCORD" ? toDiscordBody(envelope, template, extra) : envelope;
}

/**
 * E11. Validates a format name, defaulting to GENERIC.
 *
 * Rejected rather than coerced: a typo silently becoming GENERIC would mean an
 * operator who chose Discord watches every delivery fail with no clue why.
 */
export function parseFormat(value: unknown): WebhookFormat {
  if (value === undefined || value === null || value === "") return "GENERIC";
  if (!isWebhookFormat(value)) {
    throw new Error(`Format must be one of ${WEBHOOK_FORMATS.join(", ")}`);
  }
  return value;
}

/** Longer than Discord will accept anyway, and a bound on what we store. */
export const MAX_TEMPLATE_LENGTH = 4000;

/** E11. An empty template means "use the format's default", which is null. */
export function normaliseTemplate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text.slice(0, MAX_TEMPLATE_LENGTH);
}
