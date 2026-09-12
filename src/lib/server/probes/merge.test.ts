import { describe, it, expect } from "vitest";
import GC from "../../global-constants.js";
import {
  mergeObservations,
  mergeRegionAgents,
  resolveMergeConfig,
  parseMergeDefaults,
  DEFAULT_MERGE_DEFAULTS,
  LOCAL_REGION_ID,
} from "./merge.js";
import type { MergeConfig, MergePolicy, Observation, SourceConfig, SourceMode } from "./merge.js";

function source(regionId: number, over: Partial<SourceConfig> = {}): SourceConfig {
  return { regionId, mode: "VOTE", weight: 1, trustRank: 100, ...over };
}

function config(policy: MergePolicy, sources: SourceConfig[], over: Partial<MergeConfig> = {}): MergeConfig {
  return {
    policy,
    quorumThreshold: 2,
    degradedOnDisagreement: false,
    sources: new Map(sources.map((s) => [s.regionId, s])),
    ...over,
  };
}

function obs(regionId: number, status: string, latency = 100, error?: string): Observation {
  return {
    regionId,
    result: { status, latency, type: GC.REALTIME, ...(error ? { error_message: error } : {}) },
  };
}

describe("mergeObservations: nothing to decide", () => {
  it("returns null with no observations at all", () => {
    expect(mergeObservations([], config("WEIGHTED_MAJORITY", []))).toBeNull();
  });

  it("returns null when every source is OFF", () => {
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID, { mode: "OFF" }), source(2, { mode: "OFF" })]);
    expect(mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN)], cfg)).toBeNull();
  });

  it("returns null when every source reported NO_DATA", () => {
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID), source(2)]);
    expect(mergeObservations([obs(LOCAL_REGION_ID, GC.NO_DATA), obs(2, GC.NO_DATA)], cfg)).toBeNull();
  });

  it("ignores a DISPLAY_ONLY source entirely, even a dissenting one", () => {
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID), source(2, { mode: "DISPLAY_ONLY" })]);
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN, 9000, "timeout")], cfg);
    expect(merged?.status).toBe(GC.UP);
    expect(merged?.error_message).toBeUndefined();
  });

  it("gives an unconfigured region an ordinary vote rather than dropping it", () => {
    // An operator who adds a region and forgets to configure it should get a
    // probe that counts, not one that is silently ignored.
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID)]);
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(7, GC.DOWN), obs(8, GC.DOWN)], cfg);
    expect(merged?.status).toBe(GC.DOWN);
  });
});

describe("TRUST_ORDER", () => {
  it("lets a trusted probe overrule a local DOWN, which is the whole point", () => {
    // The datacenter-blocked case: the provider 403s the server and 200s a
    // residential probe. Rank the probe above local and the page says UP.
    const cfg = config("TRUST_ORDER", [source(LOCAL_REGION_ID, { trustRank: 50 }), source(3, { trustRank: 10 })]);
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.DOWN, 0, "403 Forbidden"), obs(3, GC.UP, 180)], cfg);
    expect(merged?.status).toBe(GC.UP);
    expect(merged?.latency).toBe(180);
    expect(merged?.error_message).toBeUndefined();
  });

  it("falls back to the next source when the trusted one did not report", () => {
    const cfg = config("TRUST_ORDER", [source(LOCAL_REGION_ID, { trustRank: 50 }), source(3, { trustRank: 10 })]);
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.DOWN, 0, "403 Forbidden")], cfg);
    expect(merged?.status).toBe(GC.DOWN);
    expect(merged?.error_message).toBe("403 Forbidden");
  });

  it("never produces DEGRADED from disagreement, even when the flag is on", () => {
    const cfg = config("TRUST_ORDER", [source(LOCAL_REGION_ID, { trustRank: 50 }), source(3, { trustRank: 10 })], {
      degradedOnDisagreement: true,
    });
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.DOWN), obs(3, GC.UP)], cfg);
    expect(merged?.status).toBe(GC.UP);
  });

  it("breaks a rank tie towards local, and stably", () => {
    const cfg = config("TRUST_ORDER", [source(LOCAL_REGION_ID, { trustRank: 10 }), source(3, { trustRank: 10 })]);
    const merged = mergeObservations([obs(3, GC.UP), obs(LOCAL_REGION_ID, GC.DOWN)], cfg);
    expect(merged?.status).toBe(GC.DOWN);
  });
});

