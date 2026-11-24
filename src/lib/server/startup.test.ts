import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const started = vi.hoisted(() => [] as string[]);
const service = vi.hoisted(() => (name: string) => ({
  default: { start: async () => void started.push(name), shutdown: async () => {} },
}));

vi.mock("./schedulers/appScheduler.js", () => service("appScheduler"));
vi.mock("./schedulers/maintenanceScheduler.js", () => service("maintenanceScheduler"));
vi.mock("./schedulers/dailyCleanup.js", () => service("dailyCleanup"));
vi.mock("./schedulers/rollupScheduler.js", () => service("rollupScheduler"));
vi.mock("./schedulers/slaScheduler.js", () => service("slaScheduler"));
vi.mock("./schedulers/certificateScheduler.js", () => service("certificateScheduler"));
vi.mock("./schedulers/reportScheduler.js", () => service("reportScheduler"));
vi.mock("./queues/eventRelayQueue.js", () => service("eventRelayQueue"));
vi.mock("./queues/backfillQueue.js", () => service("backfillQueue"));
vi.mock("./probes/wsServer.js", () => service("probeWsServer"));
vi.mock("./standby/pull.js", () => service("standbyPuller"));
vi.mock("./events/consumers/index.js", () => ({ registerAllConsumers: () => void started.push("consumers") }));
vi.mock("./proxy.js", () => ({ InstallEnvProxy: () => {} }));
vi.mock("./cache/siteDataCache.js", () => ({ InvalidateAllSiteDataCaches: async () => {} }));
vi.mock("./db/db.js", () => ({ default: { getAllOrgs: async () => [{ id: 1 }] } }));
vi.mock("./db/orgContext.js", () => ({ runAcrossOrgs: async (fn: () => Promise<unknown>) => fn() }));
vi.mock("./controllers/commonController.js", () => ({ SecretKeyWarning: () => null }));
vi.mock("../version.js", () => ({ default: () => "0.0.0-test" }));
vi.mock("figlet", () => ({ default: () => {} }));

import Startup from "./startup.js";

const PRIMARY_WORK = [
  "appScheduler",
  "maintenanceScheduler",
  "dailyCleanup",
  "rollupScheduler",
  "slaScheduler",
  "certificateScheduler",
  "reportScheduler",
  "consumers",
  "eventRelayQueue",
  "backfillQueue",
  "probeWsServer",
];

const saved = process.env.KENER_ROLE;
beforeEach(() => {
  started.length = 0;
});
afterEach(() => {
  if (saved === undefined) delete process.env.KENER_ROLE;
  else process.env.KENER_ROLE = saved;
});

describe("Startup by role", () => {
  it("starts every scheduler, the relay and the probe listener on a primary, and no puller", async () => {
    delete process.env.KENER_ROLE;
    await Startup();
    expect(started).toEqual(PRIMARY_WORK);
  });

  it("starts only the puller on a standby: no scheduler, worker or probe WebSocket server", async () => {
    process.env.KENER_ROLE = "standby";
    await Startup();
    expect(started).toEqual(["standbyPuller"]);
  });

  it("starts nothing when KENER_ROLE is not a role", async () => {
    process.env.KENER_ROLE = "secondary";
    await expect(Startup()).rejects.toThrow(/KENER_ROLE/);
    expect(started).toEqual([]);
  });
});
