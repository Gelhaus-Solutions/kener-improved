import monitorResponseQueue from "./monitorResponseQueue";
import monitorExecuteQueue from "./monitorExecuteQueue";
import alertingQueue from "./alertingQueue";
import subscriberQueue from "./subscriberQueue";
import emailQueue from "./emailQueue";
import eventRelayQueue from "./eventRelayQueue";
import eventDispatchQueue from "./eventDispatchQueue";
import { flushAuditLog } from "../audit/writer";

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
  // Last: the audit writer buffers for up to half a second, so anything the
  // shutdowns above recorded is still in memory at this point.
  await flushAuditLog();
};
