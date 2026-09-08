import figlet from "figlet";
import version from "../version.js";
import mainScheduler from "./schedulers/appScheduler.js";
import maintenanceScheduler from "./schedulers/maintenanceScheduler.js";
import dailyCleanupScheduler from "./schedulers/dailyCleanup.js";
import eventRelayQueue from "./queues/eventRelayQueue.js";
import { registerConsumer } from "./events/consumers.js";
import webhookConsumer from "./events/consumers/webhooks.js";
import { InstallEnvProxy } from "./proxy.js";
import { InvalidateSiteDataCache } from "./cache/siteDataCache.js";

process.env.TZ = "UTC";

async function Startup(): Promise<void> {
  // After dotenv: main.ts calls dotenv.config() in its body, which runs after static imports,
  // so this cannot be module top-level. Covers fetch (triggers, Resend, OIDC) and the global agents.
  InstallEnvProxy();
  // Seeds insert missing site_data keys through knex, with no way to reach the
  // cache. main.ts runs them just before this, so drop the cache once on boot;
  // otherwise a warm Redis could mask a newly seeded key for the whole TTL.
  await InvalidateSiteDataCache();
  await mainScheduler.start();
  await maintenanceScheduler.start();
  await dailyCleanupScheduler.start();
  // Consumers must be registered before the relay starts, or the first pass
  // publishes events with no delivery rows and they are never reconsidered.
  registerConsumer(webhookConsumer);

  // Last of the schedulers, and only in this process: the relay and its dispatch
  // worker belong together, and the web process must never become one.
  await eventRelayQueue.start();

  const runtimeVersion = version();

  figlet("Kener v" + runtimeVersion, function (err, data) {
    if (err) {
      console.log("Something went wrong...");
      return;
    }
    console.log(data);
    console.log(`Kener version ${runtimeVersion} is running!`);
  });
}

// Call Startup() when run directly (works with both tsx and vite-node)
const isMainModule = process.argv[1]?.includes("startup") || process.argv[1]?.includes("vite-node");

if (isMainModule) {
  Startup();
}

export default Startup;
