import { randomBytes } from "node:crypto";
import { parseFormat, normaliseTemplate } from "../notification/webhook_formats.js";
import db from "../db/db.js";
import { seal, secretHint, openOrPlain } from "../crypto/secretBox.js";
import { WEBHOOK_SECRET_PURPOSE, checkWebhookUrl, sendWebhook } from "../notification/webhook_delivery.js";
import { emit } from "../events/emit.js";
import { currentOrgId } from "../events/eventContext.js";
import { isEventType, isAdminEventType, subscribableEventsByDomain } from "$lib/event-taxonomy.js";
import type {
  WebhookEndpointRecord,
  WebhookEndpointStatus,
  WebhookEndpointWithEvents,
  WebhookFormatType,
} from "../types/db.js";

// Webhook endpoint management.
//
// The one rule worth stating up front: **a secret is returned exactly once**, at
// the moment it is generated, and never again. Everything else in the product
// masks secrets on read (`MaskString`); this stores them encrypted and simply
// has no path that hands one back. If an operator loses it they rotate, which is
// a supported operation and takes a grace period, rather than reading it out of
// a form field that should never have contained it.

/** How long the previous secret keeps signing after a rotation. */
const ROTATION_GRACE_SECONDS = 24 * 3600;

const DEFAULT_API_VERSION = "2026-09-08";
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function newSecret(): string {
  // 32 bytes, base64url. The signing key for HMAC-SHA256, so more than this buys
  // nothing and less starts to matter.
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/**
 * The event domains a webhook may subscribe to with a wildcard.
 *
 * Derived from the taxonomy rather than written out, so a new domain becomes
 * subscribable the moment it is added and an administrative one never does.
 */
const SUBSCRIBABLE_DOMAINS: ReadonlySet<string> = new Set(subscribableEventsByDomain().map((g) => g.domain));

/**
 * Validates a subscription list against the closed taxonomy.
 *
 * Two forms are accepted: an exact type, or a domain wildcard like
 * `incident.*`. Anything else is rejected rather than stored and silently never
 * matched, which is the failure mode that has an operator convinced webhooks are
 * broken when in fact they typed `incidents.*`.
 */
export function validateEventTypes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Select at least one event type");
  }

  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error("Event types must be strings");
    }
    if (raw.endsWith(".*")) {
      const domain = raw.slice(0, -2);
      // Checked against the domains that actually exist and are subscribable,
      // not merely against the shape of the string. A wildcard whose domain is
      // misspelled ("incidents.*") is syntactically fine and matches nothing
      // forever, which is precisely the bug that has an operator certain
      // webhooks are broken. Administrative domains are absent from this set, so
      // the same check also stops `user.*` reaching a third party.
      if (!SUBSCRIBABLE_DOMAINS.has(domain)) {
        throw new Error(`Cannot subscribe to '${raw}': '${domain}' is not a deliverable event domain`);
      }
      out.push(raw);
      continue;
    }
    if (!isEventType(raw)) {
      throw new Error(`Unknown event type '${raw}'`);
    }
    if (isAdminEventType(raw)) {
      throw new Error(`'${raw}' is an internal event and cannot be delivered to a webhook`);
    }
    out.push(raw);
  }
  return [...new Set(out)];
}

function clampTimeout(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10000;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

function normaliseHeaders(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Custom headers must be a list of {key, value}");
    return JSON.stringify(parsed);
  } catch {
    throw new Error("Custom headers must be a list of {key, value}");
  }
}

/** The endpoint as the admin UI sees it: never including a secret. */
export interface WebhookEndpointView extends Omit<
  WebhookEndpointRecord,
  "secret_encrypted" | "previous_secret_encrypted"
> {
  event_types: string[];
}

function toView(endpoint: WebhookEndpointRecord, eventTypes: string[]): WebhookEndpointView {
  const { secret_encrypted: _s, previous_secret_encrypted: _p, ...rest } = endpoint;
  return { ...rest, event_types: eventTypes };
}

export const GetWebhookEndpoints = async (): Promise<WebhookEndpointView[]> => {
  const endpoints = await db.getWebhookEndpoints(currentOrgId());
  return await Promise.all(endpoints.map(async (e) => toView(e, await db.getWebhookEndpointEvents(e.id))));
};

export const GetWebhookEndpoint = async (id: number): Promise<WebhookEndpointView> => {
  const endpoint = await db.getWebhookEndpointById(id);
  if (!endpoint || endpoint.org_id !== currentOrgId()) {
    throw new Error(`Webhook endpoint ${id} does not exist`);
  }
  return toView(endpoint, await db.getWebhookEndpointEvents(id));
};

