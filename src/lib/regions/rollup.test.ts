import { describe, it, expect } from "vitest";
import { rollupRegionStatuses, describeRollup, type RegionSample } from "./rollup.js";

const sample = (regionId: number, status: string | null, latencyMs: number | null = 10): RegionSample => ({
  regionId,
  status,
  latencyMs,
});

describe("the fixed rule", () => {
  it("is UP when every region is up", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP"), sample(2, "UP"), sample(3, "UP")]);
    expect(rollup.status).toBe("UP");
    expect(rollup.observed).toBe(3);
  });

  it("is DEGRADED when some regions are down and others are not", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP"), sample(2, "DOWN"), sample(3, "UP")]);
    expect(rollup.status).toBe("DEGRADED");
    expect(rollup.down).toEqual([2]);
  });

  it("is DOWN only when every observable region is down", () => {
    expect(rollupRegionStatuses([sample(1, "DOWN"), sample(2, "DOWN")]).status).toBe("DOWN");
  });

  it("is DEGRADED when a region is itself degraded, even with none down", () => {
    // A degraded region is neither up nor down, and a service one of whose
    // regions is limping is not whole.
    const rollup = rollupRegionStatuses([sample(1, "UP"), sample(2, "DEGRADED")]);
    expect(rollup.status).toBe("DEGRADED");
    expect(rollup.degraded).toEqual([2]);
  });

  it("is DEGRADED, not DOWN, when every region is degraded", () => {
    // "All down" means down. Degraded everywhere is still serving.
    expect(rollupRegionStatuses([sample(1, "DEGRADED"), sample(2, "DEGRADED")]).status).toBe("DEGRADED");
  });
});

describe("a service with one region behaves exactly like a plain monitor", () => {
  it("is DOWN, never DEGRADED, when its only region is down", () => {
    // The trap a rule phrased as "more than zero and fewer than all" walks into:
    // one region down is both, and DEGRADED would be nonsense.
    const rollup = rollupRegionStatuses([sample(1, "DOWN")]);
    expect(rollup.status).toBe("DOWN");
  });

  it("is UP when its only region is up", () => {
    expect(rollupRegionStatuses([sample(1, "UP")]).status).toBe("UP");
  });
});

describe("silence is not an outage", () => {
  it("ignores a silent region rather than counting it as down", () => {
    // Counting it would announce an outage nobody observed, which is the shape
    // of KENER-151.
    const rollup = rollupRegionStatuses([sample(1, "UP"), sample(2, null)]);
    expect(rollup.status).toBe("UP");
    expect(rollup.silent).toEqual([2]);
    expect(rollup.observed).toBe(1);
  });

  it("does not let a silent region turn a healthy service DEGRADED", () => {
    expect(rollupRegionStatuses([sample(1, "UP"), sample(2, "UP"), sample(3, null)]).status).toBe("UP");
  });

  it("reports no status at all when every region is silent", () => {
    // Not UP, not DOWN. There is no sample to write for this minute.
    const rollup = rollupRegionStatuses([sample(1, null), sample(2, null)]);
    expect(rollup.status).toBeNull();
    expect(rollup.observed).toBe(0);
  });

  it("reports no status for a service with no regions at all", () => {
    const rollup = rollupRegionStatuses([]);
    expect(rollup.status).toBeNull();
    expect(rollup.observed).toBe(0);
  });

  it("treats an unrecognised status as silence rather than as an outage", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP"), sample(2, "WOBBLY")]);
    expect(rollup.status).toBe("UP");
    expect(rollup.silent).toEqual([2]);
  });

  it("still says DOWN when the regions that ARE reporting are all down", () => {
    // Silence must not rescue a service either: two down and one unseen is not
    // evidence that anything is working.
    const rollup = rollupRegionStatuses([sample(1, "DOWN"), sample(2, "DOWN"), sample(3, null)]);
    expect(rollup.status).toBe("DOWN");
  });
});

describe("maintenance is not an outage", () => {
  it("does not drag a healthy service to DEGRADED", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP"), sample(2, "MAINTENANCE")]);
    expect(rollup.status).toBe("UP");
    expect(rollup.maintenance).toEqual([2]);
  });

  it("is MAINTENANCE when maintenance is all there is", () => {
    // Distinguishable from silence: the operator said this, so the service can
    // say it too.
    const rollup = rollupRegionStatuses([sample(1, "MAINTENANCE"), sample(2, "MAINTENANCE")]);
    expect(rollup.status).toBe("MAINTENANCE");
  });

  it("prefers MAINTENANCE over nothing when the rest are merely silent", () => {
    const rollup = rollupRegionStatuses([sample(1, "MAINTENANCE"), sample(2, null)]);
    expect(rollup.status).toBe("MAINTENANCE");
  });

  it("does not hide a real outage behind a maintenance window elsewhere", () => {
    // Two regions parked and the third genuinely down means nothing is serving.
    const rollup = rollupRegionStatuses([sample(1, "MAINTENANCE"), sample(2, "MAINTENANCE"), sample(3, "DOWN")]);
    expect(rollup.status).toBe("DOWN");
    expect(rollup.down).toEqual([3]);
  });
});

describe("latency comes from the regions that are actually serving", () => {
  it("averages the serving regions", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP", 10), sample(2, "UP", 30)]);
    expect(rollup.latencyMs).toBe(20);
  });

  it("excludes a down region, whose latency is 0", () => {
    // Including it would make the service look FASTER the moment part of it
    // failed: a graph that improves during an outage.
    const rollup = rollupRegionStatuses([sample(1, "UP", 30), sample(2, "DOWN", 0)]);
    expect(rollup.latencyMs).toBe(30);
  });

  it("counts a degraded region, which is still serving", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP", 10), sample(2, "DEGRADED", 50)]);
    expect(rollup.latencyMs).toBe(30);
  });

  it("excludes maintenance and silent regions", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP", 40), sample(2, "MAINTENANCE", 1), sample(3, null, 1)]);
    expect(rollup.latencyMs).toBe(40);
  });

  it("is null when nothing is serving", () => {
    expect(rollupRegionStatuses([sample(1, "DOWN", 0)]).latencyMs).toBeNull();
  });

  it("ignores a region with no latency recorded rather than reading it as 0", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP", 20), sample(2, "UP", null)]);
    expect(rollup.latencyMs).toBe(20);
  });
});

describe("describeRollup names the regions", () => {
  const name = (id: number) => ({ 1: "Frankfurt", 2: "Virginia", 3: "Mumbai" })[id] ?? `region ${id}`;

  it("says nothing at all when everything is healthy", () => {
    // So a caller can append it unconditionally without "Service is up ()".
    expect(describeRollup(rollupRegionStatuses([sample(1, "UP")]), name)).toBe("");
  });

  it("names the down regions", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP"), sample(2, "DOWN"), sample(3, "DOWN")]);
    expect(describeRollup(rollup, name)).toBe("down in Virginia, Mumbai");
  });

  it("reports silence, which the status itself cannot show", () => {
    const rollup = rollupRegionStatuses([sample(1, "UP"), sample(2, null)]);
    expect(describeRollup(rollup, name)).toBe("not reporting from Virginia");
  });

  it("combines every kind it has something to say about", () => {
    const rollup = rollupRegionStatuses([sample(1, "DOWN"), sample(2, "DEGRADED"), sample(3, "MAINTENANCE")]);
    expect(describeRollup(rollup, name)).toBe("down in Frankfurt; degraded in Virginia; under maintenance in Mumbai");
  });
});