describe("WEIGHTED_MAJORITY", () => {
  it("lets weight beat headcount", () => {
    const cfg = config("WEIGHTED_MAJORITY", [
      source(LOCAL_REGION_ID, { weight: 10 }),
      source(2, { weight: 1 }),
      source(3, { weight: 1 }),
    ]);
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN), obs(3, GC.DOWN)], cfg);
    expect(merged?.status).toBe(GC.UP);
  });

  it("resolves an exact tie to the worse status", () => {
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID, { weight: 1 }), source(2, { weight: 1 })]);
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN)], cfg);
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("averages latency over the winning group only", () => {
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID), source(2), source(3)]);
    const merged = mergeObservations(
      [obs(LOCAL_REGION_ID, GC.UP, 100), obs(2, GC.UP, 200), obs(3, GC.DOWN, 30000)],
      cfg,
    );
    expect(merged?.status).toBe(GC.UP);
    expect(merged?.latency).toBe(150);
  });

  it("downgrades a winning UP to DEGRADED when a source dissents", () => {
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID, { weight: 5 }), source(2, { weight: 1 })], {
      degradedOnDisagreement: true,
    });
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN, 9000, "connect timeout")], cfg);
    expect(merged?.status).toBe(GC.DEGRADED);
    // The explanation has to come from the region that dissented. The winning
    // UP sources carry no message at all.
    expect(merged?.error_message).toBe("connect timeout");
  });

  it("never softens a winning DOWN into DEGRADED", () => {
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID, { weight: 5 }), source(2, { weight: 1 })], {
      degradedOnDisagreement: true,
    });
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.DOWN, 0, "500"), obs(2, GC.UP)], cfg);
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("leaves a unanimous UP alone with the flag on", () => {
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID), source(2)], {
      degradedOnDisagreement: true,
    });
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.UP)], cfg);
    expect(merged?.status).toBe(GC.UP);
  });

  it("cannot publish UP when every weight is zero and a source reported DOWN", () => {
    // Zero weight everywhere is a misconfiguration. It must not decide the
    // verdict by map insertion order.
    const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID, { weight: 0 }), source(2, { weight: 0 })]);
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN)], cfg);
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("joins several failing regions' messages rather than picking one", () => {
    const cfg = config("WEIGHTED_MAJORITY", [source(2), source(3)]);
    const merged = mergeObservations([obs(2, GC.DOWN, 0, "500"), obs(3, GC.DOWN, 0, "timeout")], cfg);
    expect(merged?.error_message).toBe("region 2: 500 | region 3: timeout");
  });
});

