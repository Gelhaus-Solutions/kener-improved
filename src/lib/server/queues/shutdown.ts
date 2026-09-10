import monitorResponseQueue from "./monitorResponseQueue";
import monitorExecuteQueue from "./monitorExecuteQueue";
import alertingQueue from "./alertingQueue";
import subscriberQueue from "./subscriberQueue";
import emailQueue from "./emailQueue";
import eventRelayQueue from "./eventRelayQueue";
import eventDispatchQueue from "./eventDispatchQueue";
import backfillQueue from "./backfillQueue";
import rollupScheduler from "../schedulers/rollupScheduler";
import { flushAuditLog } from "../audit/writer";
import { shutdownLiveHub } from "../live/hub";

export default async () => {
  await monitorExecuteQueue.shutdown();
  await monitorResponseQueue.shutdown();
  await alertingQueue.shutdown();
  await subscriberQueue.shutdown();
  await emailQueue.shutdown();
  // Relay before dispatch: stopping the producer first means the dispatch worker
  // drains what it already has instead of racing a fresh batch of deliveries.
  await eventRelayQueue.shutdown();
  await eventDispatchQueue.shutdown();
  // C7. A half-written overlay is harmless - the job is idempotent and BullMQ
  // redelivers it - so this closes rather than draining.
  await backfillQueue.stop();
  // F6b. Same reasoning as the backfill queue: a rollup pass killed halfway
  // leaves the hours it had not reached still marked dirty, and the next boot
  // recomputes them. Nothing to drain.
  await rollupScheduler.shutdown();
  // G5. Closes the one subscriber this process holds. Nothing is buffered that
  // matters: an SSE stream is a courtesy and a dropped one reconnects.
  await shutdownLiveHub();
  // Last: the audit writer buffers for up to half a second, so anything the
  // shutdowns above recorded is still in memory at this point.
  await flushAuditLog();
};
