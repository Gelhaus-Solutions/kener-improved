import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MonitorRecord } from "../types/db.js";

const fake = {
  GetPageByPathWithMonitors: vi.fn<(path: string) => Promise<unknown>>(),
  ResolveVisiblePublicMonitor: vi.fn<(name: string) => Promise<MonitorRecord | undefined>>(),
};

vi.mock("../controllers/pagesController.js", () => ({
  GetPageByPathWithMonitors: (path: string) => fake.GetPageByPathWithMonitors(path),
}));

vi.mock("../controllers/publicMonitorResolver.js", () => ({
  ResolveVisiblePublicMonitor: (name: string) => fake.ResolveVisiblePublicMonitor(name),
}));

const { resolveLiveScope } = await import("./scope.js");

/**
 * A monitor whose public SLUG and physical TAG differ, which is the whole point
 * of every assertion about tags below. On the default org the two are the same
 * string, so a test using a monitor where they agree would pass against an
 * implementation that returns either one.
 */
function prefixedMonitor(): MonitorRecord {
  return { id: 7, tag: "beta_api", slug: "api", name: "API" } as MonitorRecord;
}

beforeEach(() => {
  fake.GetPageByPathWithMonitors.mockReset();
  fake.ResolveVisiblePublicMonitor.mockReset();
});

describe("resolveLiveScope, page scope", () => {
  it("allows that page's monitors and that page's status", async () => {
    fake.GetPageByPathWithMonitors.mockResolvedValue({
      page: { id: 4 },
      monitors: [{ monitor_tag: "api" }, { monitor_tag: "web" }],
    });

    const scope = await resolveLiveScope(new URLSearchParams("page=status"));

    expect(fake.GetPageByPathWithMonitors).toHaveBeenCalledWith("status");
    expect([...scope.allowedTags].sort()).toEqual(["api", "web"]);
    expect(scope.pageId).toBe(4);
  });

  it("treats an absent page parameter as the home page, whose path is empty", async () => {
    fake.GetPageByPathWithMonitors.mockResolvedValue({ page: { id: 1 }, monitors: [{ monitor_tag: "api" }] });

    await resolveLiveScope(new URLSearchParams(""));

    expect(fake.GetPageByPathWithMonitors).toHaveBeenCalledWith("");
  });

  it("allows nothing when the page does not exist", async () => {
    fake.GetPageByPathWithMonitors.mockResolvedValue(undefined);

    const scope = await resolveLiveScope(new URLSearchParams("page=nope"));

    expect(scope.allowedTags.size).toBe(0);
    expect(scope.pageId).toBeNull();
  });
});

describe("resolveLiveScope, monitor scope", () => {
  it("allows the PHYSICAL tag, not the slug the URL carried", async () => {
    fake.ResolveVisiblePublicMonitor.mockResolvedValue(prefixedMonitor());

    const scope = await resolveLiveScope(new URLSearchParams("monitor=api"));

    // Resolved from what the URL said...
    expect(fake.ResolveVisiblePublicMonitor).toHaveBeenCalledWith("api");
    // ...but allowed by what the wire carries. Allowing "api" here would be an
    // allowlist that matches no event this org ever publishes.
    expect([...scope.allowedTags]).toEqual(["beta_api"]);
  });

  it("carries no page status", async () => {
    fake.ResolveVisiblePublicMonitor.mockResolvedValue(prefixedMonitor());

    const scope = await resolveLiveScope(new URLSearchParams("monitor=api"));

    expect(scope.pageId).toBeNull();
  });

  it("allows nothing for a monitor the public may not see", async () => {
    // `ResolveVisiblePublicMonitor` answers undefined for hidden, inactive and
    // unknown alike, which is what keeps this from telling a prober them apart.
    fake.ResolveVisiblePublicMonitor.mockResolvedValue(undefined);

    const scope = await resolveLiveScope(new URLSearchParams("monitor=secret"));

    expect(scope.allowedTags.size).toBe(0);
    expect(scope.pageId).toBeNull();
  });

  it("never falls back to a page for a hidden monitor", async () => {
    // The failure this guards is silent rather than loud: falling back would
    // hand a refused viewer the HOME page's allowlist and look like it worked.
    fake.ResolveVisiblePublicMonitor.mockResolvedValue(undefined);

    await resolveLiveScope(new URLSearchParams("monitor=secret"));

    expect(fake.GetPageByPathWithMonitors).not.toHaveBeenCalled();
  });

  it("takes the monitor scope when both are sent, because it is the narrower", async () => {
    fake.ResolveVisiblePublicMonitor.mockResolvedValue(prefixedMonitor());
    fake.GetPageByPathWithMonitors.mockResolvedValue({
      page: { id: 4 },
      monitors: [{ monitor_tag: "other" }, { monitor_tag: "beta_api" }],
    });

    const scope = await resolveLiveScope(new URLSearchParams("page=status&monitor=api"));

    expect([...scope.allowedTags]).toEqual(["beta_api"]);
    expect(scope.pageId).toBeNull();
    expect(fake.GetPageByPathWithMonitors).not.toHaveBeenCalled();
  });

  it("does not treat an empty monitor parameter as absent", async () => {
    // `?monitor=` is a caller asking about a monitor with no name, which is not
    // the same request as `?page=`. Answering it with the home page's allowlist
    // would be the widening this scope exists to prevent.
    fake.ResolveVisiblePublicMonitor.mockResolvedValue(undefined);

    const scope = await resolveLiveScope(new URLSearchParams("monitor="));

    expect(scope.allowedTags.size).toBe(0);
    expect(fake.GetPageByPathWithMonitors).not.toHaveBeenCalled();
  });
});
