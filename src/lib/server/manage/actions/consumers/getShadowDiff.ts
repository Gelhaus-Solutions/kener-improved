import db from "$lib/server/db/db.js";
import { currentOrgId } from "$lib/server/events/eventContext.js";
import { diffEvent, isBlocking, SHADOW_PAIRS } from "$lib/server/events/shadowDiff.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";
import type { DiffRow } from "$lib/server/events/shadowDiff.js";
import type { EventDeliveryRecord } from "$lib/server/events/types.js";

interface Payload {
  consumer?: string;
  page?: number;
  limit?: number;
  /** Show only the verdicts that would block a cutover. */
  blocking_only?: boolean;
}

/**
 * The shadow diff: what a rehearsing consumer would have sent, against what was
 * actually sent.
 *
 * Paged over *events* rather than over rows, because a verdict only means
 * something in the context of one event's full recipient list: "the rehearsal
 * missed this address" can only be said after seeing every address on both
 * sides, and a page boundary in the middle of an event would invent findings.
 */
export default {
  action: "getShadowDiff",
  handler: async (data: Payload) => {
    const consumer = String(data.consumer ?? "subscribers");
    const legacyConsumer = SHADOW_PAIRS[consumer];
    if (!legacyConsumer) {
      throw new ActionError(400, `"${consumer}" has no legacy counterpart to compare against`);
    }

    const page = Math.max(1, Number(data.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(data.limit) || 25));
    const orgId = currentOrgId();

    // The events either side produced anything for, newest first. Taken from
    // both consumers and not just the shadow one: an event the rehearsal skipped
    // entirely is the MISSING_SHADOW case, and looking only at rehearsal rows
    // would be looking only where the answer cannot be.
    const eventIds = await db.getShadowDiffEventIds(orgId, consumer, legacyConsumer, page, limit);
    const total = await db.getShadowDiffEventCount(orgId, consumer, legacyConsumer);

    const rows: DiffRow[] = [];
    for (const eventId of eventIds) {
      const [deliveries, event] = await Promise.all([
        db.getEventDeliveriesByEventId(eventId),
        db.getEventByEventId(eventId),
      ]);
      const shadow = deliveries.filter((d: EventDeliveryRecord) => d.consumer === consumer);
      const live = deliveries.filter((d: EventDeliveryRecord) => d.consumer === legacyConsumer);
      rows.push(
        ...diffEvent({
          event_id: eventId,
          event_type: event?.type ?? null,
          occurred_at: event?.occurred_at ?? null,
          consumer,
          legacy_consumer: legacyConsumer,
          shadow,
          live,
        }),
      );
    }

    const summary = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
      return acc;
    }, {});

    return {
      rows: data.blocking_only ? rows.filter((r) => isBlocking(r.verdict)) : rows,
      // Always over every row on the page, never over the filtered set: a
      // summary that changed when a filter was applied would be useless for
      // answering "is this consumer safe to flip".
      summary,
      consumer,
      legacy_consumer: legacyConsumer,
      pairs: Object.keys(SHADOW_PAIRS),
      total,
      page,
      limit,
    };
  },
} satisfies ActionDefinition<Payload>;
