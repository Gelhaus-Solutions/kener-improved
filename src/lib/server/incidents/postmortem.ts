import db from "../db/db.js";
import { emit } from "../events/emit.js";
import { currentOrgId } from "../events/eventContext.js";
import {
  ACTION_ITEM_STATUSES,
  POSTMORTEM_STATUSES,
  TIMELINE_SOURCES,
  type ActionItemStatus,
  type Postmortem,
  type PostmortemActionItem,
  type PostmortemInput,
  type PostmortemRecord,
  type PostmortemStatus,
  type PostmortemTimelineEntry,
  type TimelineSource,
} from "../types/postmortem.js";

/**
 * Postmortems (C1): the lifecycle, the JSON columns, and the events.
 *
 * **A postmortem is not a comment**, and the difference is the whole reason this
 * file exists. A comment publishes the moment it is written and notifies as a
 * status update; a postmortem is drafted after the incident closed, sits in
 * review, and is published as a document. Two of the three verbs here - publish
 * and unpublish - have no equivalent anywhere in the comment path.
 *
 * **Only `publish` notifies.** Drafting and editing emit events so the audit log
 * and any webhook subscriber can see the work happening, but neither reaches a
 * customer: `postmortem.drafted` and `postmortem.updated` are not events the
 * subscribers consumer listens to, and that is deliberate rather than
 * incidental. A postmortem that mailed on every save would be unusable.
 */

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isPostmortemStatus(value: unknown): value is PostmortemStatus {
  return typeof value === "string" && (POSTMORTEM_STATUSES as readonly string[]).includes(value);
}

export function isTimelineSource(value: unknown): value is TimelineSource {
  return typeof value === "string" && (TIMELINE_SOURCES as readonly string[]).includes(value);
}

function isActionItemStatus(value: unknown): value is ActionItemStatus {
  return typeof value === "string" && (ACTION_ITEM_STATUSES as readonly string[]).includes(value);
}

/**
 * Coerces whatever a client sent into action items, dropping what cannot be one.
 *
 * **Lenient about shape, strict about the closed sets.** A missing owner becomes
 * null and a nonsense status becomes OPEN, because neither is worth refusing an
 * operator's save over; an entry with no text is dropped, because an action item
 * with nothing written in it is not a commitment. Refusing the whole list for one
 * bad row would lose the other nine.
 */
export function parseActionItems(value: unknown): PostmortemActionItem[] {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(raw)) return [];

  const items: PostmortemActionItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (text === "") continue;

    const dueAt = Number(record.due_at);
    items.push({
      text,
      owner: typeof record.owner === "string" && record.owner.trim() !== "" ? record.owner.trim() : null,
      due_at: Number.isFinite(dueAt) && dueAt > 0 ? Math.floor(dueAt) : null,
      status: isActionItemStatus(record.status) ? record.status : "OPEN",
    });
  }
  return items;
}

/**
 * Coerces whatever a client sent into a hand-written timeline.
 *
 * Sorted oldest first on the way in, so the stored order is the reading order and
 * no renderer has to sort. An entry without a usable timestamp is dropped: an
 * undated line in a timeline has nowhere to go.
 */
export function parseTimeline(value: unknown): PostmortemTimelineEntry[] {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(raw)) return [];

  const entries: PostmortemTimelineEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const at = Number(record.at);
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!Number.isFinite(at) || at <= 0 || text === "") continue;
    entries.push({ at: Math.floor(at), text });
  }
  return entries.sort((a, b) => a.at - b.at);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // A column that will not parse is a column written by an older shape or by
    // hand. Treating it as empty loses the content, and so would throwing - but
    // throwing also takes the page down with it.
    return null;
  }
}

/** A row, with its JSON columns parsed. */
export function hydrate(row: PostmortemRecord): Postmortem {
  return {
    ...row,
    action_items: parseActionItems(row.action_items),
    timeline_custom: parseTimeline(row.timeline_custom),
  };
}

export async function GetPostmortemByIncident(incidentId: number): Promise<Postmortem | null> {
  const row = await db.getPostmortemByIncidentId(incidentId);
  return row ? hydrate(row) : null;
}

/**
 * The published postmortem for an incident, or null.
 *
 * Separate from the function above rather than a flag on it, because these two
 * are called from different sides of the trust boundary: the editor wants the
 * draft, the public page must never see one. A boolean parameter is a thing that
 * gets passed wrong exactly once.
 */
export async function GetPublishedPostmortem(incidentId: number): Promise<Postmortem | null> {
  const row = await db.getPostmortemByIncidentId(incidentId);
  if (!row || row.status !== "PUBLISHED") return null;
  return hydrate(row);
}

/** Published postmortems for many incidents at once, keyed by incident id. */
export async function GetPublishedPostmortemsFor(incidentIds: number[]): Promise<Map<number, Postmortem>> {
  const rows = await db.getPublishedPostmortemsForIncidents(incidentIds);
  return new Map(rows.map((row) => [row.incident_id, hydrate(row)]));
}

/**
 * Creates the postmortem for an incident, or updates the one already there.
 *
 * Upsert rather than separate create and update verbs because the UNIQUE on
 * `incident_id` means there is only ever one, and an editor that had to know
 * whether it was creating or editing would get it wrong the first time two people
 * opened it at once.
 */
