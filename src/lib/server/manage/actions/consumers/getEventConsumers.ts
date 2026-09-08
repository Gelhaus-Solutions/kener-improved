import db from "$lib/server/db/db.js";
import { currentOrgId } from "$lib/server/events/eventContext.js";
import { registerAllConsumers, ALL_CONSUMERS, CONSUMER_DESCRIPTIONS } from "$lib/server/events/consumers/index.js";
import { configuredModes } from "$lib/server/events/consumerModes.js";
import { SHADOW_PAIRS } from "$lib/server/events/shadowDiff.js";
import type { ActionDefinition } from "../../types.js";
import type { ConsumerMode } from "$lib/server/events/types.js";

/**
 * The event bus consumers and what each is currently allowed to do.
 *
 * `registerAllConsumers` is called here because this action runs in the web
 * process, which never starts the relay and so never registered anything. It
 * registers nothing that runs: see events/consumers/index.ts for why holding the
 * registry in this process is inert.
 */
export default {
  action: "getEventConsumers",
  handler: async () => {
    registerAllConsumers();

    const orgId = currentOrgId();
    const configured = await configuredModes();

    // One grouped query rather than one per consumer per status. The delivery
    // table is the largest in the schema on a busy instance and this screen is
    // not worth six scans of it.
    const counts = await db.getDeliveryCountsByConsumer(orgId);

    return {
      consumers: ALL_CONSUMERS.map((c) => ({
        name: c.name,
        description: CONSUMER_DESCRIPTIONS[c.name] ?? "",
        // What the code ships with, shown beside the operator's setting so a
        // screen that has never been touched still explains itself.
        declared_mode: c.mode as ConsumerMode,
        configured_mode: configured[c.name] ?? null,
        effective_mode: (configured[c.name] ?? c.mode) as ConsumerMode,
        supports_dry_run: c.supportsDryRun === true,
        ordered: c.ordered === true,
        /** The legacy consumer this one is rehearsing against, when it is a shadow pair. */
        legacy_consumer: SHADOW_PAIRS[c.name] ?? null,
        counts: counts[c.name] ?? {},
      })),
    };
  },
} satisfies ActionDefinition;
