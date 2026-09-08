import { consumerMode } from "./consumerModes.js";
import type { ConsumerMode, EventConsumer } from "./types.js";

// The consumer registry.
//
// H8c filled it: `audit` and `webhook` live, `subscribers` and `triggers` in
// shadow until the P6 cutover. What each consumer is allowed to do is not
// decided here - it is read per event from `site_data.eventBusConsumers`, so a
// channel can be moved onto the bus and moved back without a deploy.
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

/**
 * The mode this consumer is actually running in.
 *
 * Always go through here. `consumer.mode` is only the declared default, and the
 * operator's setting in `site_data` is what decides whether anything is sent.
 */
export async function effectiveMode(consumer: EventConsumer): Promise<ConsumerMode> {
  return await consumerMode(consumer.name, consumer.mode);
}

/** Every registered consumer, whatever mode it is in. Used by the admin screen. */
export function allConsumers(): EventConsumer[] {
  return [...registry.values()];
}

/**
 * Every consumer that is doing something, paired with the mode it is doing it
 * in.
 *
 * `off` consumers are dropped here rather than in the relay so that the relay
 * never has to think about the flag at all: it asks what is active and gets an
 * answer that already accounts for the operator's setting.
 */
export async function activeConsumers(): Promise<{ consumer: EventConsumer; mode: ConsumerMode }[]> {
  const out: { consumer: EventConsumer; mode: ConsumerMode }[] = [];
  for (const consumer of registry.values()) {
    const mode = await effectiveMode(consumer);
    if (mode !== "off") out.push({ consumer, mode });
  }
  return out;
}

export function getConsumer(name: string): EventConsumer | undefined {
  return registry.get(name);
}

/** Test seam. Never call this from application code. */
export function clearConsumers(): void {
  registry.clear();
}
