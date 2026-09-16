import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Knex from "knex";
import type { Knex as KnexType } from "knex";
import { RegionTargetsRepository } from "./regionTargets.js";
import { unscoped } from "./testSupport";

/**
 * B12a. The relationship table behind a multi-region monitor.
 *
 * **The fixture carries the real unique indexes**, because half of what this
 * table is for lives in them rather than in any method: one endpoint per region
 * per service, and a child belonging to exactly one parent. A fixture without
 * them would let every test here pass against a schema that permits a monitor to
 * be rolled up into two services at once.
 */
describe("RegionTargetsRepository", () => {
  let db: KnexType;
  let repo: RegionTargetsRepository;

  beforeEach(async () => {
    db = Knex({
      client: "better-sqlite3",
      connection: { filename: ":memory:" },
      useNullAsDefault: true,
    });

    await db.schema.createTable("monitor_region_targets", (table) => {
      table.increments("id").primary();
      table.integer("org_id").nullable();
      table.string("parent_tag", 255).notNullable();
      table.string("child_tag", 255).notNullable();
      table.integer("region_id").notNullable();
      table.unique(["parent_tag", "region_id"], { indexName: "uq_monitor_region_targets_parent_region" });
      table.unique(["child_tag"], { indexName: "uq_monitor_region_targets_child" });
    });

    repo = unscoped(new RegionTargetsRepository(db));
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** Three regions of one service, inserted out of region order on purpose. */
  async function seedApi() {
    await repo.addRegionTarget({ parentTag: "api", childTag: "api__us-east", regionId: 7 });
    await repo.addRegionTarget({ parentTag: "api", childTag: "api__eu-central", regionId: 2 });
    await repo.addRegionTarget({ parentTag: "api", childTag: "api__ap-south", regionId: 5 });
  }

  it("returns a service's endpoints in region order, not insertion order", async () => {
    // **This test cannot fail if the ORDER BY is deleted, and that is recorded
    // rather than fixed.** The fixture carries the real
    // `(parent_tag, region_id)` unique index, SQLite answers this query from it,
    // and rows come back in region order with or without the clause. Building a
    // fixture where index order and region order disagree is impossible, because
    // they are the same two columns. Verified against Postgres by hand instead;
    // see the comment on `getRegionTargets`.
    await seedApi();

    const targets = await repo.getRegionTargets("api");

    expect(targets.map((t) => t.region_id)).toEqual([2, 5, 7]);
    expect(targets.map((t) => t.child_tag)).toEqual(["api__eu-central", "api__ap-south", "api__us-east"]);
  });

  it("returns only the named service's endpoints", async () => {
    await seedApi();
    await repo.addRegionTarget({ parentTag: "web", childTag: "web__eu-central", regionId: 2 });

    const targets = await repo.getRegionTargets("api");

    expect(targets).toHaveLength(3);
    expect(targets.every((t) => t.parent_tag === "api")).toBe(true);
  });

  it("returns an empty list for a monitor with no regional endpoints", async () => {
    await seedApi();
    expect(await repo.getRegionTargets("nothing-here")).toEqual([]);
  });

  it("groups several services in one query, keyed by parent", async () => {
    await seedApi();
    await repo.addRegionTarget({ parentTag: "web", childTag: "web__eu-central", regionId: 2 });

    const byParent = await repo.getRegionTargetsForParents(["api", "web", "absent"]);

    expect(byParent.get("api")).toHaveLength(3);
    expect(byParent.get("web")).toHaveLength(1);
    // Absent rather than an empty array: a caller asking "does this monitor have
    // regions" must not be handed a truthy empty list.
    expect(byParent.has("absent")).toBe(false);
  });

  it("keeps region order within each group", async () => {
    await seedApi();
    const byParent = await repo.getRegionTargetsForParents(["api"]);
    expect(byParent.get("api")?.map((t) => t.region_id)).toEqual([2, 5, 7]);
  });

  it("issues no query at all for an empty list of parents", async () => {
    // The batch read is called from render paths that may have nothing to ask
    // about, and `whereIn` with an empty array is a query that returns nothing
    // at the cost of a round trip.
    //
    // **Counted rather than inferred from the result.** An empty Map comes back
    // either way - `whereIn` over an empty array simply matches nothing - so an
    // assertion on the return value passes just as happily with the early
    // return deleted, and would have tested nothing at all.
    await seedApi();

    let queries = 0;
    const count = () => {
      queries++;
    };
    db.on("query", count);
    try {
      expect(await repo.getRegionTargetsForParents([])).toEqual(new Map());
      expect(queries).toBe(0);

      // ...and the counter really does move, so a zero above means "no query"
      // rather than "the listener was never wired up".
      await repo.getRegionTargetsForParents(["api"]);
      expect(queries).toBe(1);
    } finally {
      db.off("query", count);
    }
  });

  it("finds the parent from the child's side", async () => {
    await seedApi();

    const target = await repo.getRegionTargetByChild("api__ap-south");

    expect(target?.parent_tag).toBe("api");
    expect(target?.region_id).toBe(5);
  });

  it("says nothing for a monitor that is not a regional endpoint", async () => {
    await seedApi();
    // This is the answer that decides whether a monitor gets alerted on and
    // whether it appears publicly, so "not a child" has to be distinguishable
    // from "a child of nothing".
    expect(await repo.getRegionTargetByChild("api")).toBeUndefined();
  });

  it("returns every child tag in one set", async () => {
    await seedApi();
    await repo.addRegionTarget({ parentTag: "web", childTag: "web__eu-central", regionId: 2 });

    const children = await repo.getAllRegionTargetChildTags();

    expect(children.size).toBe(4);
    expect(children.has("api__eu-central")).toBe(true);
    expect(children.has("web__eu-central")).toBe(true);
    // The PARENT is not a child, and a set that said otherwise would hide the
    // multi-region monitor itself from the public page.
    expect(children.has("api")).toBe(false);
  });

  it("returns the new row's id", async () => {
    // `returning` hands back a bare number on SQLite and an object on Postgres,
    // and this is the only value the caller gets.
    const id = await repo.addRegionTarget({ parentTag: "api", childTag: "api__eu-central", regionId: 2 });
    expect(id).toBeGreaterThan(0);
  });

  it("refuses a second endpoint in one region for one service", async () => {
    await repo.addRegionTarget({ parentTag: "api", childTag: "api__eu-central", regionId: 2 });

    // The fixed rollup rule has no answer for a region that is half down, so
    // this is the model rather than a nicety.
    await expect(repo.addRegionTarget({ parentTag: "api", childTag: "api__eu-2", regionId: 2 })).rejects.toThrow();
  });

  it("refuses a monitor that already belongs to another service", async () => {
    await repo.addRegionTarget({ parentTag: "api", childTag: "api__eu-central", regionId: 2 });

    // Otherwise its status rolls up into two services while the operator can
    // only ever see it under one.
    await expect(
      repo.addRegionTarget({ parentTag: "web", childTag: "api__eu-central", regionId: 2 }),
    ).rejects.toThrow();
  });

  it("allows the same region to serve two different services", async () => {
    await repo.addRegionTarget({ parentTag: "api", childTag: "api__eu-central", regionId: 2 });

    // Frankfurt hosts more than one thing. The unique index is on
    // (parent, region), and an index on region alone would forbid this.
    await expect(
      repo.addRegionTarget({ parentTag: "web", childTag: "web__eu-central", regionId: 2 }),
    ).resolves.toBeGreaterThan(0);
  });

  it("removes one endpoint and leaves the rest of the service", async () => {
    await seedApi();

    expect(await repo.removeRegionTarget("api__ap-south")).toBe(1);

    const remaining = await repo.getRegionTargets("api");
    expect(remaining.map((t) => t.child_tag)).toEqual(["api__eu-central", "api__us-east"]);
  });

  it("removes every endpoint of one service and no other service's", async () => {
    await seedApi();
    await repo.addRegionTarget({ parentTag: "web", childTag: "web__eu-central", regionId: 2 });

    expect(await repo.removeRegionTargetsForParent("api")).toBe(3);

    expect(await repo.getRegionTargets("api")).toEqual([]);
    expect(await repo.getRegionTargets("web")).toHaveLength(1);
  });
});