describe("QUORUM_DOWN", () => {
  const sources = [source(LOCAL_REGION_ID), source(2), source(3)];

  it("publishes DOWN once the threshold is met", () => {
    const cfg = config("QUORUM_DOWN", sources, { quorumThreshold: 2 });
    const merged = mergeObservations(
      [obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN, 0, "500"), obs(3, GC.DOWN, 0, "500")],
      cfg,
    );
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("holds the last known status below the threshold", () => {
    const cfg = config("QUORUM_DOWN", sources, { quorumThreshold: 2 });
    const merged = mergeObservations(
      [obs(LOCAL_REGION_ID, GC.UP, 100), obs(2, GC.DOWN, 30000, "timeout"), obs(3, GC.UP, 120)],
      cfg,
      GC.UP,
    );
    expect(merged?.status).toBe(GC.UP);
    // The evidence survives into the history even though the status did not move.
    expect(merged?.error_message).toContain("1 of 3 sources reported down");
    expect(merged?.error_message).toContain("timeout");
  });

  it("keeps a held DOWN down rather than recovering on a minority report", () => {
    const cfg = config("QUORUM_DOWN", sources, { quorumThreshold: 2 });
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN), obs(3, GC.UP)], cfg, GC.DOWN);
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("holds UP on a monitor's first ever tick, with no last known status", () => {
    const cfg = config("QUORUM_DOWN", sources, { quorumThreshold: 2 });
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN)], cfg);
    expect(merged?.status).toBe(GC.UP);
  });

  it("keeps the held latency off the timed-out source", () => {
    const cfg = config("QUORUM_DOWN", sources, { quorumThreshold: 3 });
    const merged = mergeObservations(
      [obs(LOCAL_REGION_ID, GC.UP, 100), obs(2, GC.DOWN, 30000), obs(3, GC.UP, 200)],
      cfg,
      GC.UP,
    );
    expect(merged?.latency).toBe(150);
  });

  it("still surfaces DEGRADED, which the quorum does not gate", () => {
    const cfg = config("QUORUM_DOWN", sources, { quorumThreshold: 2 });
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DEGRADED, 0, "slow")], cfg, GC.UP);
    expect(merged?.status).toBe(GC.DEGRADED);
    expect(merged?.error_message).toBe("slow");
  });

  it("does not let a silent source count towards the denominator", () => {
    // Two sources answered, one of them DOWN, and the threshold is 2. If the
    // NO_DATA source were counted the message would say "1 of 3".
    const cfg = config("QUORUM_DOWN", sources, { quorumThreshold: 2 });
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN), obs(3, GC.NO_DATA)], cfg, GC.UP);
    expect(merged?.error_message).toContain("1 of 2 sources reported down");
  });

  it("treats a threshold of 1 as any-source-down", () => {
    const cfg = config("QUORUM_DOWN", sources, { quorumThreshold: 1 });
    const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN)], cfg, GC.UP);
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("clamps a nonsensical threshold to 1 rather than never reporting DOWN", () => {
    const cfg = config("QUORUM_DOWN", sources, { quorumThreshold: 0 });
    const merged = mergeObservations([obs(2, GC.DOWN)], cfg, GC.UP);
    expect(merged?.status).toBe(GC.DOWN);
  });
});

describe("mode coverage", () => {
  const modes: SourceMode[] = ["VOTE", "DISPLAY_ONLY", "OFF"];
  it("counts a source if and only if it is VOTE", () => {
    for (const mode of modes) {
      const cfg = config("WEIGHTED_MAJORITY", [source(LOCAL_REGION_ID), source(2, { mode })]);
      const merged = mergeObservations([obs(LOCAL_REGION_ID, GC.UP), obs(2, GC.DOWN)], cfg);
      expect(merged?.status).toBe(mode === "VOTE" ? GC.DOWN : GC.UP);
    }
  });
});