export interface CreateWebhookInput {
  name: string;
  url: string;
  event_types: unknown;
  custom_headers?: unknown;
  timeout_ms?: unknown;
  status?: WebhookEndpointStatus;
  /** E11. GENERIC when absent, so an unconfigured endpoint behaves as before. */
  format?: unknown;
  message_template?: unknown;
}

/**
 * Creates an endpoint and returns its signing secret.
 *
 * The secret is in the return value and nowhere else: it is encrypted before it
 * touches the database and there is no read path that decrypts it for a human.
 */
export const CreateWebhookEndpoint = async (
  data: CreateWebhookInput,
): Promise<{ endpoint: WebhookEndpointView; secret: string }> => {
  if (!data.name || typeof data.name !== "string") throw new Error("Name is required");
  if (!data.url || typeof data.url !== "string") throw new Error("URL is required");

  // Checked at save time as well as at send time. Telling someone their URL is
  // unreachable while they are looking at the form is worth a DNS lookup;
  // finding out from a delivery log three days later is not.
  const check = await checkWebhookUrl(data.url);
  if (!check.allowed) throw new Error(check.reason ?? "URL is not allowed");

  const eventTypes = validateEventTypes(data.event_types);
  const headers = normaliseHeaders(data.custom_headers);
  const secret = newSecret();
  const now = nowSeconds();
  const orgId = currentOrgId();

  const id = await db.withTransaction(async () => {
    const created = await db.createWebhookEndpoint({
      org_id: orgId,
      name: data.name,
      url: data.url,
      secret_encrypted: seal(secret, WEBHOOK_SECRET_PURPOSE),
      secret_hint: secretHint(secret),
      status: data.status === "DISABLED" ? "DISABLED" : "ACTIVE",
      api_version: DEFAULT_API_VERSION,
      // E11. Listed explicitly because this insert names its columns: a field
      // missing from it is accepted by the caller, dropped here, and the write
      // still reports success.
      format: parseFormat(data.format),
      message_template: normaliseTemplate(data.message_template),
      custom_headers: headers,
      timeout_ms: clampTimeout(data.timeout_ms),
      created_at: now,
      updated_at: now,
    });
    await db.setWebhookEndpointEvents(created, eventTypes);
    await emit({
      org_id: orgId,
      type: "webhook_endpoint.created",
      aggregate_id: created,
      payload: { endpoint_id: created, name: data.name, url: data.url, event_types: eventTypes },
    });
    return created;
  });

  return { endpoint: await GetWebhookEndpoint(id), secret };
};

export interface UpdateWebhookInput {
  id: number;
  name?: string;
  url?: string;
  event_types?: unknown;
  custom_headers?: unknown;
  timeout_ms?: unknown;
  status?: WebhookEndpointStatus;
  /** E11. */
  format?: unknown;
  message_template?: unknown;
}

export const UpdateWebhookEndpoint = async (data: UpdateWebhookInput): Promise<WebhookEndpointView> => {
  const existing = await db.getWebhookEndpointById(data.id);
  if (!existing || existing.org_id !== currentOrgId()) {
    throw new Error(`Webhook endpoint ${data.id} does not exist`);
  }

  const patch: Partial<WebhookEndpointRecord> = { updated_at: nowSeconds() };
  if (data.name !== undefined) patch.name = String(data.name);
  if (data.url !== undefined) {
    const check = await checkWebhookUrl(String(data.url));
    if (!check.allowed) throw new Error(check.reason ?? "URL is not allowed");
    patch.url = String(data.url);
  }
  if (data.custom_headers !== undefined) patch.custom_headers = normaliseHeaders(data.custom_headers);
  if (data.format !== undefined) patch.format = parseFormat(data.format);
  if (data.message_template !== undefined) patch.message_template = normaliseTemplate(data.message_template);
  if (data.timeout_ms !== undefined) patch.timeout_ms = clampTimeout(data.timeout_ms);
  if (data.status !== undefined) {
    if (!["ACTIVE", "DISABLED"].includes(data.status)) {
      // DISABLED_AUTO is Kener's to set, never a caller's: it means "we stopped
      // sending", and letting it be set by hand would make the distinction from
      // DISABLED meaningless.
      throw new Error("Status must be ACTIVE or DISABLED");
    }
    patch.status = data.status;
    // Re-enabling clears the failure run, so an endpoint that was auto-disabled
    // gets a full ladder again rather than being switched off on its next miss.
    if (data.status === "ACTIVE") patch.consecutive_failures = 0;
  }

  const eventTypes = data.event_types !== undefined ? validateEventTypes(data.event_types) : null;

  await db.withTransaction(async () => {
    await db.updateWebhookEndpoint(data.id, patch);
    if (eventTypes) await db.setWebhookEndpointEvents(data.id, eventTypes);
    await emit({
      org_id: existing.org_id,
      type: "webhook_endpoint.updated",
      aggregate_id: data.id,
      payload: { endpoint_id: data.id },
      diff: {
        before: { status: existing.status, url: existing.url },
        after: { status: patch.status ?? existing.status, url: patch.url ?? existing.url },
      },
    });
  });

  return await GetWebhookEndpoint(data.id);
};

