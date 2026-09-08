import db from "../db/db.js";
import type { AuditLogInsert } from "../types/db.js";

// Batched audit writer.
//
// Auditing must not be something anyone is tempted to switch off, which means it
// must not cost the request anything. `record()` pushes onto an in-memory buffer
// and returns synchronously; the flush happens on a timer, off the request path.
//
// The tradeoff is explicit: a hard process kill loses up to FLUSH_INTERVAL_MS of
// buffered rows. That is accepted because the alternative, a synchronous insert
// per admin action, adds a round trip to every write in the product and is the
// kind of cost that gets an audit log disabled. A graceful shutdown flushes, and
// the outbox in P2 is what eventually makes this durable end to end.

const FLUSH_INTERVAL_MS = 500;
const FLUSH_AT_ROWS = 50;

// Bounded so a database outage cannot turn an audit backlog into an OOM. Past
// the cap the oldest rows are dropped and the loss is logged, because dropping
// audit rows silently is worse than the outage.
const MAX_BUFFERED = 5000;

let buffer: AuditLogInsert[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let dropped = 0;
let flushing = false;

async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (flushing || buffer.length === 0) return;

  flushing = true;
  const rows = buffer;
  buffer = [];
  try {
    await db.insertAuditLogMany(rows);
    if (dropped > 0) {
      console.error(`audit: dropped ${dropped} row(s) while the buffer was full`);
      dropped = 0;
    }
  } catch (error) {
    console.error(`audit: failed to write ${rows.length} row(s):`, error);
    // Put them back at the front so a transient failure retries rather than
    // discarding evidence, but respect the cap: a permanent failure must not
    // grow without bound.
    buffer = [...rows, ...buffer].slice(0, MAX_BUFFERED);
  } finally {
    flushing = false;
    if (buffer.length > 0) schedule();
  }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
  // Never hold the process open for an audit flush.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

/** Queues one audit row. Returns immediately; the write happens on the timer. */
export function record(row: AuditLogInsert): void {
  if (buffer.length >= MAX_BUFFERED) {
    buffer.shift();
    dropped++;
  }
  buffer.push(row);
  if (buffer.length >= FLUSH_AT_ROWS) {
    void flush();
    return;
  }
  schedule();
}

/** Flushes everything buffered. Called on shutdown; safe to call any time. */
export async function flushAuditLog(): Promise<void> {
  await flush();
}

/** Buffered row count, for tests and diagnostics. */
export function pendingAuditRows(): number {
  return buffer.length;
}