describe("resolveMergeConfig: the cascade", () => {
  const instance = { ...DEFAULT_MERGE_DEFAULTS };

  it("gives an unconfigured probe region the instance defaults", () => {
    const cfg = resolveMergeConfig({ instance, regions: [], participatingRegions: [LOCAL_REGION_ID, 4] });
    expect(cfg.sources.get(4)).toEqual({
      regionId: 4,
      weight: instance.defaultWeight,
      trustRank: instance.defaultTrustRank,
      mode: instance.defaultMode,
    });
  });

  it("gives local its own instance defaults, not the probe ones", () => {
    // Local ranks above a probe out of the box, so switching to TRUST_ORDER
    // without configuring anything keeps the local check authoritative.
    const cfg = resolveMergeConfig({ instance, regions: [], participatingRegions: [LOCAL_REGION_ID, 4] });
    expect(cfg.sources.get(LOCAL_REGION_ID)?.trustRank).toBe(instance.localTrustRank);
    expect(cfg.sources.get(LOCAL_REGION_ID)?.trustRank).toBeLessThan(cfg.sources.get(4)!.trustRank);
  });

  it("lets a region default override the instance default", () => {
    const cfg = resolveMergeConfig({
      instance,
      regions: [{ id: 4, default_weight: 9, default_trust_rank: 5, default_mode: "DISPLAY_ONLY" }],
      participatingRegions: [4],
    });
    expect(cfg.sources.get(4)).toEqual({ regionId: 4, weight: 9, trustRank: 5, mode: "DISPLAY_ONLY" });
  });

  it("lets a per-monitor override beat the region default", () => {
    // The Reddit case: for this one monitor, rank the probe above local.
    const cfg = resolveMergeConfig({
      instance,
      regions: [{ id: 4, default_trust_rank: 80 }],
      monitorSources: [
        { region_id: 4, trust_rank: 1 },
        { region_id: LOCAL_REGION_ID, trust_rank: 90 },
      ],
      participatingRegions: [LOCAL_REGION_ID, 4],
    });
    expect(cfg.sources.get(4)?.trustRank).toBe(1);
    expect(cfg.sources.get(LOCAL_REGION_ID)?.trustRank).toBe(90);
  });

  it("treats null as inherit and 0 as a real weight", () => {
    const cfg = resolveMergeConfig({
      instance,
      regions: [{ id: 4, default_weight: 7 }],
      monitorSources: [{ region_id: 4, weight: null, trust_rank: 0 }],
      participatingRegions: [4],
    });
    expect(cfg.sources.get(4)?.weight).toBe(7);
    expect(cfg.sources.get(4)?.trustRank).toBe(0);
  });

  it("keeps a configured weight of zero rather than inheriting over it", () => {
    const cfg = resolveMergeConfig({
      instance,
      regions: [{ id: 4, default_weight: 7 }],
      monitorSources: [{ region_id: 4, weight: 0 }],
      participatingRegions: [4],
    });
    expect(cfg.sources.get(4)?.weight).toBe(0);
  });

  it("resolves the policy instance then monitor, each field independently", () => {
    const cfg = resolveMergeConfig({
      instance,
      regions: [],
      monitorPolicy: { policy: "QUORUM_DOWN", quorum_threshold: null },
      participatingRegions: [LOCAL_REGION_ID],
    });
    expect(cfg.policy).toBe("QUORUM_DOWN");
    expect(cfg.quorumThreshold).toBe(instance.quorumThreshold);
  });

  it("reads SQLite's 0/1 booleans as booleans", () => {
    const on = resolveMergeConfig({
      instance,
      regions: [],
      monitorPolicy: { degraded_on_disagreement: 1 },
      participatingRegions: [LOCAL_REGION_ID],
    });
    const off = resolveMergeConfig({
      instance,
      regions: [],
      monitorPolicy: { degraded_on_disagreement: 0 },
      participatingRegions: [LOCAL_REGION_ID],
    });
    expect(on.degradedOnDisagreement).toBe(true);
    expect(off.degradedOnDisagreement).toBe(false);
  });

  it("ignores an unrecognised policy or mode rather than adopting it", () => {
    const cfg = resolveMergeConfig({
      instance,
      regions: [{ id: 4, default_mode: "SOMETIMES" }],
      monitorPolicy: { policy: "VIBES" },
      participatingRegions: [4],
    });
    expect(cfg.policy).toBe(instance.policy);
    expect(cfg.sources.get(4)?.mode).toBe(instance.defaultMode);
  });

  it("clamps a quorum threshold below 1", () => {
    const cfg = resolveMergeConfig({
      instance,
      regions: [],
      monitorPolicy: { quorum_threshold: 0 },
      participatingRegions: [LOCAL_REGION_ID],
    });
    expect(cfg.quorumThreshold).toBe(1);
  });

  it("deduplicates a region listed twice", () => {
    const cfg = resolveMergeConfig({ instance, regions: [], participatingRegions: [4, 4] });
    expect(cfg.sources.size).toBe(1);
  });
});

