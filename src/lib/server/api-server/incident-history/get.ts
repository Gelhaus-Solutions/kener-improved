import { json, error } from "@sveltejs/kit";
import type { APIServerRequest } from "$lib/server/types/api-server";
import type { IncidentForMonitorListWithComments } from "$lib/server/types/db";
import type { PublicIncidentCursor } from "$lib/server/db/repositories/incidents";
import db from "$lib/server/db/db";
import { GetAllSiteData } from "$lib/server/controllers/siteDataController";

// G7. The public, searchable, keyset-paged incident history.
//
// Org scoping is not done here and must not be: `db.getPublicIncidentsPaginated`
// goes through `BaseRepository.table()`, under the org that `orgResolveHandle`
// established from the hostname. Visibility (published incidents only, this
// page's monitors only, active comments only) lives in the repository beside the
// query it constrains, so this handler cannot forget half of it.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Longer than any real search and short enough that nothing pathological reaches the database. */
const MAX_SEARCH_LENGTH = 200;

export interface IncidentHistoryResponse {
  incidents: IncidentForMonitorListWithComments[];
  /** Opaque to the client: pass it back verbatim as `?cursor=`. */
  nextCursor: string | null;
}

/**
 * The cursor is encoded rather than passed as two numbers.
 *
 * Not for secrecy - it is a timestamp and a row id, both already visible in the
 * response. It is so the client treats it as opaque and the server can change
 * what a position means without every bookmarked URL becoming wrong in a way
 * that silently returns the wrong page.
 */
function encodeCursor(cursor: PublicIncidentCursor): string {
  return Buffer.from(`${cursor.startDateTime}:${cursor.id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): PublicIncidentCursor | null {
  if (!raw) return null;
  try {
    const [ts, id] = Buffer.from(raw, "base64url").toString("utf8").split(":");
    const startDateTime = Number(ts);
    const parsedId = Number(id);
    if (!Number.isFinite(startDateTime) || !Number.isFinite(parsedId)) return null;
    return { startDateTime, id: parsedId };
  } catch {
    // A malformed cursor starts from the beginning rather than erroring: it is
    // almost always a truncated or hand-edited URL, and the first page is a
    // better answer than a 400 on a public page.
    return null;
  }
}

export default async function get(req: APIServerRequest): Promise<Response> {
  const query = req.query;

  const rawPagePath = query.get("page_path");
  let pagePath = rawPagePath?.trim() || null;
  if (pagePath && ["undefined", "null"].includes(pagePath.toLowerCase())) pagePath = null;

  // Same rule the events endpoint applies: with exclusivity on, an unspecified
  // page means the home page rather than "every page".
  const siteData = await GetAllSiteData();
  if (siteData.globalPageVisibilitySettings?.forceExclusivity && pagePath === null) pagePath = "";

  let monitorTags: string[] | undefined;
  if (pagePath !== null) {
    const page = await db.getPageByPath(pagePath);
    if (!page) return error(404, { message: "Page not found" });
    // Excludes hidden and inactive monitors, which is what makes this the
    // page's *public* component list rather than its configured one.
    const monitors = await db.getPageMonitorsExcludeHidden(page.id);
    monitorTags = monitors.map((m) => m.monitor_tag);
  }

  const limitParam = Number(query.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(MAX_LIMIT, limitParam) : DEFAULT_LIMIT;

  const search = (query.get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH) || undefined;

  const startParam = Number(query.get("start_ts"));
  const endParam = Number(query.get("end_ts"));
  const start = Number.isFinite(startParam) && startParam > 0 ? startParam : undefined;
  const end = Number.isFinite(endParam) && endParam > 0 ? endParam : undefined;

  const state = query.get("state")?.trim() || undefined;

  const page = await db.getPublicIncidentsPaginated({
    monitorTags,
    search,
    start,
    end,
    state,
    cursor: decodeCursor(query.get("cursor")),
    limit,
  });

  const response: IncidentHistoryResponse = {
    incidents: page.incidents,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
  };
  return json(response);
}
