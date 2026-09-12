import type { AnyActionDefinition } from "./types.js";

// Build the action registry from the file tree, the same way
// src/lib/server/api-server/index.ts builds its route table. Copying that
// pattern rather than inventing a second one means there is one thing to
// understand about how handlers are discovered in this codebase.
//
// One file per action at actions/<domain>/<action>.ts, default-exporting an
// ActionDefinition. The domain folder is organisational only: the registry is
// keyed by `action`, so moving a file between domains changes nothing at
// runtime.
//
// Scoped and eager, so the registry is fully built at module load and a lookup
// is a plain object read rather than ~100 string comparisons.
//
// **Test files are excluded, and that is not tidiness.** `eager` imports execute
// the module, so a co-located `*.test.ts` runs its top level inside the
// production bundle: a `vi.mock` call there throws "Vitest mocker was not
// initialized in this environment" during `vite build`, long after `npm run
// check` and `npm test` have both passed. The loop below tolerates a module with
// no default export, which is why this was invisible until a build.
//
// `api-server/index.ts` already avoids this by listing the four method
// filenames it wants. This registry cannot, because an action file is named
// after its action, so it subtracts instead.
const modules = import.meta.glob<{ default: AnyActionDefinition }>(["./actions/*/*.ts", "!./actions/*/*.test.ts"], {
  eager: true,
});

const registry = new Map<string, AnyActionDefinition>();

for (const path in modules) {
  const def = modules[path]?.default;
  if (!def) {
    console.warn(`manage registry: ${path} has no default export, skipping`);
    continue;
  }

  // The filename and the action string must agree. They are looked up by
  // different things (humans by filename, clients by action string) and a
  // mismatch is silent and maddening, so fail loudly at boot instead.
  const expected = path.match(/\/([^/]+)\.ts$/)?.[1];
  if (expected && expected !== def.action) {
    throw new Error(`manage registry: ${path} declares action "${def.action}" but the file is named "${expected}.ts"`);
  }

  for (const key of [def.action, ...(def.aliases ?? [])]) {
    if (registry.has(key)) {
      throw new Error(`manage registry: action "${key}" is registered twice (second one at ${path})`);
    }
    registry.set(key, def);
  }
}

/** The definition for `action`, or undefined when it has not been migrated yet. */
export function getActionDefinition(action: string): AnyActionDefinition | undefined {
  return registry.get(action);
}

/** Every registered action string. Used by the sync-time upstream action diff. */
export function registeredActions(): string[] {
  return [...registry.keys()].sort();
}
