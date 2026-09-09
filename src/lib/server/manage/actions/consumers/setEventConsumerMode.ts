import { InsertKeyValue } from "$lib/server/controllers/controller.js";
import { GetSiteDataByKey } from "$lib/server/controllers/siteDataController.js";
import { registerAllConsumers, UNCUT_CONSUMERS } from "$lib/server/events/consumers/index.js";
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
 * The guard below is not a formality. A consumer in `UNCUT_CONSUMERS` still has
 * a live counterpart sending every notification it rehearses, so setting it to
 * `live` from this screen would double every one of them.
 *
 * `subscribers` is no longer in that set: E-cut1 taught `subscriberQueue.push`
 * to stand down once the consumer is live, so the flip is now genuinely an
 * operator's decision to make from this screen, taken with the shadow diff in
 * front of them, and undone the same way.
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

    if (mode === "live" && UNCUT_CONSUMERS.has(name)) {
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
