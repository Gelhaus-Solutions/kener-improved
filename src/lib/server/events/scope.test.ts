import { describe, it, expect } from "vitest";
import { endpointAcceptsEvent, type EndpointScope, type EventScopeSubject } from "./scope.js";

/**
 * E11 part 3. The rule that decides whether a scoped endpoint gets an event.
 *
 * **The decision under test is what happens to an event a scope cannot judge**,
 * which the item flagged as the trap: `page.status_changed` has a page,
 * `probe.connected` has an agent, `report.delivered` has neither. Enno's rule is
 * that a scope narrows what it can judge and abstains on what it cannot, so
 * those are DELIVERED. Withholding them silently is the bug nobody reports,
 * because nothing arrives to report.
 *
 * `null` on the subject means "this event has no such dimension", which is
 * carried all the way from the resolver rather than being flattened into an
 * empty array, because an empty array would be indistinguishable from a
 * dimension that exists and matched nothing.
 */

const unscoped: EndpointScope = { monitorTags: [], pageSlugs: [] };
const monitorScoped: EndpointScope = { monitorTags: ["api", "checkout"], pageSlugs: [] };
const pageScoped: EndpointScope = { monitorTags: [], pageSlugs: ["/status"] };
const bothScoped: EndpointScope = { monitorTags: ["api"], pageSlugs: ["/status"] };

const about = (monitorTags: string[] | null, pageSlugs: string[] | null = null): EventScopeSubject => ({
  monitorTags,
  pageSlugs,
});

const unscopeable = about(null, null);

describe("an unscoped endpoint is unaffected", () => {
  // The guarantee that makes this change safe to ship: an operator who never
  // opens the scope UI sees exactly the behaviour they had before.
  it("takes everything it is subscribed to", () => {
    expect(endpointAcceptsEvent(unscoped, about(["anything"]))).toBe(true);
    expect(endpointAcceptsEvent(unscoped, about([]))).toBe(true);
    expect(endpointAcceptsEvent(unscoped, unscopeable)).toBe(true);
    expect(endpointAcceptsEvent(unscoped, about(null, ["/status"]))).toBe(true);
  });
});

describe("a monitor scope filters events that have a monitor", () => {
  it("delivers an event about a monitor in the scope", () => {
    expect(endpointAcceptsEvent(monitorScoped, about(["api"]))).toBe(true);
  });

  it("withholds an event about a monitor outside the scope", () => {
    expect(endpointAcceptsEvent(monitorScoped, about(["billing"]))).toBe(false);
  });

  // An incident spanning several components reaches anybody who owns any of
  // them. Requiring all of them would mean a shared outage notified nobody.
  it("delivers when any one of several monitors is in the scope", () => {
    expect(endpointAcceptsEvent(monitorScoped, about(["billing", "api", "search"]))).toBe(true);
  });

  it("withholds when none of several monitors is in the scope", () => {
    expect(endpointAcceptsEvent(monitorScoped, about(["billing", "search"]))).toBe(false);
  });
});

// THE DECISION. These are the events the item warned would vanish silently.
describe("an event a scope cannot judge is delivered, not withheld", () => {
  it("delivers an event with no monitor and no page at all", () => {
    expect(endpointAcceptsEvent(monitorScoped, unscopeable)).toBe(true);
    expect(endpointAcceptsEvent(pageScoped, unscopeable)).toBe(true);
    expect(endpointAcceptsEvent(bothScoped, unscopeable)).toBe(true);
  });

  // A global incident declares no components. It is not "about no services", it
  // is about all of them, so a monitor scope has nothing to judge it by.
  it("delivers an event whose monitor list resolved to nothing", () => {
    expect(endpointAcceptsEvent(monitorScoped, about(null))).toBe(true);
  });

  // A monitor-scoped endpoint has said nothing about pages, so a page event is
  // not something its scope is entitled to withhold.
  it("delivers a page event to an endpoint scoped only to monitors", () => {
    expect(endpointAcceptsEvent(monitorScoped, about(null, ["/status"]))).toBe(true);
  });

  it("delivers a monitor event to an endpoint scoped only to pages", () => {
    expect(endpointAcceptsEvent(pageScoped, about(["billing"]))).toBe(true);
  });
});

describe("a page scope", () => {
  it("delivers a page in the scope and withholds one outside it", () => {
    expect(endpointAcceptsEvent(pageScoped, about(null, ["/status"]))).toBe(true);
    expect(endpointAcceptsEvent(pageScoped, about(null, ["/internal"]))).toBe(false);
  });
});

/**
 * The two kinds are ORed. An AND would make every mixed scope deliver nothing,
 * because no event carries a monitor and a page at once, and that failure would
 * present as "the endpoint stopped working" with no error anywhere.
 */
describe("monitor and page scopes are combined with OR", () => {
  it("delivers an event matching either kind", () => {
    expect(endpointAcceptsEvent(bothScoped, about(["api"]))).toBe(true);
    expect(endpointAcceptsEvent(bothScoped, about(null, ["/status"]))).toBe(true);
  });

  it("still withholds an event that misses the kind it can judge", () => {
    expect(endpointAcceptsEvent(bothScoped, about(["billing"]))).toBe(false);
    expect(endpointAcceptsEvent(bothScoped, about(null, ["/internal"]))).toBe(false);
  });
});
