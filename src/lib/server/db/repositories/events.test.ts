import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Knex from "knex";
import type { Knex as KnexType } from "knex";
import { EventsRepository, type OutboxInsert } from "./events.js";
import { up as createEventTables } from "../../../../../migrations/20260908160000_add_event_outbox.js";
import type { EventDeliveryInsert } from "../../events/types.js";

// Repository-level checks against in-memory SQLite, using the real migration to
// build the schema rather than a hand-written copy: the UNIQUE constraints are
// half of what this file is testing, and a hand-written fixture would test the
// fixture instead.
//
// Like monitoring.test.ts, this builds its own throwaway Knex rather than using
// the db singleton, which would connect to whatever DATABASE_URL points at.

let seq = 0;
function event(overrides: Partial<OutboxInsert> = {}): OutboxInsert {
  seq++;
  return {
    event_id: `EV${String(seq).padStart(24, "0")}`,
    org_id: 1,
    type: "test.thing",
    aggregate_type: null,
    aggregate_id: null,
    actor_type: "system",
    actor_id: null,
    actor_label: null,
    occurred_at: 1000,
    payload: null,
    diff: null,
    correlation_id: null,
    causation_id: null,
    idempotency_key: null,
    suppress: false,
    schema_version: 1,
    ...overrides,
  };
}

