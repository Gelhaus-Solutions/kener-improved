import { BaseRepository, type IncidentFilter, type CountResult } from "./base.js";
import { GetDbType } from "../../tool.js";
import { hasFullTextSearch } from "../capabilities.js";
import GC from "../../../global-constants.js";
import type {
  IncidentRecord,
  IncidentRecordInsert,
  IncidentMonitorRecordInsert,
  IncidentMonitorRecord,
  IncidentMonitorDetailRecord,
  IncidentCommentRecord,
  IncidentForMonitorList,
  IncidentForMonitorListWithComments,
  IncidentMonitorImpact,
  DbTimestamp,
} from "../../types/db.js";

/** G7. A position in the incident history, not a count of rows skipped. */
export interface PublicIncidentCursor {
  startDateTime: number;
  id: number;
}

export interface PublicIncidentQuery {
  /**
   * The monitor tags this page shows. Omit for an unscoped history.
   *
   * These must already exclude hidden and inactive monitors - pass what
   * `getPageMonitorsExcludeHidden` returned, not every tag on the page.
   */
  monitorTags?: string[];
  search?: string;
  start?: number;
  end?: number;
  state?: string;
  cursor?: PublicIncidentCursor | null;
  limit: number;
}

export interface PublicIncidentPage {
  incidents: IncidentForMonitorListWithComments[];
  /** Null when this is the last page. */
  nextCursor: PublicIncidentCursor | null;
}

/**
 * Escapes the wildcards in a user's search term for a `LIKE` pattern.
 *
 * Without this, searching for `50%` matches every incident and searching for
 * `a_b` matches `axb` - and the user has no way to know why. The backslash is
 * escaped first, or escaping the wildcards would then double-escape it.
 *
 * Only the non-Postgres path needs this; full text does not use `LIKE` at all.
 */
function escapeLikePattern(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** The lifecycle columns this backfill can derive. `acknowledged_at` cannot be. */
export type LifecycleColumn = "detected_at" | "identified_at" | "mitigated_at" | "resolved_at";

/**
 * What one backfill run filled.
 *
 * Per column rather than a single total, because "it wrote 40 values" does not
 * tell an operator whether detection was recovered or only resolution was, and
 * those come from different evidence with very different coverage.
 *
 * `acknowledged_at` is absent deliberately: it records that a *human* took
 * ownership, and no historical source for that exists. Deriving it from
 * anything available would be inventing the MTTA number rather than measuring
 * it, so history keeps null and the Acknowledge action fills it going forward.
 */
export interface LifecycleBackfillCounts {
  /** Incidents that were missing at least one column before the run. */
  incidents_considered: number;
  detected_at: number;
  identified_at: number;
  mitigated_at: number;
  resolved_at: number;
}

/** `whereIn` has a practical ceiling on every driver, and SQLite's is 999. */
const ID_CHUNK = 500;

function* chunked(ids: number[]): Generator<number[]> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) yield ids.slice(i, i + ID_CHUNK);
}

/**
 * `monitor_alerts_v2.created_at` as UTC seconds, whatever the driver returned.
 *
 * Transcribed from the migration rather than shared with `parseDbTimestamp`, and
 * the difference is deliberate: `parseDbTimestamp` reads every number as
 * milliseconds, while this distinguishes seconds from milliseconds by
 * magnitude. Changing which one this backfill uses would let a re-run disagree
 * with the value the migration already wrote on an older install.
 *
 * The regex branch is the part that matters. SQLite stores `knex.fn.now()` as
 * `YYYY-MM-DD HH:MM:SS` with no zone marker, and `new Date()` reads a string in
 * that shape as **local** time. On a machine in Europe/Berlin that shifts every
 * `detected_at` by an hour or two, in the direction that makes detection look
 * like it happened before the outage did. Postgres hands back a real Date and
 * needs none of this, which is exactly why the bug would survive a
 * Postgres-only test.
 */
export function alertCreatedAtSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") {
    // Already seconds if it is small enough to be, milliseconds otherwise.
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string") {
    const naive = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
    const parsed = new Date(naive ? value.replace(" ", "T") + "Z" : value);
    const ms = parsed.getTime();
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

// Raw row type from DB query before grouping
interface IncidentRowWithMonitor {
  id: number;
  title: string;
  start_date_time: number;
  end_date_time: number | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  status: string;
  state: string;
  monitor_impact: string;
  monitor_tag: string;
  /**
   * The per-org public name, which is what a link to this monitor must carry
   * (I3e). Falls back to the tag where a row's slug was never filled in, which
   * is what `ResolvePublicMonitor` accepts anyway.
   */
  monitor_slug: string;
  monitor_name: string;
  monitor_image: string | null;
}

/**
 * Repository for incidents, incident monitors, and incident comments operations
 */
export class IncidentsRepository extends BaseRepository {
  // ============ Helper Functions ============

  /**
   * Group raw incident rows by incident ID, aggregating monitors into an array
   */
  private groupIncidentsByIdForMonitorList(rows: IncidentRowWithMonitor[]): IncidentForMonitorList[] {
    const incidentMap = new Map<number, IncidentForMonitorList>();

    for (const row of rows) {
      if (!incidentMap.has(row.id)) {
        incidentMap.set(row.id, {
          id: row.id,
          title: row.title,
          start_date_time: row.start_date_time,
          end_date_time: row.end_date_time,
          created_at: row.created_at,
          updated_at: row.updated_at,
          status: row.status,
          state: row.state,
          monitors: [],
        });
      }

      const incident = incidentMap.get(row.id)!;
      // Only add monitor if it exists (handles LEFT JOIN nulls)
      if (row.monitor_tag) {
        incident.monitors.push({
          monitor_tag: row.monitor_tag,
          monitor_impact: row.monitor_impact,
          monitor_slug: row.monitor_slug ?? row.monitor_tag,
          monitor_name: row.monitor_name,
          monitor_image: row.monitor_image,
        });
      }
    }

    return Array.from(incidentMap.values());
  }

  // ============ G7: public incident history ============

  /**
   * One keyset page of the publicly visible incident history.
   *
   * **Keyset, not OFFSET, and the reason is correctness before speed.**
   * `getIncidentsPaginated` pages with `.offset((page-1)*limit)`, which is not
   * merely slow at depth: incidents are ordered newest-first, so a new incident
   * arriving while somebody is reading page 3 shifts every later row down one
   * and the reader sees a row they already saw on page 2. A cursor on
   * `(start_date_time DESC, id DESC)` describes a *position in the data* rather
   * than a count of rows skipped, so concurrent inserts cannot duplicate or skip
   * anything, and the page is found by index seek instead of by counting.
   *
   * **The visibility rules are copied from `getIncidentsForEventsByDateRange`
   * deliberately, not approximated.** This is an anonymous, public endpoint, so
   * getting them wrong publishes something an operator did not: only
   * `incident_type = INCIDENT` (the same table stores maintenances), only
   * `status = OPEN` (which is the *published* flag, not "unresolved"), and only
   * incidents attached to a monitor this page shows or marked `is_global`.
   * Comments are matched and returned only when `status = ACTIVE`, so a retracted
   * update cannot be found by searching for its text.
   *
   * Resolved in two steps - ids first, then hydrate - because the monitor join
   * multiplies rows per incident, and a `LIMIT` over multiplied rows returns a
   * number of *rows* rather than a number of incidents.
   */
  async getPublicIncidentsPaginated(query: PublicIncidentQuery): Promise<PublicIncidentPage> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const self = this;

    let ids = this.table("incidents")
      .distinct("incidents.id", "incidents.start_date_time")
      .where("incidents.incident_type", GC.INCIDENT)
      .andWhere("incidents.status", "OPEN");

