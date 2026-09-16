import { describe, it, expect, beforeEach, vi } from "vitest";

const fake = {
  getRegionTargetByChild: vi.fn<(tag: string) => Promise<unknown>>(),
};

vi.mock("../db/db.js", () => ({
  default: {
    getRegionTargetByChild: (tag: string) => fake.getRegionTargetByChild(tag),
  },
}));

const { isRegionalEndpoint } = await import("./multiRegion.js");

beforeEach(() => {
  fake.getRegionTargetByChild.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/**
 * B12b. The predicate the Q3 decision rests on.
 *
 * Tested on its own because the consequence of each wrong answer is invisible at
 * the moment it happens: a wrong "yes" is an alert that never fires, and a wrong
 * "no" is a pager storm during an outage.
 */
describe("isRegionalEndpoint", () => {
  it("says yes for a monitor that is an endpoint of a service", async () => {
    fake.getRegionTargetByChild.mockResolvedValue({ parent_tag: "api", child_tag: "api__eu", region_id: 2 });
    expect(await isRegionalEndpoint("api__eu")).toBe(true);
  });

  it("says no for an ordinary monitor", async () => {
    fake.getRegionTargetByChild.mockResolvedValue(undefined);
    expect(await isRegionalEndpoint("api")).toBe(false);
  });

  it("asks about the tag it was given", async () => {
    fake.getRegionTargetByChild.mockResolvedValue(undefined);
    await isRegionalEndpoint("api__eu");
    expect(fake.getRegionTargetByChild).toHaveBeenCalledWith("api__eu");
  });

  it("FAILS OPEN when the lookup throws, so the alert still fires", async () => {
    // The load-bearing assertion. A database blip must never be able to silence
    // alerting: a wrong "no" costs duplicate pages, which are loud and
    // survivable, and a wrong "yes" costs the page you needed during an outage.
    fake.getRegionTargetByChild.mockRejectedValue(new Error("connection terminated"));
    expect(await isRegionalEndpoint("api__eu")).toBe(false);
  });

  it("says so in the log rather than failing open silently", async () => {
    fake.getRegionTargetByChild.mockRejectedValue(new Error("connection terminated"));
    await isRegionalEndpoint("api__eu");
    expect(console.warn).toHaveBeenCalled();
  });
});
