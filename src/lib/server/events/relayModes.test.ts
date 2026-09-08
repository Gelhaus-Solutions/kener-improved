import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// What kind of delivery row each consumer mode produces.
//
// This mapping is the whole safety property of the strangler switch, and every
// one of its four answers is a different promise to the operator:
//
//   off      nothing is recorded, so nothing can be sent
//   legacy   a terminal record of who would have been notified
//   shadow   a rehearsal that must reach the dispatcher to render, but must
//            never reach the network
//   live     an ordinary delivery
//
// The mistake worth guarding against is the third one collapsing into the
// fourth: a shadow row created PENDING is a row the dispatcher will pick up, and
// if the dry-run guard were ever wrong that row would be a real notification
// sent during what an operator was told is a rehearsal.

const claimUnpublishedEvents = vi.fn();
const insertEventDeliveries = vi.fn();
const getPendingDeliveriesForEvents = vi.fn();
const markEventsPublished = vi.fn();

vi.mock("../db/db.js", () => ({
  default: {
    claimUnpublishedEvents: (...args: unknown[]) => claimUnpublishedEvents(...args),
    insertEventDeliveries: (...args: unknown[]) => insertEventDeliveries(...args),
    getPendingDeliveriesForEvents: (...args: unknown[]) => getPendingDeliveriesForEvents(...args),
    markEventsPublished: (...args: unknown[]) => markEventsPublished(...args),
  },
}));

const mode = vi.fn();
vi.mock("./consumerModes.js", () => ({
  consumerMode: (name: string, declared: string) => mode(name, declared),
}));

const { runRelayPass } = await import("./relay.js");
const { registerConsumer, clearConsumers } = await import("./consumers.js");
import type { EventConsumer } from "./types.js";

function consumer(over: Partial<EventConsumer> & { name: string }): EventConsumer {
  return {
    mode: "live",
    targets: () => [{ target_type: "endpoint", target_id: "1" }],
    deliver: async () => ({ ok: true }),
    ...over,
  };
}

const outboxEvent = {
  id: 1,
  event_id: "01EVENT",
  org_id: 1,
  type: "incident.created",
  aggregate_type: "incident",
  aggregate_id: "4",
  actor_type: "user",
  actor_id: "9",
  actor_label: null,
  occurred_at: 1000,
  payload: null,
  diff: null,
  correlation_id: null,
  causation_id: null,
  idempotency_key: null,
  suppress: false,
  schema_version: 1,
  claimed_at: null,
  claimed_by: null,
  published_at: null,
};

/** The rows one relay pass would insert, for a single registered consumer. */
async function rowsFor(c: EventConsumer, effective: string) {
  clearConsumers();
  registerConsumer(c);
  mode.mockImplementation(() => Promise.resolve(effective));
  insertEventDeliveries.mockClear();
  claimUnpublishedEvents.mockResolvedValue([outboxEvent]);
  getPendingDeliveriesForEvents.mockResolvedValue([]);
  markEventsPublished.mockResolvedValue(undefined);

  await runRelayPass(async () => {});
  return insertEventDeliveries.mock.calls[0][0] as { status: string; next_attempt_at: number | null }[];
}

beforeEach(() => {
  clearConsumers();
  vi.clearAllMocks();
});

afterEach(() => clearConsumers());

describe("relay delivery rows by consumer mode", () => {
  it("writes nothing at all when a consumer is off", async () => {
    expect(await rowsFor(consumer({ name: "c" }), "off")).toEqual([]);
  });

  it("writes a terminal SKIPPED row in legacy mode", async () => {
    const rows = await rowsFor(consumer({ name: "c" }), "legacy");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SKIPPED");
    // Terminal: nothing due means the sweeper will never pick it up and send it.
    expect(rows[0].next_attempt_at).toBeNull();
  });

  it("writes a terminal SHADOW row when the consumer cannot rehearse", async () => {
    // Without dry-run support there is nothing safe to dispatch: calling
    // deliver() would send for real.
    const rows = await rowsFor(consumer({ name: "c", supportsDryRun: false }), "shadow");
    expect(rows[0].status).toBe("SHADOW");
    expect(rows[0].next_attempt_at).toBeNull();
  });

  it("dispatches a rehearsal when the consumer supports dry run", async () => {
    // PENDING and due now, so the row travels the real dispatch path and the
    // consumer gets to render. Only the outbound call is suppressed, by the
    // dispatcher, which is what makes the rehearsal worth anything.
    const rows = await rowsFor(consumer({ name: "c", supportsDryRun: true }), "shadow");
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].next_attempt_at).not.toBeNull();
  });

  it("writes an ordinary pending row when live", async () => {
    const rows = await rowsFor(consumer({ name: "c" }), "live");
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].next_attempt_at).not.toBeNull();
  });

  it("records nothing for a suppressed event, whatever the mode", async () => {
    // Bulk imports and replays set this so a year of backfilled incidents does
    // not page anyone.
    clearConsumers();
    registerConsumer(consumer({ name: "c" }));
    mode.mockResolvedValue("live");
    insertEventDeliveries.mockClear();
    claimUnpublishedEvents.mockResolvedValue([{ ...outboxEvent, suppress: true }]);
    getPendingDeliveriesForEvents.mockResolvedValue([]);
    markEventsPublished.mockResolvedValue(undefined);

    await runRelayPass(async () => {});
    expect(insertEventDeliveries.mock.calls[0][0]).toEqual([]);
  });

  it("keeps publishing when one consumer throws while resolving targets", async () => {
    // An event stuck unpublished blocks nothing but grows the backlog forever,
    // so one broken consumer must not hold up the others or the event itself.
    clearConsumers();
    registerConsumer(
      consumer({
        name: "broken",
        targets: () => {
          throw new Error("nope");
        },
      }),
    );
    registerConsumer(consumer({ name: "healthy" }));
    mode.mockResolvedValue("live");
    insertEventDeliveries.mockClear();
    claimUnpublishedEvents.mockResolvedValue([outboxEvent]);
    getPendingDeliveriesForEvents.mockResolvedValue([]);
    markEventsPublished.mockResolvedValue(undefined);

    const result = await runRelayPass(async () => {});
    const rows = insertEventDeliveries.mock.calls[0][0] as { consumer: string }[];
    expect(rows.map((r) => r.consumer)).toEqual(["healthy"]);
    expect(markEventsPublished).toHaveBeenCalled();
    expect(result.claimed).toBe(1);
  });
});
