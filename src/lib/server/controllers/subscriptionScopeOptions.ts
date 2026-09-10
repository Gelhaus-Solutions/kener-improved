import db from "../db/db.js";
import { isPubliclyVisible } from "./publicMonitorResolver.js";

/**
 * What the subscribe dialog can offer as a scope on the page it is standing on (E1b).
 *
 * **Why the server works this out rather than the dialog.** E1 left the pickers
 * unbuilt because `SubscribeMenu` takes one prop and has no idea which page it is
 * on, and threading page context down from every call site is a change to the
 * public layout rather than to the subscribe dialog. It does not have to be: the
 * dialog already knows its own URL, so it can send the path and be told what that
 * page contains. No call site changes, and the answer is authoritative rather
 * than assembled from whatever each route happened to put in `page.data`.
 *
 * **A PAGE scope is matched by numeric page id** in
 * `getRecipientsForScopedEvent`, and the public page list carries only paths, so
 * the id has to come from here as well.
 */
export interface ScopeOptions {
  page: { id: number; title: string } | null;
  components: Array<{ tag: string; name: string }>;
}

/**
 * The empty answer, which is also what an unknown path gets.
 *
 * Deliberately not an error: a subscriber opening the dialog from the events page
 * or a maintenance page should still get their severity floor and their on/off
 * switches, just without pickers. A 400 there would break a working screen to
 * report a missing optional.
 */
const NOTHING: ScopeOptions = { page: null, components: [] };

export async function GetScopeOptionsForPage(pagePath?: string): Promise<ScopeOptions> {
  // The home page is stored with an empty `page_path`, so an absent parameter and
  // the empty string are different questions: absent means "the dialog did not
  // say", empty means "the home page". Only the first declines to answer.
  if (pagePath === undefined || pagePath === null) return NOTHING;

  const page = await db.getPageByPath(pagePath);
  if (!page) return NOTHING;

  // Excludes hidden and inactive monitors, the same rule every other public
  // surface applies (KENER-126). Offering a subscription to a monitor the
  // visitor cannot see would name it on a public screen.
  const pageMonitors = await db.getPageMonitorsExcludeHidden(page.id);
  const tags = pageMonitors.map((m) => m.monitor_tag);
  const monitors = tags.length > 0 ? await db.getMonitorsByTags(tags) : [];
  const nameByTag = new Map(monitors.filter(isPubliclyVisible).map((m) => [m.tag, m.name]));

  return {
    page: { id: page.id, title: page.page_title },
    // Ordered by the page's own ordering, which `getPageMonitorsExcludeHidden`
    // already applies, so the picker reads in the same order as the page.
    components: tags.filter((tag) => nameByTag.has(tag)).map((tag) => ({ tag, name: nameByTag.get(tag) as string })),
  };
}