describe("parseMergeDefaults", () => {
  it("returns the shipped defaults for anything unusable", () => {
    for (const raw of [null, undefined, "", 7, "a string"]) {
      expect(parseMergeDefaults(raw)).toEqual(DEFAULT_MERGE_DEFAULTS);
    }
  });

  it("keeps the shipped behaviour: no DEGRADED from disagreement unless asked", () => {
    // Turning a disagreement into a publicly visible degradation must never
    // start happening on an upgrade.
    expect(DEFAULT_MERGE_DEFAULTS.degradedOnDisagreement).toBe(false);
  });

  it("falls back field by field rather than discarding a partial object", () => {
    const parsed = parseMergeDefaults({ policy: "TRUST_ORDER" });
    expect(parsed.policy).toBe("TRUST_ORDER");
    expect(parsed.defaultWeight).toBe(DEFAULT_MERGE_DEFAULTS.defaultWeight);
  });

  it("round-trips through JSON, which is how it is actually stored", () => {
    const stored = JSON.stringify({ ...DEFAULT_MERGE_DEFAULTS, policy: "QUORUM_DOWN", quorumThreshold: 3 });
    const parsed = parseMergeDefaults(JSON.parse(stored));
    expect(parsed.policy).toBe("QUORUM_DOWN");
    expect(parsed.quorumThreshold).toBe(3);
  });
});