export async function SavePostmortem(incidentId: number, input: PostmortemInput, userId: number): Promise<Postmortem> {
  const incident = await db.getIncidentById(incidentId);
  if (!incident) throw new Error(`Incident with id ${incidentId} does not exist`);

  const existing = await db.getPostmortemByIncidentId(incidentId);

  const fields = {
    // The incident's own title is the default, because a postmortem with no
    // title of its own is still about a thing that has one.
    title: input.title?.trim() || existing?.title || incident.title,
    summary: input.summary !== undefined ? input.summary : (existing?.summary ?? null),
    root_cause: input.root_cause !== undefined ? input.root_cause : (existing?.root_cause ?? null),
    impact_description:
      input.impact_description !== undefined ? input.impact_description : (existing?.impact_description ?? null),
    resolution: input.resolution !== undefined ? input.resolution : (existing?.resolution ?? null),
    body_md: input.body_md !== undefined ? input.body_md : (existing?.body_md ?? null),
    action_items:
      input.action_items !== undefined
        ? JSON.stringify(parseActionItems(input.action_items))
        : (existing?.action_items ?? null),
    timeline_source: isTimelineSource(input.timeline_source)
      ? input.timeline_source
      : (existing?.timeline_source ?? "COMMENTS"),
    timeline_custom:
      input.timeline_custom !== undefined
        ? JSON.stringify(parseTimeline(input.timeline_custom))
        : (existing?.timeline_custom ?? null),
    notify_subscribers:
      input.notify_subscribers !== undefined
        ? input.notify_subscribers === "YES"
          ? "YES"
          : "NO"
        : (existing?.notify_subscribers ?? "NO"),
  };

  return await db.withTransaction(async () => {
    if (existing) {
      await db.updatePostmortem(existing.id, { ...fields, last_editor_user_id: userId });
      const row = await db.getPostmortemById(existing.id);

      await emit({
        org_id: currentOrgId(),
        type: "postmortem.updated",
        aggregate_id: existing.id,
        payload: { postmortem_id: existing.id, incident_id: incidentId, status: existing.status },
      });

      return hydrate(row as PostmortemRecord);
    }

    const row = await db.insertPostmortem({
      org_id: currentOrgId(),
      incident_id: incidentId,
      // Always a draft on creation. **Publishing is its own verb**, so that
      // nothing can make a document public as a side effect of saving it.
      status: "DRAFT",
      published_at: null,
      author_user_id: userId,
      last_editor_user_id: userId,
      ...fields,
    });

    await emit({
      org_id: currentOrgId(),
      type: "postmortem.drafted",
      aggregate_id: row.id,
      payload: { postmortem_id: row.id, incident_id: incidentId },
    });

    return hydrate(row);
  });
}

/**
 * Makes a postmortem public.
 *
 * `published_at` is set only on the first publish and is never rewritten, so it
 * answers "when was this first made public" rather than "when was it last
 * touched". Re-publishing an archived postmortem keeps the original date, which
 * is what a reader who bookmarked it expects.
 *
 * **The notification is a fact about the event, not about the row**, and the
 * distinction matters: `notify_subscribers` is carried in the payload so the
 * subscribers consumer can decide without a second query, and so that a later
 * change to the row cannot retroactively change what an already-emitted event
 * meant.
 */
export async function PublishPostmortem(incidentId: number, userId: number): Promise<Postmortem> {
  const existing = await db.getPostmortemByIncidentId(incidentId);
  if (!existing) throw new Error(`Incident ${incidentId} has no postmortem to publish`);
  if (existing.status === "PUBLISHED") return hydrate(existing);

  const publishedAt = existing.published_at ?? nowSeconds();

  return await db.withTransaction(async () => {
    await db.updatePostmortem(existing.id, {
      status: "PUBLISHED",
      published_at: publishedAt,
      last_editor_user_id: userId,
    });
    const row = (await db.getPostmortemById(existing.id)) as PostmortemRecord;

    await emit({
      org_id: currentOrgId(),
      type: "postmortem.published",
      aggregate_id: existing.id,
      payload: {
        postmortem_id: existing.id,
        incident_id: incidentId,
        title: row.title,
        published_at: publishedAt,
        notify_subscribers: row.notify_subscribers,
      },
      // One publication per postmortem, ever. A republish after an unpublish is
      // a different event only because `published_at` does not move - keying on
      // it means the second one is dropped rather than mailing everybody twice
      // about a document they have already read.
      idempotency_key: `postmortem.published:${existing.id}:${publishedAt}`,
    });

    return hydrate(row);
  });
}

/** Withdraws a published postmortem. Keeps `published_at`: an unpublish does not un-happen. */
export async function UnpublishPostmortem(incidentId: number, userId: number, archive = false): Promise<Postmortem> {
  const existing = await db.getPostmortemByIncidentId(incidentId);
  if (!existing) throw new Error(`Incident ${incidentId} has no postmortem`);

  const status = archive ? "ARCHIVED" : "DRAFT";
  if (existing.status === status) return hydrate(existing);

  return await db.withTransaction(async () => {
    await db.updatePostmortem(existing.id, { status, last_editor_user_id: userId });
    const row = (await db.getPostmortemById(existing.id)) as PostmortemRecord;

    await emit({
      org_id: currentOrgId(),
      type: "postmortem.unpublished",
      aggregate_id: existing.id,
      payload: { postmortem_id: existing.id, incident_id: incidentId, status },
      diff: { before: { status: existing.status }, after: { status } },
    });

    return hydrate(row);
  });
}

export async function DeletePostmortem(incidentId: number): Promise<{ success: boolean }> {
  const existing = await db.getPostmortemByIncidentId(incidentId);
  if (!existing) return { success: false };
  await db.deletePostmortem(existing.id);
  return { success: true };
}
