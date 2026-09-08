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

// ---------------------------------------------------------------------------
// After-commit hooks.
//
// The rule that transaction bodies must not enqueue work is not a style
// preference: a BullMQ job added inside a transaction can be picked up by a
// worker before the transaction commits, and that worker then reads state which
// does not exist yet. But the code that knows work is needed is usually the code
// inside the transaction, and asking every caller to thread a "and afterwards do
// this" value back out to its caller is exactly the plumbing ambient
// transactions exist to avoid.
//
// So a hook registered here runs once the outermost transaction has committed,
// and not at all if it rolls back. Outside a transaction it runs immediately,
// which makes `afterCommit(...)` correct to call unconditionally.

export type AfterCommitHook = () => void | Promise<void>;

const hookStorage = new AsyncLocalStorage<AfterCommitHook[]>();

/**
 * Registers `fn` to run after the current transaction commits, or immediately if
 * there is no transaction.
 *
 * A hook that throws is logged and otherwise ignored: the transaction is already
 * committed by the time it runs, so there is nothing left to undo and failing
 * the caller would misreport durable work as lost.
 */
export function afterCommit(fn: AfterCommitHook): void {
  const hooks = hookStorage.getStore();
  if (!hooks) {
    void Promise.resolve()
      .then(fn)
      .catch((error) => console.error("afterCommit hook failed:", error));
    return;
  }
  hooks.push(fn);
}

/** Runs every hook `fn` registered, in registration order. Never throws. */
export async function runAfterCommitHooks(hooks: AfterCommitHook[]): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      console.error("afterCommit hook failed:", error);
    }
  }
}

/** Wraps `fn` so `afterCommit` inside it collects into `hooks`. */
export function collectAfterCommitHooks<T>(hooks: AfterCommitHook[], fn: () => Promise<T>): Promise<T> {
  return hookStorage.run(hooks, fn);
}
