import { AsyncLocalStorage } from "node:async_hooks";
import type { Knex as KnexType } from "knex";

// Ambient database transactions.
//
// Knex transactions are explicit: `knex.transaction(trx => ...)` hands you a
// `trx` you must then thread through every call. Kener has twelve repositories
// and a few hundred methods, none of which accept one, so in practice almost
// nothing is transactional (there are exactly three `knex.transaction(` call
// sites in the whole application).
//
// Rather than add a `trx` parameter everywhere, the active transaction is
// carried in AsyncLocalStorage and picked up by the `BaseRepository.knex`
// getter, which already resolves its connection per call. A repository method
// written years ago becomes transactional simply by being called inside
// `db.withTransaction(...)`, with no signature change.
//
// This mirrors poolContext.ts, which does the same trick to route background
// work to the worker connection pool. The two nest correctly and the
// transaction wins: inside a job, queries go to the worker pool, and inside a
// transaction started in that job, they go to the transaction (which is itself
// bound to a worker-pool connection).
//
// A Knex.Transaction is API-compatible with Knex for query building, which is
// what makes the substitution invisible to callers.

const trxStorage = new AsyncLocalStorage<KnexType.Transaction>();

/** Runs `fn` with every repository query routed through `trx`. */
export function runInTrx<T>(trx: KnexType.Transaction, fn: () => Promise<T>): Promise<T> {
  return trxStorage.run(trx, fn);
}

/** The transaction for the current context, or undefined when there is none. */
export function getTrx(): KnexType.Transaction | undefined {
  return trxStorage.getStore();
}
