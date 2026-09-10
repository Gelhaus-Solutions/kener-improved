import figlet from "figlet";
import version from "../version.js";
import mainScheduler from "./schedulers/appScheduler.js";
import maintenanceScheduler from "./schedulers/maintenanceScheduler.js";
import dailyCleanupScheduler from "./schedulers/dailyCleanup.js";
import rollupScheduler from "./schedulers/rollupScheduler.js";
import slaScheduler from "./schedulers/slaScheduler.js";
import eventRelayQueue from "./queues/eventRelayQueue.js";
import backfillQueue from "./queues/backfillQueue.js";
import { registerAllConsumers } from "./events/consumers/index.js";
import { InstallEnvProxy } from "./proxy.js";
import { InvalidateAllSiteDataCaches } from "./cache/siteDataCache.js";
import db from "./db/db.js";
import { runAcrossOrgs } from "./db/orgContext.js";

process.env.TZ = "UTC";

async function Startup(): Promise<void> {
  // After dotenv: main.ts calls dotenv.config() in its body, which runs after static imports,
  // so this cannot be module top-level. Covers fetch (triggers, Resend, OIDC) and the global agents.
  InstallEnvProxy();
  // Seeds insert missing site_data keys through knex, with no way to reach the
  // cache. main.ts runs them just before this, so drop the cache once on boot;
  // otherwise a warm Redis could mask a newly seeded key for the whole TTL.
  //
  // Every org, not just the default one. This used to call the single-org
  // invalidation with no org context, which resolves to org 1 - so on a
  // multi-tenant instance the boot drop covered one tenant and left every other
  // reading a pre-migration cache that outlives the restart by 300 seconds.
  await runAcrossOrgs(async () => {
    const orgs = await db.getAllOrgs();
    await InvalidateAllSiteDataCaches(orgs.map((o) => o.id));
  });
  await mainScheduler.start();
  await maintenanceScheduler.start();
  await dailyCleanupScheduler.start();
  // F6b. Scheduler process only, like the relay and the backfill queue: it reads
  // and writes the largest table in the schema, and the web process must never
  // be the thing doing that.
  await rollupScheduler.start();
  // F1a. Scheduler process only, like the rollups it reads: it recomputes every
  // SLO target every five minutes, and the web process must never be doing that
  // on a page load.
  await slaScheduler.start();
  // Consumers must be registered before the relay starts, or the first pass
  // publishes events with no delivery rows and they are never reconsidered.
  // What each one is allowed to do is not decided here: it is read per event
  // from `site_data.eventBusConsumers`, so an operator can pull a consumer back
  // to shadow without a deploy. See events/consumerModes.ts.
  registerAllConsumers();

  // Last of the schedulers, and only in this process: the relay and its dispatch
  // worker belong together, and the web process must never become one.
  await eventRelayQueue.start();

  // C7. In this process for the same reason the relay is: writing a hundred
  // thousand `monitoring_data` rows is scheduler work, and the web process must
  // never be the thing doing it.
  await backfillQueue.start();

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
