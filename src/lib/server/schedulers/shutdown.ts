import appScheduler from "./appScheduler";
import monitorSchedulers from "./monitorSchedulers";
import maintenanceScheduler from "./maintenanceScheduler";
import dailyCleanupScheduler from "./dailyCleanup";
// Fork-added schedulers. `rollupScheduler` was started in `startup.ts` but never
// closed here, so its BullMQ worker outlived a SIGTERM and kept a Redis
// connection open through a graceful shutdown. Both are registered now.
import rollupScheduler from "./rollupScheduler";
import slaScheduler from "./slaScheduler";

export default async () => {
  await appScheduler.shutdown();
  await monitorSchedulers.shutdown();
  await maintenanceScheduler.shutdown();
  await dailyCleanupScheduler.shutdown();
  await rollupScheduler.shutdown();
  await slaScheduler.shutdown();
};