describe("mergeRegionAgents: several agents, one regional answer", () => {
  function result(status: string, latency = 100, error?: string) {
    return { status, latency, type: GC.REALTIME, ...(error ? { error_message: error } : {}) };
  }

  /** One agent's answer. B1g: an absent weight means 1. */
  function a(r: ReturnType<typeof result>, weight?: number) {
    return weight === undefined ? { result: r } : { result: r, weight };
  }

  it("returns null when no agent answered", () => {
    expect(mergeRegionAgents([], config("WEIGHTED_MAJORITY", []))).toBeNull();
  });

  it("returns the single answer untouched when a region has one agent", () => {
    // The pre-multi-agent path. It must stay byte-for-byte what it was, so an
    // install with one agent per region sees no change at all.
    const only = result(GC.UP, 42);
    expect(mergeRegionAgents([a(only)], config("WEIGHTED_MAJORITY", []))).toBe(only);
  });

  it("resolves disagreeing agents by majority", () => {
    const merged = mergeRegionAgents(
      [a(result(GC.UP)), a(result(GC.UP)), a(result(GC.DOWN, 9000, "timeout"))],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.UP);
  });

  it("breaks a tie towards the worse status, as the outer merge does", () => {
    const merged = mergeRegionAgents(
      [a(result(GC.UP)), a(result(GC.DOWN, 9000, "timeout"))],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("gives the verdict to the first-listed agent under TRUST_ORDER", () => {
    // Agents rank by their position in the registry's list, which is agent id
    // order. Anything else would make the answer depend on who reconnected last.
    const merged = mergeRegionAgents(
      [a(result(GC.UP)), a(result(GC.DOWN, 9000, "timeout"))],
      config("TRUST_ORDER", []),
    );
    expect(merged?.status).toBe(GC.UP);
  });

  it("holds DOWN until the region's own agents reach quorum", () => {
    const cfg = config("QUORUM_DOWN", [], { quorumThreshold: 2 });
    const one = mergeRegionAgents(
      [a(result(GC.DOWN, 9000, "timeout")), a(result(GC.UP)), a(result(GC.UP))],
      cfg,
      GC.UP,
    );
    expect(one?.status).toBe(GC.UP);

    const two = mergeRegionAgents(
      [a(result(GC.DOWN, 9000, "timeout")), a(result(GC.DOWN, 9000, "timeout")), a(result(GC.UP))],
      cfg,
      GC.UP,
    );
    expect(two?.status).toBe(GC.DOWN);
  });

  it("ignores an agent that reported NO_DATA rather than letting it dilute the vote", () => {
    const merged = mergeRegionAgents(
      [a(result(GC.DOWN, 9000, "timeout")), a(result(GC.NO_DATA, 0))],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("does not let a region's own weight leak into the merge among its agents", () => {
    // A region's configured weight is its say among OTHER regions. B1g gave
    // agents their own weights, but this is still not where the region's comes
    // from: a heavy region must not become a region whose first agent outvotes
    // its second.
    const heavy = config("WEIGHTED_MAJORITY", [source(7, { weight: 99 })]);
    const merged = mergeRegionAgents([a(result(GC.UP)), a(result(GC.UP)), a(result(GC.DOWN, 9000, "timeout"))], heavy);
    expect(merged?.status).toBe(GC.UP);
  });

  it("treats an absent weight as 1, so an unconfigured fleet is unchanged", () => {
    // Two UP at an explicit 1 against one DOWN with no weight at all.
    const merged = mergeRegionAgents(
      [a(result(GC.UP), 1), a(result(GC.UP), 1), a(result(GC.DOWN, 9000, "timeout"))],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.UP);
  });
});

describe("mergeRegionAgents: B1g per-agent weights", () => {
  function result(status: string, latency = 100, error?: string) {
    return { status, latency, type: GC.REALTIME, ...(error ? { error_message: error } : {}) };
  }
  function a(r: ReturnType<typeof result>, weight?: number) {
    return weight === undefined ? { result: r } : { result: r, weight };
  }

  it("lets a heavier agent outvote two lighter siblings", () => {
    // The case the two-regions advice could not serve: a datacentre probe and
    // two residential boxes all answering for one vantage point.
    const merged = mergeRegionAgents(
      [a(result(GC.DOWN, 9000, "timeout"), 10), a(result(GC.UP), 1), a(result(GC.UP), 1)],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("lets a lighter agent lose a vote it would have won on headcount", () => {
    const merged = mergeRegionAgents(
      [a(result(GC.UP), 10), a(result(GC.DOWN, 9000, "timeout"), 1), a(result(GC.DOWN, 9000, "timeout"), 1)],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.UP);
  });

  it("records an agent at weight 0 but gives it no vote", () => {
    const merged = mergeRegionAgents(
      [a(result(GC.UP), 1), a(result(GC.DOWN, 9000, "timeout"), 0)],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.UP);
  });

  it("falls back to the worst status when every agent is at weight 0", () => {
    // A misconfiguration must not be able to publish UP over an agent that
    // reported DOWN, which is what the outer merge does with the same input.
    const merged = mergeRegionAgents(
      [a(result(GC.UP), 0), a(result(GC.DOWN, 9000, "timeout"), 0)],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("ignores weight under TRUST_ORDER, where rank decides", () => {
    // Matches SourceConfig.weight in the outer merge: weight is a
    // WEIGHTED_MAJORITY concept and rank is a TRUST_ORDER one.
    const merged = mergeRegionAgents(
      [a(result(GC.UP), 1), a(result(GC.DOWN, 9000, "timeout"), 99)],
      config("TRUST_ORDER", []),
    );
    expect(merged?.status).toBe(GC.UP);
  });

  it("returns a lone agent's answer whatever its weight", () => {
    // Weight is a comparison and a lone agent has nothing to be compared with.
    // Silencing a region is DISPLAY_ONLY's job, not weight zero's.
    const only = result(GC.DOWN, 9000, "timeout");
    expect(mergeRegionAgents([a(only, 0)], config("WEIGHTED_MAJORITY", []))).toBe(only);
  });

  it("gives a negative weight no vote rather than letting it subtract", () => {
    // Pins the contract, not the mechanism: the clamp exists both here and in
    // mergeByWeight, so this stays green if either one alone is removed.
    const merged = mergeRegionAgents(
      [a(result(GC.UP), -100), a(result(GC.DOWN, 9000, "timeout"), 1)],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.DOWN);
  });

  it("treats a nonsense weight as no weight rather than poisoning the tally", () => {
    // NaN in a sum makes every comparison false and the whole region silent.
    const merged = mergeRegionAgents(
      [a(result(GC.UP), Number.NaN), a(result(GC.UP), Number.NaN), a(result(GC.DOWN, 9000, "timeout"), 1)],
      config("WEIGHTED_MAJORITY", []),
    );
    expect(merged?.status).toBe(GC.DOWN);
  });
});
