import type { EventConsumer } from "./types.js";

// The consumer registry.
//
// **It is deliberately empty.** H8 ships the bus with nothing on it: events are
// recorded, the relay publishes them, delivery rows are created for nobody, and
// not one byte leaves the process differently than it did before. That is the
// whole safety property of this phase - the outbox can be watched in production
// for as long as it takes to trust it, and if it is wrong the blast radius is
// rows in a table.
//
// Consumers arrive later and each is a registration, not a redesign:
//
//   E10 (P2)  incident-lifecycle webhooks, signed and retried
//   H8c (P2)  audit live; subscribers and triggers in *shadow*
//   E-cut1/2  the shadow-to-live flip, once a shadow diff shows no loss
//
// Ordering, honestly: `ordered: true` buys per-aggregate FIFO at the cost of a
// lock per delivery. Use it where order carries meaning (audit, page status) and
// not for fan-out, where one slow endpoint would head-of-line-block every other
// receiver. Unordered consumers get the event's `seq` so a receiver that cares
// can sort for itself.

const registry = new Map<string, EventConsumer>();

/**
 * Adds a consumer. Throws on a duplicate name, at boot rather than at delivery
 * time: `consumer` is a stored column, and two implementations sharing a name
 * would silently interleave their delivery rows.
 */
export function registerConsumer(consumer: EventConsumer): void {
  if (registry.has(consumer.name)) {
    throw new Error(`Event consumer "${consumer.name}" is already registered`);
  }
  registry.set(consumer.name, consumer);
}

/** Every consumer that is not `off`. */
export function activeConsumers(): EventConsumer[] {
  return [...registry.values()].filter((c) => c.mode !== "off");
}

export function getConsumer(name: string): EventConsumer | undefined {
  return registry.get(name);
}

/** Test seam. Never call this from application code. */
export function clearConsumers(): void {
  registry.clear();
}