export const DeleteWebhookEndpoint = async (id: number): Promise<{ success: boolean }> => {
  const existing = await db.getWebhookEndpointById(id);
  if (!existing || existing.org_id !== currentOrgId()) {
    throw new Error(`Webhook endpoint ${id} does not exist`);
  }

  await db.withTransaction(async () => {
    await emit({
      org_id: existing.org_id,
      type: "webhook_endpoint.deleted",
      aggregate_id: id,
      payload: { endpoint_id: id, name: existing.name, url: existing.url },
    });
    await db.deleteWebhookEndpoint(id);
  });

  // Delivery rows survive: they are the record of what was sent, and deleting an
  // endpoint must not erase the evidence that it received something.
  return { success: true };
};

/**
 * Issues a new signing secret, keeping the old one valid for 24 hours.
 *
 * The grace period is the whole point. Without it, rotating means every delivery
 * between the rotation and the receiver being updated fails signature
 * verification, so operators avoid rotating at all. During the window both
 * secrets sign each request and the receiver accepts either.
 */
export const RotateWebhookEndpointSecret = async (
  id: number,
): Promise<{ secret: string; previous_valid_until: number }> => {
  const existing = await db.getWebhookEndpointById(id);
  if (!existing || existing.org_id !== currentOrgId()) {
    throw new Error(`Webhook endpoint ${id} does not exist`);
  }

  const secret = newSecret();
  const now = nowSeconds();
  const expiresAt = now + ROTATION_GRACE_SECONDS;

  await db.withTransaction(async () => {
    await db.updateWebhookEndpoint(id, {
      secret_encrypted: seal(secret, WEBHOOK_SECRET_PURPOSE),
      secret_hint: secretHint(secret),
      // The outgoing secret, not the one already in `previous_`: rotating twice
      // in a day must not resurrect a secret from two rotations ago.
      previous_secret_encrypted: existing.secret_encrypted,
      previous_secret_expires_at: expiresAt,
      updated_at: now,
    });
    await emit({
      org_id: existing.org_id,
      type: "webhook_endpoint.updated",
      aggregate_id: id,
      payload: { endpoint_id: id, secret_rotated: true, previous_valid_until: expiresAt },
    });
  });

  return { secret, previous_valid_until: expiresAt };
};

/**
 * Sends a synthetic event to one endpoint, right now.
 *
 * It does not go through the outbox: a test is not something that happened, and
 * recording it as an event would put a fictional incident into everyone else's
 * delivery stream. The signature and headers are identical to a real delivery,
 * which is what makes it useful for checking a receiver's verification code.
 */
export const TestWebhookEndpoint = async (
  id: number,
): Promise<{ ok: boolean; status: number | null; error: string | null; body: string | null }> => {
  const endpoint = await db.getWebhookEndpointById(id);
  if (!endpoint || endpoint.org_id !== currentOrgId()) {
    throw new Error(`Webhook endpoint ${id} does not exist`);
  }

  const now = nowSeconds();
  const result = await sendWebhook(
    endpoint,
    {
      id: `test_${randomBytes(8).toString("hex")}`,
      // A real type, so a receiver's routing is exercised rather than bypassed.
      type: "incident.created",
      api_version: endpoint.api_version,
      occurred_at: now,
      seq: 0,
      data: {
        object: {
          id: 0,
          title: "Test event from Kener",
          state: "INVESTIGATING",
          status: "OPEN",
          start_date_time: now,
          end_date_time: null,
          components: [],
          updates: [],
          test: true,
        },
        previous: null,
      },
      diff: null,
    },
    now,
  );

  // Deliberately not counted against `consecutive_failures`: a failed test is
  // someone debugging, and it must not push an otherwise healthy endpoint
  // towards being auto-disabled.
  return { ok: result.ok, status: result.status, error: result.error, body: result.body };
};

/** True when the stored secret can still be decrypted, for a health warning in the UI. */
export const WebhookSecretIsReadable = (endpoint: WebhookEndpointRecord): boolean =>
  openOrPlain(endpoint.secret_encrypted, WEBHOOK_SECRET_PURPOSE).length > 0;

export type { WebhookEndpointWithEvents };
