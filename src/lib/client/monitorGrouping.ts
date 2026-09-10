import GC from "$lib/global-constants";
import { CollapseStatusCounts } from "$lib/clientTools";
import type { StatusType } from "$lib/types/status";

// G1/G2: the filtering and grouping the public page does entirely in the browser.
//
// Pure functions in their own module rather than logic inside the component, for
// one reason: the ordering rule and the group summary are the two things most
// likely to be quietly wrong, and neither is observable by looking at a rendered
// page unless you already know what it should say. Here they are unit tested.

/** The chip that means "no filter". Not a status, so it cannot collide with one. */
export const ALL_FILTER = "ALL";

export type StatusFilter = typeof ALL_FILTER | StatusType;

/**
 * The key the uncategorised section is collected under.
 *
 * It begins with a space, which is what makes it collision-proof: every category
 * is trimmed before it is used as a key, so no real `category_name` can produce
 * this string. That matters because the category is a value a customer types,
 * and one who names a category "Uncategorised" must not have it silently merged
 * with the monitors that have no category at all.
 */
export const UNCATEGORISED_KEY = " uncategorised";

export interface MonitorGroup {
  /** The category name, or `UNCATEGORISED_KEY`. Stable, used as the `{#each}` key. */
  key: string;
  /** The category name, or null for the uncategorised section. */
  label: string | null;
  tags: string[];
}

/**
 * The worst status among some monitors, by the same collapse the bars use.
 *
 * **Reusing `CollapseStatusCounts` is the point, not a convenience.** The group
 * summary and the individual bars have to agree, and the only way to guarantee
 * that by construction rather than by convention is to run the same function.
 * Writing a fresh `Math.max` over a severity array here would be shorter and
 * would drift the first time ADR 0007's collapse changed.
 *
 * A monitor whose bar data has not arrived yet contributes nothing, so a group
 * reads NO_DATA until its first member loads rather than briefly claiming to be
 * healthy.
 */
export function summariseStatuses(statuses: Array<StatusType | undefined | null>): StatusType {
  const counts = { countOfUp: 0, countOfDown: 0, countOfDegraded: 0, countOfMaintenance: 0 };
  for (const status of statuses) {
    if (status === GC.UP) counts.countOfUp++;
    else if (status === GC.DOWN) counts.countOfDown++;
    else if (status === GC.DEGRADED) counts.countOfDegraded++;
    else if (status === GC.MAINTENANCE) counts.countOfMaintenance++;
  }
  return CollapseStatusCounts(counts);
}

/**
 * Groups tags by category.
 *
 * **Group order is first appearance; member order is untouched.** `monitorTags`
 * arrives in `pages_monitors.position` order, which is an arrangement an operator
 * made by hand on the page screen. Sorting groups alphabetically would silently
 * override it, and a page ordered by blast radius would come back ordered by
 * name. So a group sits where its first member sat, and within a group the
 * monitors keep the order they were given.
 *
 * **The uncategorised section is pinned last**, which is the one deliberate
 * exception to first appearance: it is a section the operator never named, and
 * dropping it into the middle of sections they did name reads as a mistake.
 */
export function groupByCategory(tags: string[], categoriesByTag: Record<string, string | null>): MonitorGroup[] {
  const byKey = new Map<string, MonitorGroup>();

  for (const tag of tags) {
    const raw = categoriesByTag[tag];
    const category = typeof raw === "string" ? raw.trim() : "";
    const key = category.length > 0 ? category : UNCATEGORISED_KEY;

    let group = byKey.get(key);
    if (!group) {
      group = { key, label: key === UNCATEGORISED_KEY ? null : category, tags: [] };
      byKey.set(key, group);
    }
    group.tags.push(tag);
  }

  // Map iteration is insertion order, which *is* first appearance. Only the
  // uncategorised section is moved.
  const groups = Array.from(byKey.values());
  const named = groups.filter((g) => g.key !== UNCATEGORISED_KEY);
  const uncategorised = groups.filter((g) => g.key === UNCATEGORISED_KEY);
  return [...named, ...uncategorised];
}

/**
 * How many monitors sit at each status, for the chip labels.
 *
 * Absent statuses are absent from the result rather than present with zero, so
 * the caller renders a chip per key without having to filter: a healthy page
 * shows one chip, not four disabled ones.
 */
export function countByStatus(
  tags: string[],
  statusByTag: Record<string, StatusType | undefined>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tag of tags) {
    const status = statusByTag[tag];
    if (!status) continue;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/**
 * The tags a filter leaves visible.
 *
 * **A monitor whose data has not arrived is kept, not hidden.** The bars load
 * asynchronously, so filtering on a status nothing has yet would empty the page
 * for a moment and then refill it. Keeping unknowns visible means the filter
 * only ever removes monitors it can positively rule out.
 */
export function applyStatusFilter(
  tags: string[],
  statusByTag: Record<string, StatusType | undefined>,
  filter: StatusFilter,
): string[] {
  if (filter === ALL_FILTER) return tags;
  return tags.filter((tag) => {
    const status = statusByTag[tag];
    return status === undefined || status === filter;
  });
}

/** Whether `value` is a filter this page could apply, for reading one off the URL. */
export function isStatusFilter(value: string | null | undefined): value is StatusFilter {
  if (!value) return false;
  return (
    value === ALL_FILTER ||
    value === GC.UP ||
    value === GC.DOWN ||
    value === GC.DEGRADED ||
    value === GC.MAINTENANCE ||
    value === GC.NO_DATA
  );
}
