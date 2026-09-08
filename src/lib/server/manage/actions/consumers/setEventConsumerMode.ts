import { InsertKeyValue } from "$lib/server/controllers/controller.js";
import { GetSiteDataByKey } from "$lib/server/controllers/siteDataController.js";
import { registerAllConsumers, ALL_CONSUMERS } from "$lib/server/events/consumers/index.js";
import { CONSUMER_MODES_KEY, invalidateConsumerModes } from "$lib/server/events/consumerModes.js";
import { getConsumer } from "$lib/server/events/consumers.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";
import type { ConsumerMode } from "$lib/server/events/types.js";

interface Payload {
  name: string;
  mode: ConsumerMode;
}

const MODES: ConsumerMode[] = ["off", "legacy", "shadow", "live"];

/**
 * Changes one consumer's mode.
 *
 * This is the whole strangler switch: one `site_data` write, reversible in
 * seconds, no deploy. The value of that is entirely in how fast it can be
 * *undone*, which is why the write is a single key and why nothing here is
 * cached for longer than the ten seconds `consumerModes.ts` documents.
 *
 * The guard below is not a formality. `subscribers` and `triggers` still have
 * live counterparts sending every notification they rehearse, so setting either
 * to `live` from this screen would double every subscriber email and every alert
 * notification the instance sends. Turning them live is a code change in P6 that
 * silences the old call site in the same commit, not a click.
 */
export default {
  action: "setEventConsumerMode",
  audit: { targetType: "event_consumer" },
  handler: async (data: Payload) => {
    registerAllConsumers();

    const name = String(data.name ?? "");
    const mode = String(data.mode ?? "") as ConsumerMode;

    if (!getConsumer(name)) {
      throw new ActionError(400, `Unknown event consumer "${name}"`);
    }
    if (!MODES.includes(mode)) {
      throw new ActionError(400, `Mode must be one of: ${MODES.join(", ")}`);
    }

    const consumer = ALL_CONSUMERS.find((c) => c.name === name);
    if (mode === "live" && consumer?.mode === "shadow") {
      throw new ActionError(
        400,
        `"${name}" cannot be set live from here. Its existing send path is still running, so going live would send every notification twice. The cutover silences that path in the same change.`,
      );
    }

    const existing = await GetSiteDataByKey(CONSUMER_MODES_KEY);
    const modes = existing && typeof existing === "object" ? { ...(existing as Record<string, string>) } : {};
    modes[name] = mode;

    await InsertKeyValue(CONSUMER_MODES_KEY, JSON.stringify(modes));

    // Courtesy only, and worth being honest about: this drops the cache in the
    // process that served the click. The scheduler process, which is the one
    // that actually delivers, still waits out its own ten seconds. The TTL is
    // the contract; this just makes the screen agree with itself immediately.
    invalidateConsumerModes();

    return { success: true, name, mode };
  },
} satisfies ActionDefinition<Payload>;