    if (query.monitorTags) {
      ids = ids.leftJoin("incident_monitors", "incidents.id", "incident_monitors.incident_id").andWhere(function () {
        this.whereIn("incident_monitors.monitor_tag", query.monitorTags!).orWhere("incidents.is_global", "YES");
      });
    }

    if (query.start !== undefined) ids = ids.andWhere("incidents.start_date_time", ">=", query.start);
    if (query.end !== undefined) ids = ids.andWhere("incidents.start_date_time", "<=", query.end);
    if (query.state) ids = ids.andWhere("incidents.state", query.state);

    // The cursor predicate. Written out rather than as a row comparison
    // `(a,b) < (x,y)`, which SQLite does not support.
    if (query.cursor) {
      const cursor = query.cursor;
      ids = ids.andWhere(function () {
        this.where("incidents.start_date_time", "<", cursor.startDateTime).orWhere(function () {
          this.where("incidents.start_date_time", cursor.startDateTime).andWhere("incidents.id", "<", cursor.id);
        });
      });
    }

    const search = query.search?.trim();
    if (search) {
      if (hasFullTextSearch()) {
        // `websearch_to_tsquery`, not `to_tsquery`: this is a public search box,
        // and `to_tsquery` throws a syntax error on ordinary punctuation - an
        // apostrophe, a stray colon - which would turn a normal query into a 500.
        // `websearch_to_tsquery` accepts anything a person types and understands
        // quoted phrases and `-exclusions` the way a search engine does.
        const commentMatch = this.table("incident_comments")
          .select(1)
          .whereRaw("incident_comments.incident_id = incidents.id")
          .andWhere("incident_comments.status", "ACTIVE")
          .andWhereRaw("incident_comments.search_tsv @@ websearch_to_tsquery('english', ?)", [search]);

        ids = ids.andWhere(function () {
          this.whereRaw("incidents.search_tsv @@ websearch_to_tsquery('english', ?)", [search]).orWhereExists(
            commentMatch,
          );
        });
      } else {
        const pattern = `%${escapeLikePattern(search)}%`;
        const commentMatch = this.table("incident_comments")
          .select(1)
          .whereRaw("incident_comments.incident_id = incidents.id")
          .andWhere("incident_comments.status", "ACTIVE")
          .andWhereRaw("incident_comments.comment LIKE ? ESCAPE '\\'", [pattern]);

        ids = ids.andWhere(function () {
          this.whereRaw("incidents.title LIKE ? ESCAPE '\\'", [pattern]).orWhereExists(commentMatch);
        });
      }
    }

    // One more than asked for: its existence is what says there is another page,
    // without a second COUNT query that would be wrong by the time it returned.
    const idRows = (await ids
      .orderBy("incidents.start_date_time", "desc")
      .orderBy("incidents.id", "desc")
      .limit(limit + 1)) as Array<{ id: number; start_date_time: number }>;

    const pageRows = idRows.slice(0, limit);
    const nextCursor =
      idRows.length > limit
        ? { startDateTime: pageRows[pageRows.length - 1].start_date_time, id: pageRows[pageRows.length - 1].id }
        : null;

    if (pageRows.length === 0) return { incidents: [], nextCursor: null };

