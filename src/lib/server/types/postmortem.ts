import type { DbTimestamp } from "./db.js";

/**
 * Postmortems (C1).
 *
 * Their own type module rather than more of `db.ts` because the two JSON columns
 * carry real structure, and a `string` in a record type says nothing about what
 * is inside it. The parse and serialise helpers live in
 * `src/lib/server/incidents/postmortem.ts` so that the shape and its validation
 * cannot drift apart.
 */

/** DRAFT, PUBLISHED or ARCHIVED. */
export type PostmortemStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export const POSTMORTEM_STATUSES: readonly PostmortemStatus[] = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

/** Where the published timeline comes from. */
export type TimelineSource = "COMMENTS" | "CUSTOM";
export const TIMELINE_SOURCES: readonly TimelineSource[] = ["COMMENTS", "CUSTOM"] as const;

/** An action item's state of play. */
export type ActionItemStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
export const ACTION_ITEM_STATUSES: readonly ActionItemStatus[] = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] as const;

/**
 * One follow-up commitment.
 *
 * `owner` is free text rather than a user id on purpose: the owner of a
 * follow-up is very often a team, a rota or somebody who has no Kener account,
 * and forcing it to be a user would make the common case unrecordable.
 */
export interface PostmortemActionItem {
  text: string;
  owner: string | null;
  /** UTC seconds. Null when the commitment has no date attached. */
  due_at: number | null;
  status: ActionItemStatus;
}

/** One entry of a hand-written timeline. */
export interface PostmortemTimelineEntry {
  /** UTC seconds. */
  at: number;
  text: string;
}

/** A row of `incident_postmortems`, with the JSON columns still as text. */
export interface PostmortemRecord {
  id: number;
  org_id: number;
  incident_id: number;
  status: string;
  title: string;
  summary: string | null;
  root_cause: string | null;
  impact_description: string | null;
  resolution: string | null;
  body_md: string | null;
  /** JSON array of PostmortemActionItem. */
  action_items: string | null;
  timeline_source: string;
  /** JSON array of PostmortemTimelineEntry. */
  timeline_custom: string | null;
  published_at: number | null;
  author_user_id: number | null;
  last_editor_user_id: number | null;
  notify_subscribers: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

/** A postmortem with its JSON columns parsed. What every caller above the repository sees. */
export interface Postmortem extends Omit<PostmortemRecord, "action_items" | "timeline_custom"> {
  action_items: PostmortemActionItem[];
  timeline_custom: PostmortemTimelineEntry[];
}

/** What a caller may set. Every field optional so a partial edit stays partial. */
export interface PostmortemInput {
  title?: string;
  summary?: string | null;
  root_cause?: string | null;
  impact_description?: string | null;
  resolution?: string | null;
  body_md?: string | null;
  action_items?: PostmortemActionItem[];
  timeline_source?: string;
  timeline_custom?: PostmortemTimelineEntry[];
  notify_subscribers?: string;
}