function delivery(overrides: Partial<EventDeliveryInsert> = {}): EventDeliveryInsert {
  return {
    event_id: "EV000000000000000000000001",
    org_id: 1,
    consumer: "c1",
    target_type: "",
    target_id: "",
    status: "PENDING",
    attempts: 0,
    next_attempt_at: 1000,
    last_attempt_at: null,
    response_code: null,
    response_body: null,
    error: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

describe("EventsRepository", () => {
  let db: KnexType;
  let repo: EventsRepository;

  beforeEach(async () => {
    db = Knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
    await createEventTables(db);
    repo = new EventsRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("insertEvent", () => {
    it("reports a keyless insert as inserted", async () => {
      const row = event();
      const result = await repo.insertEvent(row);
      expect(result).toEqual({ inserted: true, event_id: row.event_id });
    });

    it("collapses a repeated idempotency key and returns the stored id", async () => {
      const first = event({ idempotency_key: "k1" });
      const second = event({ idempotency_key: "k1" });
      expect(await repo.insertEvent(first)).toEqual({ inserted: true, event_id: first.event_id });
      // The interesting half: better-sqlite3 reports a suppressed insert with a
      // stale lastInsertRowid, so nothing about the insert's own return value
      // could tell these apart. Reading the key back is what does.
      expect(await repo.insertEvent(second)).toEqual({ inserted: false, event_id: first.event_id });
      expect(Number((await repo.getEventsCount({}))?.count)).toBe(1);
    });

    it("lets different keys through", async () => {
      await repo.insertEvent(event({ idempotency_key: "a" }));
      await repo.insertEvent(event({ idempotency_key: "b" }));
      expect(Number((await repo.getEventsCount({}))?.count)).toBe(2);
    });

    it("treats a null key as no key, so unkeyed events never collide", async () => {
      await repo.insertEvent(event());
      await repo.insertEvent(event());
      await repo.insertEvent(event());
      expect(Number((await repo.getEventsCount({}))?.count)).toBe(3);
    });
  });

  describe("claimUnpublished", () => {
    it("hands the whole batch to the first caller and nothing to the second", async () => {
      for (let i = 0; i < 5; i++) await repo.insertEvent(event());
      const first = await repo.claimUnpublished(10, "t1", 1000, 60);
      const second = await repo.claimUnpublished(10, "t2", 1000, 60);
      expect(first).toHaveLength(5);
      expect(second).toHaveLength(0);
    });

    it("returns events in publish order", async () => {
      for (let i = 0; i < 5; i++) await repo.insertEvent(event());
      const claimed = await repo.claimUnpublished(10, "t1", 1000, 60);
      expect(claimed.map((e) => e.id)).toEqual([...claimed.map((e) => e.id)].sort((a, b) => a - b));
    });

    it("respects the limit", async () => {
      for (let i = 0; i < 5; i++) await repo.insertEvent(event());
      expect(await repo.claimUnpublished(2, "t1", 1000, 60)).toHaveLength(2);
    });

    it("lets an expired claim be stolen, so a killed relay strands nothing", async () => {
      await repo.insertEvent(event());
      await repo.claimUnpublished(10, "dead-relay", 1000, 60);
      expect(await repo.claimUnpublished(10, "next", 1030, 60)).toHaveLength(0);
      expect(await repo.claimUnpublished(10, "next", 1100, 60)).toHaveLength(1);
    });

    it("never returns a published event again", async () => {
      const row = event();
      await repo.insertEvent(row);
      await repo.claimUnpublished(10, "t1", 1000, 60);
      await repo.markPublished([row.event_id], 1000);
      expect(await repo.claimUnpublished(10, "t2", 9999, 60)).toHaveLength(0);
    });

    it("normalises suppress to a boolean, which SQLite stores as 0 or 1", async () => {
      await repo.insertEvent(event({ suppress: true }));
      await repo.insertEvent(event({ suppress: false }));
      const claimed = await repo.claimUnpublished(10, "t1", 1000, 60);
      expect(claimed.map((e) => e.suppress).sort()).toEqual([false, true]);
    });
  });

  describe("insertDeliveries", () => {
    it("collapses a repeated relay pass instead of double-delivering", async () => {
      await repo.insertDeliveries([delivery(), delivery()]);
      await repo.insertDeliveries([delivery()]);
      expect(await repo.getDeliveriesByEventId("EV000000000000000000000001")).toHaveLength(1);
    });

    it("keeps distinct targets apart", async () => {
      await repo.insertDeliveries([
        delivery({ target_type: "url", target_id: "a" }),
        delivery({ target_type: "url", target_id: "b" }),
        delivery({ consumer: "c2" }),
      ]);
      expect(await repo.getDeliveriesByEventId("EV000000000000000000000001")).toHaveLength(3);
    });
  });

  describe("beginDeliveryAttempt", () => {
    it("lets exactly one caller start, so a duplicate job sends nothing", async () => {
      await repo.insertDeliveries([delivery()]);
      const [row] = await repo.getDeliveriesByEventId("EV000000000000000000000001");
      expect(await repo.beginDeliveryAttempt(row.id, 1000)).toBe(true);
      expect(await repo.beginDeliveryAttempt(row.id, 1000)).toBe(false);
    });

    it("refuses to restart a delivered row", async () => {
      await repo.insertDeliveries([delivery({ status: "DELIVERED" })]);
      const [row] = await repo.getDeliveriesByEventId("EV000000000000000000000001");
      expect(await repo.beginDeliveryAttempt(row.id, 1000)).toBe(false);
    });
  });

  describe("getDueDeliveries", () => {
    it("returns pending and failed rows that have come due", async () => {
      await repo.insertDeliveries([
        delivery({ consumer: "due-pending", next_attempt_at: 500 }),
        delivery({ consumer: "due-failed", status: "FAILED", next_attempt_at: 500 }),
        delivery({ consumer: "not-yet", next_attempt_at: 5000 }),
        delivery({ consumer: "delivered", status: "DELIVERED", next_attempt_at: 500 }),
        delivery({ consumer: "dead", status: "DEAD", next_attempt_at: 500 }),
        delivery({ consumer: "shadow", status: "SHADOW", next_attempt_at: null }),
      ]);
      const due = await repo.getDueDeliveries(1000, 100);
      expect(due.map((d) => d.consumer).sort()).toEqual(["due-failed", "due-pending"]);
    });

    it("leaves in-flight rows alone, so a slow delivery is not sent twice", async () => {
      await repo.insertDeliveries([delivery({ status: "IN_FLIGHT", next_attempt_at: 500 })]);
      expect(await repo.getDueDeliveries(1000, 100)).toHaveLength(0);
    });
  });

  describe("reviveStuckDeliveries", () => {
    it("recovers a row whose worker died", async () => {
      await repo.insertDeliveries([delivery({ status: "IN_FLIGHT", last_attempt_at: 100 })]);
      expect(await repo.reviveStuckDeliveries(500, 1000)).toBe(1);
      const [row] = await repo.getDeliveriesByEventId("EV000000000000000000000001");
      expect(row.status).toBe("FAILED");
    });

    it("leaves a recently started row alone", async () => {
      await repo.insertDeliveries([delivery({ status: "IN_FLIGHT", last_attempt_at: 900 })]);
      expect(await repo.reviveStuckDeliveries(500, 1000)).toBe(0);
    });
  });

  describe("hasEarlierIncompleteDelivery", () => {
    it("blocks a later event while an earlier one on the aggregate is owed", async () => {
      const first = event({ aggregate_type: "incident", aggregate_id: "5" });
      const second = event({ aggregate_type: "incident", aggregate_id: "5" });
      await repo.insertEvent(first);
      await repo.insertEvent(second);
      const [a, b] = await repo.claimUnpublished(10, "t", 1000, 60);
      await repo.insertDeliveries([
        delivery({ event_id: a.event_id, consumer: "ord" }),
        delivery({ event_id: b.event_id, consumer: "ord" }),
      ]);

      expect(await repo.hasEarlierIncompleteDelivery("ord", "incident", "5", b.id)).toBe(true);
      expect(await repo.hasEarlierIncompleteDelivery("ord", "incident", "5", a.id)).toBe(false);
    });

    it("unblocks once the earlier delivery reaches a terminal state", async () => {
      const first = event({ aggregate_type: "incident", aggregate_id: "5" });
      const second = event({ aggregate_type: "incident", aggregate_id: "5" });
      await repo.insertEvent(first);
      await repo.insertEvent(second);
      const [a, b] = await repo.claimUnpublished(10, "t", 1000, 60);
      await repo.insertDeliveries([
        delivery({ event_id: a.event_id, consumer: "ord", status: "DELIVERED" }),
        delivery({ event_id: b.event_id, consumer: "ord" }),
      ]);
      expect(await repo.hasEarlierIncompleteDelivery("ord", "incident", "5", b.id)).toBe(false);
    });

    it("does not block across different aggregates or consumers", async () => {
      const first = event({ aggregate_type: "incident", aggregate_id: "5" });
      const second = event({ aggregate_type: "incident", aggregate_id: "6" });
      await repo.insertEvent(first);
      await repo.insertEvent(second);
      const [a, b] = await repo.claimUnpublished(10, "t", 1000, 60);
      await repo.insertDeliveries([delivery({ event_id: a.event_id, consumer: "ord" })]);
      expect(await repo.hasEarlierIncompleteDelivery("ord", "incident", "6", b.id)).toBe(false);
      expect(await repo.hasEarlierIncompleteDelivery("other", "incident", "5", b.id)).toBe(false);
    });
  });

  describe("retention", () => {
    it("prunes published events but never an undelivered one", async () => {
      const published = event({ occurred_at: 10 });
      const stuck = event({ occurred_at: 10 });
      await repo.insertEvent(published);
      await repo.insertEvent(stuck);
      await repo.markPublished([published.event_id], 10);

      expect(await repo.pruneEvents(1000)).toBe(1);
      expect(await repo.getEventByEventId(published.event_id)).toBeUndefined();
      // An event old enough to expire that still has not published is exactly
      // what an operator needs to see, so retention must not hide it.
      expect(await repo.getEventByEventId(stuck.event_id)).toBeDefined();
    });

    it("keeps DEAD deliveries, which are the record of what never arrived", async () => {
      await repo.insertDeliveries([
        delivery({ consumer: "ok", status: "DELIVERED", created_at: 10 }),
        delivery({ consumer: "gone", status: "DEAD", created_at: 10 }),
      ]);
      expect(await repo.pruneDeliveries(1000)).toBe(1);
      const left = await repo.getDeliveriesByEventId("EV000000000000000000000001");
      expect(left.map((d) => d.consumer)).toEqual(["gone"]);
    });
  });

  describe("resetDeliveryForRetry", () => {
    it("puts a DEAD row back on the ladder and refuses anything else", async () => {
      await repo.insertDeliveries([
        delivery({ consumer: "dead", status: "DEAD", attempts: 7 }),
        delivery({ consumer: "live", status: "DELIVERED" }),
      ]);
      const rows = await repo.getDeliveriesByEventId("EV000000000000000000000001");
      const dead = rows.find((r) => r.consumer === "dead")!;
      const done = rows.find((r) => r.consumer === "live")!;

      expect(await repo.resetDeliveryForRetry(dead.id, 2000)).toBe(true);
      expect(await repo.resetDeliveryForRetry(done.id, 2000)).toBe(false);
      const after = await repo.getDeliveryById(dead.id);
      expect(after).toMatchObject({ status: "PENDING", attempts: 0, next_attempt_at: 2000 });
    });
  });
});