    const incidents = await self.hydratePublicIncidents(pageRows.map((r) => r.id));
    return { incidents, nextCursor };
  }

  /**
   * Loads full incidents for `ids`, newest first, with their public comments.
   *
   * Ordered here rather than trusting the database to return `whereIn` results in
   * any particular order, which it does not promise.
   */
  private async hydratePublicIncidents(ids: number[]): Promise<IncidentForMonitorListWithComments[]> {
    const rows = await this.table("incidents")
      .select(
        "incidents.id",
        "incidents.title",
        "incidents.start_date_time",
        "incidents.end_date_time",
        "incidents.created_at",
        "incidents.updated_at",
        "incidents.status",
        "incidents.state",
        "incident_monitors.monitor_impact",
        "incident_monitors.monitor_tag",
        "monitors.slug as monitor_slug",
        "monitors.name as monitor_name",
        "monitors.image as monitor_image",
        "monitors.is_hidden as monitor_is_hidden",
      )
      .leftJoin("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .leftJoin("monitors", "incident_monitors.monitor_tag", "monitors.tag")
      .whereIn("incidents.id", ids)
      .orderBy("incidents.start_date_time", "desc")
      .orderBy("incidents.id", "desc");

    const incidents = this.groupIncidentsByIdForMonitorListFilterHidden(rows);
    if (incidents.length === 0) return [];

    const comments = await this.table("incident_comments")
      .select("*")
      .whereIn(
        "incident_id",
        incidents.map((incident) => incident.id),
      )
      .andWhere("status", "ACTIVE")
      .orderBy("commented_at", "desc")
      .orderBy("id", "desc");

    const byIncident = new Map<number, IncidentCommentRecord[]>();
    for (const comment of comments) {
      const existing = byIncident.get(comment.incident_id) || [];
      existing.push(comment);
      byIncident.set(comment.incident_id, existing);
    }

    return incidents.map((incident) => ({
      ...incident,
      comments: byIncident.get(incident.id) || [],
    }));
  }

  // ============ Incidents ============

  /**
   * Incidents by page number, or - when `cursor` is supplied - by keyset.
   *
   * **The cursor is additive and changes nothing for callers that do not pass
   * one.** v5 publishes a `?page=` contract that third parties already poll, so
   * the OFFSET path stays byte-identical, including its `ORDER BY id`. A caller
   * that opts into a cursor gets the correct ordering for paging a newest-first
   * list, `(start_date_time DESC, id DESC)`, and with it the guarantee OFFSET
   * cannot give: an incident created mid-browse cannot make a row appear twice.
   *
   * Ordering differs between the two modes on purpose. Switching the OFFSET path
   * to the keyset ordering would silently reorder every existing client's
   * results, which is a breaking change wearing a bugfix's clothes.
   */
  async getIncidentsPaginated(
    page: number,
    limit: number,
    filter: IncidentFilter | null,
    direction: "after" | "before" = "after",
    cursor?: PublicIncidentCursor | null,
  ): Promise<IncidentRecord[]> {
    let query = this.table("incidents").select("*").whereRaw("1=1");
    if (filter && filter.status) {
      query = query.andWhere("status", filter.status);
    }
    if (filter && filter.start && direction === "after") {
      query = query.andWhere("start_date_time", ">=", filter.start);
    }
    if (filter && filter.start && direction === "before") {
      query = query.andWhere("start_date_time", "<=", filter.start);
    }
    if (filter && filter.end && direction === "after") {
      query = query.andWhere("start_date_time", "<=", filter.end);
    }
    if (filter && filter.end && direction === "before") {
      query = query.andWhere("start_date_time", ">=", filter.end);
    }
    if (filter && filter.state) {
      query = query.andWhere("state", filter.state);
    }
    if (filter && filter.id) {
      query = query.andWhere("id", filter.id);
    }
    if (filter && filter.incident_type) {
      query = query.andWhere("incident_type", filter.incident_type);
    }
    if (filter && filter.incident_source) {
      query = query.andWhere("incident_source", filter.incident_source);
    }
    if (cursor !== undefined) {
      // Keyset mode. `cursor: null` means "the first page", which is different
      // from `undefined` meaning "this caller does not use cursors at all".
      if (cursor) {
        const position = cursor;
        query = query.andWhere(function () {
          this.where("start_date_time", "<", position.startDateTime).orWhere(function () {
            this.where("start_date_time", position.startDateTime).andWhere("id", "<", position.id);
          });
        });
      }
      return await query.orderBy("start_date_time", "desc").orderBy("id", "desc").limit(limit);
    }

    if (direction === "after") {
      query = query
        .orderBy("id", "desc")
        .limit(limit)
        .offset((page - 1) * limit);
    } else {
      query = query
        .orderBy("id", "asc")
        .limit(limit)
        .offset((page - 1) * limit);
    }
    return await query;
  }

  /**
   * Inserts an incident.
   *
   * **The third member of the whitelist family, and the one that was wrong.**
   * `updateIncident` and `getIncidentById` document each other as a pair; this
   * one was never mentioned and never updated, so from C2 until C2c it dropped
   * `severity`, `impact_override`, `suppress_notifications` and `template_id` on
   * the way in. Every incident landed with the column defaults - `NONE` and
   * `NO` - while `CreateIncident` emitted an `incident.created` payload carrying
   * the severity the operator actually chose. The event said MAJOR and the row
   * said NONE, and nothing errored, which is the same failure C2's severity had
   * on update and C7 would have inherited: `suppress_notifications` could never
   * be `YES`, so a backfill would have mailed everybody.
   *
   * Anything added to `IncidentRecordInsert` belongs here, in `updateIncident`
   * and in `getIncidentById`. All three, every time.
   */
  async createIncident(data: IncidentRecordInsert): Promise<IncidentRecord> {
    const dbType = GetDbType();

    const insertData = {
      title: data.title,
      start_date_time: data.start_date_time,
      end_date_time: data.end_date_time,
      status: data.status,
      state: data.state,
      created_at: this.knexUnscoped.fn.now(),
      updated_at: this.knexUnscoped.fn.now(),
      incident_type: data.incident_type,
      incident_source: data.incident_source,
      is_global: data.is_global || "YES",
      // C2. Undefined is left to the column default rather than written as null:
      // `severity` and `suppress_notifications` are NOT NULL, so an explicit null
      // from a caller that did not mention them would fail the insert outright.
      ...(data.severity !== undefined ? { severity: data.severity } : {}),
      ...(data.impact_override !== undefined ? { impact_override: data.impact_override } : {}),
      ...(data.suppress_notifications !== undefined ? { suppress_notifications: data.suppress_notifications } : {}),
      ...(data.template_id !== undefined ? { template_id: data.template_id } : {}),
      // C2c. Normally only `detected_at` is set here, by the alerting queue; a
      // backfill hands over the whole lifecycle at once.
      ...(data.detected_at !== undefined ? { detected_at: data.detected_at } : {}),
      ...(data.acknowledged_at !== undefined ? { acknowledged_at: data.acknowledged_at } : {}),
      ...(data.acknowledged_by_user_id !== undefined ? { acknowledged_by_user_id: data.acknowledged_by_user_id } : {}),
      ...(data.identified_at !== undefined ? { identified_at: data.identified_at } : {}),
      ...(data.mitigated_at !== undefined ? { mitigated_at: data.mitigated_at } : {}),
      ...(data.resolved_at !== undefined ? { resolved_at: data.resolved_at } : {}),
    };

    if (dbType === "postgresql") {
      const [incident] = await this.table("incidents").insert(insertData).returning("*");
      return incident;
    } else {
      const result = await this.table("incidents").insert(insertData);
      const id = result[0];
      const incident = await this.table("incidents").where("id", id).first();
      return incident;
    }
  }

  async getIncidentsPaginatedDesc(
    page: number,
    limit: number,
    filter: IncidentFilter | null,
  ): Promise<IncidentRecord[]> {
    let query = this.table("incidents").select("*").whereRaw("1=1");

    if (filter && filter.status) {
      query = query.andWhere("status", filter.status);
    }
    if (filter && filter.start) {
      query = query.andWhere("start_date_time", ">=", filter.start);
    }
    if (filter && filter.end) {
      query = query.andWhere("start_date_time", "<=", filter.end);
    }
    if (filter && filter.state) {
      query = query.andWhere("state", filter.state);
    }
    if (filter && filter.id) {
      query = query.andWhere("id", filter.id);
    }

    query = query
      .orderBy("id", "desc")
      .limit(limit)
      .offset((page - 1) * limit);

    return await query;
  }

  async getRecentUpdatedIncidents(limit: number, start: number, end: number): Promise<IncidentRecord[]> {
    return await this.table("incidents")
      .where("status", "OPEN")
      .andWhere("start_date_time", ">=", start)
      .andWhere("start_date_time", "<=", end)
      .orderBy("updated_at", "desc")
      .limit(limit);
  }

  async getPreviousIncidentId(start_date_time: number): Promise<{ id: number } | undefined> {
    return await this.table("incidents")
      .select("id")
      .where("start_date_time", "<", start_date_time)
      .orderBy("start_date_time", "desc")
      .first();
  }

  async getIncidentsBetween(start: number, end: number): Promise<IncidentRecord[]> {
    return await this.table("incidents")
      .where("status", "OPEN")
      .andWhere("start_date_time", ">=", start)
      .andWhere("start_date_time", "<=", end)
      .orderBy("start_date_time", "asc");
  }

  /**
   * Incidents in a range, for the response metrics (F3).
   *
   * **`incident_type = 'INCIDENT'` is the load-bearing clause.** The `incidents`
   * table also stores maintenances, which carry the same lifecycle columns and
   * would otherwise be averaged into MTTR - reporting that the team "resolved" a
   * planned four-hour window in four hours. A maintenance is not an incident and
   * has no response time.
   *
   * Unlike `getIncidentsBetween` this does **not** filter to `status = 'OPEN'`:
   * a report is mostly about incidents that are over, and restricting to open
   * ones would leave MTTR computable for almost nothing.
   *
   * Selected by `start_date_time` rather than by resolution, so an incident
   * belongs to the window it began in. That is the convention a monthly report
   * is read with, and it keeps an incident from moving between two months'
   * reports depending on when it happened to close.
   */
  async getIncidentsForMetrics(start: number, end: number, limit: number): Promise<IncidentRecord[]> {
    return await this.table("incidents")
      .where("incident_type", "INCIDENT")
      .andWhere("start_date_time", ">=", start)
      .andWhere("start_date_time", "<", end)
      .orderBy("start_date_time", "asc")
      .limit(limit);
  }

  /**
   * The component tags for many incidents at once (F3).
   *
   * One query for a page of incidents rather than one per incident. The metrics
   * path already pays for a sample scan per incident to find the true outage
   * start; adding a round trip each to learn which monitors were attached would
   * be the avoidable half of that cost.
   */
  async getMonitorTagsForIncidents(incidentIds: ReadonlyArray<number>): Promise<Map<number, string[]>> {
    const byIncident = new Map<number, string[]>();
    if (incidentIds.length === 0) return byIncident;

    const rows = await this.table("incident_monitors")
      .select("incident_id", "monitor_tag")
      .whereIn("incident_id", incidentIds as number[]);

    for (const row of rows as Array<{ incident_id: number; monitor_tag: string }>) {
      const id = Number(row.incident_id);
      const list = byIncident.get(id);
      if (list) list.push(String(row.monitor_tag));
      else byIncident.set(id, [String(row.monitor_tag)]);
    }
    return byIncident;
  }

  async getIncidentsCount(filter: { status?: string } | null): Promise<CountResult | undefined> {
    let query = this.table("incidents").count("* as count");
    if (filter && filter.status) {
      query = query.where("status", filter.status);
    }
    return await query.first<CountResult>();
  }

  async getIncidentsCountByTypeAndDateRange(
    incident_type: string,
    start_date: number,
    end_date: number,
  ): Promise<CountResult | undefined> {
    return await this.table("incidents")
      .count("* as count")
      .where("incident_type", incident_type)
      .andWhere("start_date_time", ">=", start_date)
      .andWhere("start_date_time", "<=", end_date)
      .first<CountResult>();
  }

  /**
   * Updates an incident.
   *
   * The column list is explicit rather than spreading `data`, which is the right
   * shape - callers hand this a whole record and a spread would let `id`,
   * `created_at` or anything else ride along. The cost is that **a new column is
   * invisible here until it is added**, and it fails quietly: C2's `severity` was
   * computed, diffed and emitted as `incident.severity_changed` while the write
   * silently dropped it, so the event log said the severity moved and the row
   * said it never had. Anything added to `IncidentRecord` that an operator can
   * edit belongs in this list.
   */
  async updateIncident(data: IncidentRecord): Promise<number> {
    return await this.table("incidents").where({ id: data.id }).update({
      title: data.title,
      start_date_time: data.start_date_time,
      end_date_time: data.end_date_time,
      status: data.status,
      state: data.state,
      is_global: data.is_global,
      severity: data.severity,
      severity_changed_at: data.severity_changed_at,
      impact_override: data.impact_override,
      suppress_notifications: data.suppress_notifications,
      template_id: data.template_id,
      // C2c. Editable in the sense that matters here: the controller computes
      // them from state transitions and writes them back through this method, so
      // an omission would drop a transition exactly the way it dropped C2's
      // severity.
      detected_at: data.detected_at,
      acknowledged_at: data.acknowledged_at,
      acknowledged_by_user_id: data.acknowledged_by_user_id,
      identified_at: data.identified_at,
      mitigated_at: data.mitigated_at,
      resolved_at: data.resolved_at,
      updated_at: this.knexUnscoped.fn.now(),
    });
  }

  async deleteIncident(id: number): Promise<number> {
    return await this.table("incidents").where({ id }).delete();
  }

  async setIncidentEndTimeToNull(id: number): Promise<number> {
    return await this.table("incidents").where({ id }).update({
      end_date_time: null,
      updated_at: this.knexUnscoped.fn.now(),
    });
  }

  /**
   * One incident.
   *
   * The column list has to stay in step with `updateIncident`'s, and the pairing
   * is not decorative: `UpdateIncident` reads the current row here and writes
   * back every field it did not change. A column present in the write list and
   * absent here reads as `undefined` and is written as `undefined` - which knex
   * drops, so the value survives by luck rather than by design, and the moment
   * anything compares against it the comparison is against nothing. That is how
   * C2's `impact_override` would have become impossible to preserve.
   */
  async getIncidentById(id: number): Promise<Omit<IncidentRecord, "incident_source"> | undefined> {
    return await this.table("incidents")
      .select(
        "id",
        "title",
        "start_date_time",
        "end_date_time",
        "created_at",
        "updated_at",
        "status",
        "state",
        "incident_type",
        "is_global",
        "severity",
        "severity_changed_at",
        "impact_override",
        "suppress_notifications",
        "template_id",
        "detected_at",
        "acknowledged_at",
        "acknowledged_by_user_id",
        "identified_at",
        "mitigated_at",
        "resolved_at",
      )
      .where("id", id)
      .first();
  }

  async getIncidentsByIds(ids: number[]): Promise<IncidentRecord[]> {
    return await this.table("incidents").whereIn("id", ids).andWhere("status", "OPEN");
  }

  async getIncidentsByMonitorTag(
    monitor_tag: string,
    start: number,
    end: number,
  ): Promise<Array<IncidentRecord & { monitor_impact: string | null }>> {
    return await this.table("incidents as i")
      .select(
        "i.id as id",
        "i.title as title",
        "i.start_date_time as start_date_time",
        "i.end_date_time as end_date_time",
        "i.created_at as created_at",
        "i.updated_at as updated_at",
        "i.status as status",
        "i.state as state",
        "i.incident_type as incident_type",
        "im.monitor_impact",
      )
      .innerJoin("incident_monitors as im", "i.id", "im.incident_id")
      .where("im.monitor_tag", monitor_tag)
      .andWhere("i.start_date_time", ">=", start)
      .andWhere("i.start_date_time", "<=", end)
      .andWhere("i.status", "OPEN");
  }

  async getIncidentsByMonitorTagRealtime(
    monitor_tag: string,
    timestamp: number,
  ): Promise<
    Array<{ id: number; start_date_time: number; end_date_time: number | null; monitor_impact: string | null }>
  > {
    return await this.table("incidents as i")
      .select(
        "i.id as id",
        "i.start_date_time as start_date_time",
        "i.end_date_time as end_date_time",
        "im.monitor_impact",
      )
      .innerJoin("incident_monitors as im", "i.id", "im.incident_id")
      .where("im.monitor_tag", monitor_tag)
      .andWhere("i.start_date_time", "<=", timestamp)
      .andWhere("i.status", "OPEN")
      .andWhere("i.incident_type", "INCIDENT")
      .andWhere("i.state", "!=", "RESOLVED")
      .andWhere("i.incident_source", "!=", "ALERT");
  }

  async getMaintenanceByMonitorTagRealtime(
    monitor_tag: string,
    timestamp: number,
  ): Promise<
    Array<{ id: number; start_date_time: number; end_date_time: number | null; monitor_impact: string | null }>
  > {
    return await this.table("incidents as i")
      .select(
        "i.id as id",
        "i.start_date_time as start_date_time",
        "i.end_date_time as end_date_time",
        "im.monitor_impact",
      )
      .innerJoin("incident_monitors as im", "i.id", "im.incident_id")
      .where("im.monitor_tag", monitor_tag)
      .andWhere("i.start_date_time", "<=", timestamp)
      .andWhere("i.end_date_time", ">=", timestamp)
      .andWhere("i.status", "OPEN")
      .andWhere("i.incident_type", "MAINTENANCE")
      .andWhere("i.state", "=", "RESOLVED")
      .andWhere("i.incident_source", "!=", "ALERT");
  }

  // Status-related queries
  async getOngoingMaintenances(timestamp: number): Promise<IncidentRecord[]> {
    return await this.table("incidents")
      .where("incident_type", "MAINTENANCE")
      .andWhere("status", "OPEN")
      .andWhere("start_date_time", "<=", timestamp)
      .andWhere(function () {
        this.whereNull("end_date_time").orWhere("end_date_time", ">=", timestamp);
      })
      .orderBy("start_date_time", "desc");
  }

  async getUpcomingMaintenances(currentTimestamp: number, futureTimestamp: number): Promise<IncidentRecord[]> {
    return await this.table("incidents")
      .where("incident_type", "MAINTENANCE")
      .andWhere("status", "OPEN")
      .andWhere("start_date_time", ">", currentTimestamp)
      .andWhere("start_date_time", "<=", futureTimestamp)
      .orderBy("start_date_time", "asc");
  }

  async getLastMaintenance(): Promise<IncidentRecord | undefined> {
    return await this.table("incidents")
      .where("incident_type", "MAINTENANCE")
      .andWhere("status", "OPEN")
      .orderBy("start_date_time", "desc")
      .first();
  }

  async getOngoingIncidents(timestamp: number): Promise<IncidentRecord[]> {
    return await this.table("incidents")
      .where("incident_type", "INCIDENT")
      .andWhere("status", "OPEN")
      .andWhere("start_date_time", "<=", timestamp)
      .andWhere(function () {
        this.whereNull("end_date_time").orWhere("end_date_time", ">=", timestamp);
      })
      .orderBy("start_date_time", "desc");
  }

  async getLastIncident(): Promise<IncidentRecord | undefined> {
    return await this.table("incidents")
      .where("incident_type", "INCIDENT")
      .andWhere("status", "OPEN")
      .orderBy("start_date_time", "desc")
      .first();
  }

  async getOngoingMaintenancesByMonitorTags(timestamp: number, monitorTags: string[]): Promise<IncidentRecord[]> {
    return await this.table("incidents")
      .distinct("incidents.*")
      .join("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .whereIn("incident_monitors.monitor_tag", monitorTags)
      .andWhere("incidents.incident_type", "MAINTENANCE")
      .andWhere("incidents.status", "OPEN")
      .andWhere("incidents.start_date_time", "<=", timestamp)
      .andWhere(function () {
        this.whereNull("incidents.end_date_time").orWhere("incidents.end_date_time", ">=", timestamp);
      })
      .orderBy("incidents.start_date_time", "desc");
  }

  async getUpcomingMaintenancesByMonitorTags(
    currentTimestamp: number,
    futureTimestamp: number,
    monitorTags: string[],
  ): Promise<IncidentRecord[]> {
    return await this.table("incidents")
      .distinct("incidents.*")
      .join("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .whereIn("incident_monitors.monitor_tag", monitorTags)
      .andWhere("incidents.incident_type", "MAINTENANCE")
      .andWhere("incidents.status", "OPEN")
      .andWhere("incidents.start_date_time", ">", currentTimestamp)
      .andWhere("incidents.start_date_time", "<=", futureTimestamp)
      .orderBy("incidents.start_date_time", "asc");
  }

  async getLastMaintenanceByMonitorTags(monitorTags: string[]): Promise<IncidentRecord | undefined> {
    return await this.table("incidents")
      .distinct("incidents.*")
      .join("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .whereIn("incident_monitors.monitor_tag", monitorTags)
      .andWhere("incidents.incident_type", "MAINTENANCE")
      .andWhere("incidents.status", "OPEN")
      .orderBy("incidents.start_date_time", "desc")
      .first();
  }

  async getOngoingIncidentsByMonitorTags(
    timestamp: number,
    monitorTags: string[],
    incidentType: string,
  ): Promise<IncidentRecord[]> {
    return await this.table("incidents")
      .distinct("incidents.*")
      .join("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .whereIn("incident_monitors.monitor_tag", monitorTags)
      .andWhere("incidents.incident_type", incidentType)
      .andWhere("incidents.state", "!=", GC.RESOLVED)
      .andWhere("incidents.start_date_time", "<=", timestamp)
      .andWhere(function () {
        this.whereNull("incidents.end_date_time").orWhere("incidents.end_date_time", ">=", timestamp);
      })
      .orderBy("incidents.start_date_time", "desc");
  }

  async getOngoingIncidentsForMonitorList(timestamp: number, monitorTags: string[]): Promise<IncidentForMonitorList[]> {
    const rows = await this.table("incidents")
      .select(
        "incidents.id",
        "incidents.title",
        "incidents.start_date_time",
        "incidents.end_date_time",
        "incidents.created_at",
        "incidents.updated_at",
        "incidents.status",
        "incidents.state",
        "incident_monitors.monitor_impact",
        "incident_monitors.monitor_tag",
        "monitors.slug as monitor_slug",
        "monitors.name as monitor_name",
        "monitors.image as monitor_image",
      )
      .leftJoin("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .leftJoin("monitors", "incident_monitors.monitor_tag", "monitors.tag")
      .where(function () {
        this.whereIn("incident_monitors.monitor_tag", monitorTags).orWhere("incidents.is_global", "YES");
      })
      .andWhere("incidents.state", "!=", GC.RESOLVED)
      .andWhere("incidents.incident_type", GC.INCIDENT)
      .andWhere("incidents.start_date_time", "<=", timestamp)
      .andWhere(function () {
        this.whereNull("incidents.end_date_time").orWhere("incidents.end_date_time", ">=", timestamp);
      })
      .orderBy("incidents.start_date_time", "desc");

    return this.groupIncidentsByIdForMonitorList(rows);
  }

  /**
   * The component impacts open incidents currently declare, for page status.
   *
   * A separate, narrower query rather than a reuse of
   * `getOngoingIncidentsForMonitorList`, and the separation is the point: that
   * one exists to render the incident list and is called only when the page's
   * display settings say to show incidents. Deriving status from it would mean
   * an operator hiding the incident list also made the page report itself
   * healthy. What a page *is* and what it *shows* are different questions.
   *
   * Carries `impact_override` alongside each row so the caller can apply the
   * incident-level pin without a second query.
   */
  /**
   * The open incidents declaring an impact on these monitors, at this instant.
   *
   * `id` and `title` are selected for the admin's "why is this not green"
   * panel and ignored by `derivePageStatus`. Widening this query rather than
   * writing a second one is deliberate: an explanation assembled from its own
   * query eventually describes a different set of rows than the derivation
   * used, and a wrong explanation of a correct status is worse than none.
   */
  async getDeclaredIncidentImpacts(
    timestamp: number,
    monitorTags: string[],
  ): Promise<
    Array<{
      id: number;
      title: string | null;
      monitor_tag: string;
      monitor_impact: string | null;
      component_impact: string | null;
      impact_override: string | null;
    }>
  > {
    if (monitorTags.length === 0) return [];
    return await this.table("incidents")
      .select(
        "incidents.id",
        "incidents.title",
        "incident_monitors.monitor_tag",
        "incident_monitors.monitor_impact",
        "incident_monitors.component_impact",
        "incidents.impact_override",
      )
      .join("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .whereIn("incident_monitors.monitor_tag", monitorTags)
      .andWhere("incidents.state", "!=", GC.RESOLVED)
      .andWhere("incidents.incident_type", GC.INCIDENT)
      .andWhere("incidents.start_date_time", "<=", timestamp)
      .andWhere(function () {
        this.whereNull("incidents.end_date_time").orWhere("incidents.end_date_time", ">=", timestamp);
      });
  }

  async geAllGlobalOngoingIncidents(timestamp: number, tags?: string[]): Promise<IncidentForMonitorList[]> {
    const query = this.table("incidents")
      .select(
        "incidents.id",
        "incidents.title",
        "incidents.start_date_time",
        "incidents.end_date_time",
        "incidents.created_at",
        "incidents.updated_at",
        "incidents.status",
        "incidents.state",
        "incident_monitors.monitor_impact",
        "incident_monitors.monitor_tag",
        "monitors.slug as monitor_slug",
        "monitors.name as monitor_name",
        "monitors.image as monitor_image",
      )
      .leftJoin("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .leftJoin("monitors", "incident_monitors.monitor_tag", "monitors.tag");

    if (tags && tags.length > 0) {
      query.where(function () {
        this.whereIn("incident_monitors.monitor_tag", tags);
      });
    } else {
      query.where("incidents.is_global", "YES");
    }

    const rows = await query
      .andWhere("monitors.is_hidden", "NO")
      .andWhere("incidents.state", "!=", GC.RESOLVED)
      .andWhere("incidents.incident_type", GC.INCIDENT)
      .andWhere("incidents.start_date_time", "<=", timestamp)
      .andWhere(function () {
        this.whereNull("incidents.end_date_time").orWhere("incidents.end_date_time", ">=", timestamp);
      })
      .orderBy("incidents.start_date_time", "desc");

    return this.groupIncidentsByIdForMonitorList(rows);
  }

  async getOngoingIncidentsForMonitorListWithComments(
    timestamp: number,
    monitorTags: string[],
  ): Promise<IncidentForMonitorListWithComments[]> {
    const incidents = await this.getOngoingIncidentsForMonitorList(timestamp, monitorTags);

    if (incidents.length === 0) {
      return [];
    }

    const incidentIds = incidents.map((incident) => incident.id);
    const comments = await this.table("incident_comments")
      .select("*")
      .whereIn("incident_id", incidentIds)
      .andWhere("status", "ACTIVE")
      .orderBy("commented_at", "desc")
      .orderBy("id", "desc");

    const commentsByIncidentId = new Map<number, IncidentCommentRecord[]>();
    for (const comment of comments) {
      const existing = commentsByIncidentId.get(comment.incident_id) || [];
      existing.push(comment);
      commentsByIncidentId.set(comment.incident_id, existing);
    }

    return incidents.map((incident) => ({
      ...incident,
      comments: commentsByIncidentId.get(incident.id) || [],
    }));
  }
  async getAllGlobalOngoingIncidentsWithComments(
    timestamp: number,
    tags?: string[],
  ): Promise<IncidentForMonitorListWithComments[]> {
    const incidents = await this.geAllGlobalOngoingIncidents(timestamp, tags);

    if (incidents.length === 0) {
      return [];
    }

    const incidentIds = incidents.map((incident) => incident.id);
    const comments = await this.table("incident_comments")
      .select("*")
      .whereIn("incident_id", incidentIds)
      .andWhere("status", "ACTIVE")
      .orderBy("commented_at", "desc")
      .orderBy("id", "desc");

    const commentsByIncidentId = new Map<number, IncidentCommentRecord[]>();
    for (const comment of comments) {
      const existing = commentsByIncidentId.get(comment.incident_id) || [];
      existing.push(comment);
      commentsByIncidentId.set(comment.incident_id, existing);
    }

    return incidents.map((incident) => ({
      ...incident,
      comments: commentsByIncidentId.get(incident.id) || [],
    }));
  }

  async getResolvedIncidentsForMonitorList(
    timestamp: number,
    monitorTags: string[],
    limit: number,
    daysInPast: number,
  ): Promise<IncidentForMonitorList[]> {
    const pastTimestamp = timestamp - daysInPast * 24 * 60 * 60;

    // First get distinct incident IDs with limit
    const incidentIds = await this.table("incidents")
      .distinct("incidents.id")
      .leftJoin("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .where(function () {
        this.whereIn("incident_monitors.monitor_tag", monitorTags).orWhere("incidents.is_global", "YES");
      })
      .andWhere("incidents.state", GC.RESOLVED)
      .andWhere("incidents.incident_type", GC.INCIDENT)
      .andWhere("incidents.end_date_time", ">=", pastTimestamp)
      .andWhere("incidents.end_date_time", "<=", timestamp)
      .orderBy("incidents.id", "desc")
      .limit(limit)
      .pluck("incidents.id");

    if (incidentIds.length === 0) {
      return [];
    }

    const rows = await this.table("incidents")
      .select(
        "incidents.id",
        "incidents.title",
        "incidents.start_date_time",
        "incidents.end_date_time",
        "incidents.created_at",
        "incidents.updated_at",
        "incidents.status",
        "incidents.state",
        "incident_monitors.monitor_impact",
        "incident_monitors.monitor_tag",
        "monitors.slug as monitor_slug",
        "monitors.name as monitor_name",
        "monitors.image as monitor_image",
      )
      .leftJoin("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .leftJoin("monitors", "incident_monitors.monitor_tag", "monitors.tag")
      .whereIn("incidents.id", incidentIds)
      .orderBy("incidents.end_date_time", "desc");

    return this.groupIncidentsByIdForMonitorList(rows);
  }

  async getResolvedIncidentsForMonitorListWithComments(
    timestamp: number,
    monitorTags: string[],
    limit: number,
    daysInPast: number,
  ): Promise<IncidentForMonitorListWithComments[]> {
    const incidents = await this.getResolvedIncidentsForMonitorList(timestamp, monitorTags, limit, daysInPast);

    if (incidents.length === 0) {
      return [];
    }

    const incidentIds = incidents.map((incident) => incident.id);
    const comments = await this.table("incident_comments")
      .select("*")
      .whereIn("incident_id", incidentIds)
      .andWhere("status", "ACTIVE")
      .orderBy("commented_at", "desc")
      .orderBy("id", "desc");

    const commentsByIncidentId = new Map<number, IncidentCommentRecord[]>();
    for (const comment of comments) {
      const existing = commentsByIncidentId.get(comment.incident_id) || [];
      existing.push(comment);
      commentsByIncidentId.set(comment.incident_id, existing);
    }
    return incidents.map((incident) => ({
      ...incident,
      comments: commentsByIncidentId.get(incident.id) || [],
    }));
  }

  async getLastIncidentByMonitorTags(monitorTags: string[]): Promise<IncidentRecord | undefined> {
    return await this.table("incidents")
      .distinct("incidents.*")
      .join("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .whereIn("incident_monitors.monitor_tag", monitorTags)
      .andWhere("incidents.incident_type", "INCIDENT")
      .andWhere("incidents.status", "OPEN")
      .orderBy("incidents.start_date_time", "desc")
      .first();
  }

  async getIncidentsCountByTypeAndDateRangeAndMonitorTags(
    incident_type: string,
    start_date: number,
    end_date: number,
    monitorTags: string[],
  ): Promise<CountResult | undefined> {
    return await this.table("incidents")
      .countDistinct("incidents.id as count")
      .join("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .whereIn("incident_monitors.monitor_tag", monitorTags)
      .andWhere("incidents.incident_type", incident_type)
      .andWhere("incidents.start_date_time", ">=", start_date)
      .andWhere("incidents.start_date_time", "<=", end_date)
      .first<CountResult>();
  }

  // ============ Incident Monitors ============

  async insertIncidentMonitor(data: IncidentMonitorRecordInsert): Promise<number[]> {
    return await this.table("incident_monitors").insert({
      monitor_tag: data.monitor_tag,
      monitor_impact: data.monitor_impact,
      incident_id: data.incident_id,
    });
  }

  async getIncidentMonitorsByIncidentID(
    incident_id: number,
  ): Promise<Array<{ monitor_tag: string; monitor_impact: string | null; component_impact: string | null }>> {
    return await this.table("incident_monitors")
      .select("monitor_tag", "monitor_impact", "component_impact")
      .where("incident_id", incident_id);
  }

  /**
   * Monitors for several incidents in one query.
   *
   * The dashboard used to call getIncidentMonitorsByIncidentID per row; this is
   * the same data with a constant query count. Rows carry incident_id so the
   * caller can group them.
   */
  async getIncidentMonitorsByIncidentIDs(
    incident_ids: number[],
  ): Promise<
    Array<{ incident_id: number; monitor_tag: string; monitor_impact: string | null; component_impact: string | null }>
  > {
    if (incident_ids.length === 0) return [];
    return await this.table("incident_monitors")
      .select("incident_id", "monitor_tag", "monitor_impact", "component_impact")
      .whereIn("incident_id", incident_ids);
  }

  async getIncidentMonitors(filter?: { incident_id?: number; monitor_tag?: string }): Promise<IncidentMonitorRecord[]> {
    let query = this.table("incident_monitors").select("*");

    if (filter?.incident_id) {
      query = query.where("incident_id", filter.incident_id);
    }

    if (filter?.monitor_tag) {
      query = query.where("monitor_tag", filter.monitor_tag);
    }

    return await query;
  }

  async getMonitorsByIncidentId(incident_id: number): Promise<IncidentMonitorDetailRecord[]> {
    return await this.table("incident_monitors")
      .join("monitors", "incident_monitors.monitor_tag", "monitors.tag")
      .where("incident_monitors.incident_id", incident_id)
      .select(
        "incident_monitors.*",
        "monitors.slug as monitor_slug",
        "monitors.name as monitor_name",
        "monitors.image as monitor_image",
        "monitors.description as monitor_description",
      );
  }

  async removeIncidentMonitor(incident_id: number, monitor_tag: string): Promise<number> {
    return await this.table("incident_monitors").where({ incident_id, monitor_tag }).del();
  }

  async insertIncidentMonitorWithMerge(data: IncidentMonitorRecordInsert): Promise<number[]> {
    return await this.table("incident_monitors")
      .insert({
        monitor_tag: data.monitor_tag,
        monitor_impact: data.monitor_impact,
        component_impact: data.component_impact,
        incident_id: data.incident_id,
      })
      .onConflict(["monitor_tag", "incident_id"])
      // Both layers on the merge, not just the mechanical one. An operator
      // moving a component from Partial Outage to Degraded Performance leaves
      // `monitor_impact` at DEGRADED - the timeline genuinely does not change -
      // so merging only that column would silently discard the change the
      // customer was going to read about.
      .merge({
        monitor_impact: data.monitor_impact,
        component_impact: data.component_impact,
        updated_at: this.knexUnscoped.fn.now(),
      });
  }

  async deleteIncidentMonitorsByTag(tag: string): Promise<number> {
    return await this.table("incident_monitors").where("monitor_tag", tag).del();
  }

  // ============ Incident Comments ============

  async insertIncidentComment(
    incident_id: number,
    comment: string,
    state: string,
    commented_at: number,
  ): Promise<IncidentCommentRecord> {
    const dbType = GetDbType();

    const insertData = {
      comment,
      incident_id,
      state,
      commented_at,
      created_at: this.knexUnscoped.fn.now(),
      updated_at: this.knexUnscoped.fn.now(),
    };

    if (dbType === "postgresql") {
      const [createdComment] = await this.table("incident_comments").insert(insertData).returning("*");
      return createdComment;
    } else {
      const result = await this.table("incident_comments").insert(insertData);
      const id = result[0];
      const createdComment = await this.table("incident_comments").where("id", id).first();
      return createdComment;
    }
  }

  async getIncidentComments(incident_id: number): Promise<IncidentCommentRecord[]> {
    return await this.table("incident_comments").where("incident_id", incident_id).orderBy("commented_at", "desc");
  }

  async getActiveIncidentComments(incident_id: number): Promise<IncidentCommentRecord[]> {
    return await this.table("incident_comments")
      .where("incident_id", incident_id)
      .andWhere("status", "ACTIVE")
      .orderBy("commented_at", "desc")
      .orderBy("id", "desc");
  }

  async getIncidentCommentByIDAndIncident(incident_id: number, id: number): Promise<IncidentCommentRecord | undefined> {
    return await this.table("incident_comments").where({ incident_id, id }).first();
  }

  async updateIncidentCommentByID(id: number, comment: string, state: string, commented_at: number): Promise<number> {
    return await this.table("incident_comments").where({ id }).update({
      comment,
      state,
      commented_at,
      updated_at: this.knexUnscoped.fn.now(),
    });
  }

  async updateIncidentCommentStatusByID(id: number, status: string): Promise<number> {
    return await this.table("incident_comments").where({ id }).update({
      status,
      updated_at: this.knexUnscoped.fn.now(),
    });
  }

  async getIncidentCommentByID(id: number): Promise<IncidentCommentRecord | undefined> {
    return await this.table("incident_comments").where({ id }).first();
  }

  async deleteIncidentCommentsByIncidentID(incident_id: number): Promise<number> {
    return await this.table("incident_comments").where({ incident_id }).del();
  }

  /**
   * Get incidents within a date range for the events page
   * Returns incidents that started within the given date range
   * Includes all incidents, but filters out hidden monitors from monitors array
   */
  async getIncidentsForEventsByDateRange(
    startTs: number,
    endTs: number,
    monitorTags?: string[],
  ): Promise<IncidentForMonitorListWithComments[]> {
    const query = this.table("incidents")
      .select(
        "incidents.id",
        "incidents.title",
        "incidents.start_date_time",
        "incidents.end_date_time",
        "incidents.created_at",
        "incidents.updated_at",
        "incidents.status",
        "incidents.state",
        "incident_monitors.monitor_impact",
        "incident_monitors.monitor_tag",
        "monitors.slug as monitor_slug",
        "monitors.name as monitor_name",
        "monitors.image as monitor_image",
        "monitors.is_hidden as monitor_is_hidden",
      )
      .leftJoin("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .leftJoin("monitors", "incident_monitors.monitor_tag", "monitors.tag")
      .where("incidents.incident_type", GC.INCIDENT)
      .andWhere("incidents.status", "OPEN")
      .andWhere("incidents.start_date_time", ">=", startTs)
      .andWhere("incidents.start_date_time", "<=", endTs);

    if (monitorTags) {
      query.andWhere(function () {
        this.whereIn("incident_monitors.monitor_tag", monitorTags).orWhere("incidents.is_global", "YES");
      });
    }

    const rows = await query.orderBy("incidents.start_date_time", "desc");

    const incidents = this.groupIncidentsByIdForMonitorListFilterHidden(rows);

    if (incidents.length === 0) {
      return [];
    }

    const incidentIds = incidents.map((incident) => incident.id);
    const comments = await this.table("incident_comments")
      .select("*")
      .whereIn("incident_id", incidentIds)
      .andWhere("status", "ACTIVE")
      .orderBy("commented_at", "desc")
      .orderBy("id", "desc");

    const commentsByIncidentId = new Map<number, IncidentCommentRecord[]>();
    for (const comment of comments) {
      const existing = commentsByIncidentId.get(comment.incident_id) || [];
      existing.push(comment);
      commentsByIncidentId.set(comment.incident_id, existing);
    }

    return incidents.map((incident) => ({
      ...incident,
      comments: commentsByIncidentId.get(incident.id) || [],
    }));
  }

  async getIncidentsForEventsByDateRangeMonitor(
    startTs: number,
    endTs: number,
    monitorTag: string,
  ): Promise<IncidentForMonitorListWithComments[]> {
    const rows = await this.table("incidents")
      .select(
        "incidents.id",
        "incidents.title",
        "incidents.start_date_time",
        "incidents.end_date_time",
        "incidents.created_at",
        "incidents.updated_at",
        "incidents.status",
        "incidents.state",
        "incident_monitors.monitor_impact",
        "incident_monitors.monitor_tag",
        "monitors.slug as monitor_slug",
        "monitors.name as monitor_name",
        "monitors.image as monitor_image",
        "monitors.is_hidden as monitor_is_hidden",
      )
      .leftJoin("incident_monitors", "incidents.id", "incident_monitors.incident_id")
      .leftJoin("monitors", "incident_monitors.monitor_tag", "monitors.tag")
      .where("incidents.incident_type", GC.INCIDENT)
      .andWhere("incident_monitors.monitor_tag", monitorTag)
      .andWhere("incidents.status", "OPEN")
      .andWhere("incidents.start_date_time", ">=", startTs)
      .andWhere("incidents.start_date_time", "<=", endTs)
      .orderBy("incidents.start_date_time", "desc");

    const incidents = this.groupIncidentsByIdForMonitorListFilterHidden(rows);

    if (incidents.length === 0) {
      return [];
    }

    const incidentIds = incidents.map((incident) => incident.id);
    const comments = await this.table("incident_comments")
      .select("*")
      .whereIn("incident_id", incidentIds)
      .andWhere("status", "ACTIVE")
      .orderBy("commented_at", "desc")
      .orderBy("id", "desc");

    const commentsByIncidentId = new Map<number, IncidentCommentRecord[]>();
    for (const comment of comments) {
      const existing = commentsByIncidentId.get(comment.incident_id) || [];
      existing.push(comment);
      commentsByIncidentId.set(comment.incident_id, existing);
    }

    return incidents.map((incident) => ({
      ...incident,
      comments: commentsByIncidentId.get(incident.id) || [],
    }));
  }

  /**
   * Group raw incident rows by incident ID, aggregating monitors into an array
   * Filters out hidden monitors
   */
  private groupIncidentsByIdForMonitorListFilterHidden(rows: any[]): IncidentForMonitorList[] {
    const incidentMap = new Map<number, IncidentForMonitorList>();

    for (const row of rows) {
      if (!incidentMap.has(row.id)) {
        incidentMap.set(row.id, {
          id: row.id,
          title: row.title,
          start_date_time: row.start_date_time,
          end_date_time: row.end_date_time,
          created_at: row.created_at,
          updated_at: row.updated_at,
          status: row.status,
          state: row.state,
          monitors: [],
        });
      }

      const incident = incidentMap.get(row.id)!;
      // Only add monitor if it exists and is not hidden
      if (row.monitor_tag && row.monitor_is_hidden !== "YES") {
        incident.monitors.push({
          monitor_tag: row.monitor_tag,
          monitor_impact: row.monitor_impact,
          monitor_slug: row.monitor_slug ?? row.monitor_tag,
          monitor_name: row.monitor_name,
          monitor_image: row.monitor_image,
        });
      }
    }

    return Array.from(incidentMap.values());
  }

  // ============ C2c lifecycle timestamps: re-runnable backfill ============

  /**
   * Recomputes the lifecycle timestamps from evidence still in the database.
   *
   * **Why this exists at all, which is the whole point of the bug it fixes.**
   * The original backfill lived inside migration
   * `20260909170000_add_incident_lifecycle_timestamps`, and migrations run
   * before seeds everywhere - `preseed`, `predev`, and `scripts/main.ts`. On a
   * fresh install it therefore swept an *empty* `incidents` table, wrote
   * nothing, and knex marked it done forever. Every incident that arrived
   * afterwards - by seed, by C7 import, by restoring a dump onto an already
   * migrated schema - kept null timestamps permanently, and nothing could ever
   * recompute them. The Response Timeline read "Not recorded" on every row.
   *
   * **The general lesson, worth more than the fix:** a data backfill inside a
   * migration is only ever correct for a database that already held the data
   * when that one migration ran. Any backfill that could matter to an install
   * populated later belongs in a re-runnable routine like this one.
   *
   * **Only ever fills a column that is currently NULL.** That is what makes
   * re-running it safe, and it is what lets it be a button: it can never
   * overwrite a stamp that a live transition or a human produced, so a second
   * run cannot disagree with the first.
   *
   * The derivation rules are transcribed from the migration deliberately
   * unchanged, including the `end_date_time` fallback, so an instance that did
   * get the migration's backfill and an instance that gets this one hold the
   * same values.
   *
   * Org scoping comes from `this.table`: the admin action runs inside one org
   * and touches only that org's incidents, while the CLI sweeps every org by
   * wrapping the call in `runAcrossOrgs`.
   */
  async backfillLifecycleTimestamps(incidentId?: number): Promise<LifecycleBackfillCounts> {
    const counts: LifecycleBackfillCounts = {
      incidents_considered: 0,
      detected_at: 0,
      identified_at: 0,
      mitigated_at: 0,
      resolved_at: 0,
    };

    // Only incidents actually missing something. Narrowing the candidate set
    // changes no computed value - it skips rows the writes would no-op on - and
    // keeps a whole-instance sweep from loading every alert ever raised.
    const pendingQuery = this.table("incidents")
      .where((q) =>
        q
          .whereNull("detected_at")
          .orWhereNull("identified_at")
          .orWhereNull("mitigated_at")
          .orWhereNull("resolved_at"),
      )
      .select("id");
    if (incidentId !== undefined) pendingQuery.where("id", incidentId);

    const pending: Array<{ id: number }> = await pendingQuery;
    const ids = pending.map((row) => row.id);
    counts.incidents_considered = ids.length;
    if (ids.length === 0) return counts;

    counts.detected_at = await this.fillDetectedAt(ids);

    const commentRules: Array<[string, LifecycleColumn, "min" | "max"]> = [
      [GC.IDENTIFIED, "identified_at", "min"],
      [GC.MONITORING, "mitigated_at", "min"],
      [GC.RESOLVED, "resolved_at", "max"],
    ];
    for (const [state, column, aggregate] of commentRules) {
      counts[column] += await this.fillFromComments(ids, state, column, aggregate);
    }

    // An incident closed without a RESOLVED comment - closed from the API, or by
    // an alert that set the end time directly - still resolved, and
    // `end_date_time` is when. After the comment pass and guarded on null, so a
    // real RESOLVED comment always wins over the coarser fallback.
    for (const chunk of chunked(ids)) {
      counts.resolved_at += await this.table("incidents")
        .whereIn("id", chunk)
        .whereNull("resolved_at")
        .whereNotNull("end_date_time")
        .update({ resolved_at: this.knexUnscoped.ref("end_date_time") });
    }

    return counts;
  }

  /**
   * `detected_at` from the earliest alert, and only the earliest.
   *
   * An incident may have collected several alert rows over its life - a config
   * that re-fires, a second monitor joining the same incident - and detection is
   * the first of them, not the last.
   *
   * A dashboard-created incident gets null, because no machine observed it.
   * `metrics.ts` falls back to `start_date_time` for the MTTR arithmetic, so a
   * manual incident still produces a number, and MTTD stays null for it because
   * there genuinely was no detection to measure.
   *
   * Folded in JavaScript rather than with SQL `min()` because `created_at` is a
   * driver-dependent shape: a `Date` on Postgres and MySQL, naive text on
   * SQLite, epoch milliseconds where a `Date` was bound on insert. See
   * `alertCreatedAtSeconds`.
   */
  private async fillDetectedAt(ids: number[]): Promise<number> {
    const earliest = new Map<number, number>();

    for (const chunk of chunked(ids)) {
      const alerts = await this.table<{ incident_id: number; created_at: unknown }>("monitor_alerts_v2")
        .whereIn("incident_id", chunk)
        .select("incident_id", "created_at");

      for (const row of alerts) {
        const seconds = alertCreatedAtSeconds(row.created_at);
        if (seconds === null) continue;
        const current = earliest.get(row.incident_id);
        if (current === undefined || seconds < current) earliest.set(row.incident_id, seconds);
      }
    }

    let filled = 0;
    for (const [id, seconds] of earliest) {
      filled += await this.table("incidents").where("id", id).whereNull("detected_at").update({ detected_at: seconds });
    }
    return filled;
  }

  /**
   * One lifecycle column from the incident's own comments.
   *
   * **MIN for the first two, MAX for resolution, and the asymmetry is the
   * point.** An incident that went IDENTIFIED, slipped back to INVESTIGATING and
   * was identified again was identified at the first one: identification is a
   * thing you learn and do not unlearn. Resolution is not - an incident that was
   * resolved, reopened and resolved again was actually over at the *second* one,
   * and taking the first would report an MTTR that ends before the outage did.
   */
  private async fillFromComments(
    ids: number[],
    state: string,
    column: LifecycleColumn,
    aggregate: "min" | "max",
  ): Promise<number> {
    let filled = 0;

    for (const chunk of chunked(ids)) {
      const base = this.table("incident_comments")
        .whereIn("incident_id", chunk)
        .where("state", state)
        .groupBy("incident_id")
        .select("incident_id");
      const rows: Array<{ incident_id: number; at: number | string }> =
        aggregate === "min" ? await base.min({ at: "commented_at" }) : await base.max({ at: "commented_at" });

      for (const row of rows) {
        const seconds = typeof row.at === "string" ? parseInt(row.at, 10) : row.at;
        if (!Number.isFinite(seconds)) continue;

        const query = this.table("incidents").where("id", row.incident_id).whereNull(column);
        // Only for an incident that is actually closed. A reopened incident has
        // a RESOLVED comment in its history and is not resolved now; writing
        // `resolved_at` on it would make an open incident report an MTTR, and
        // every "incidents resolved this month" count would include one that is
        // still running.
        if (column === "resolved_at") query.whereNotNull("end_date_time");

        filled += await query.update({ [column]: seconds });
      }
    }

    return filled;
  }
}
