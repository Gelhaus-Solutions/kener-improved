#!/usr/bin/env node
/**
 * Reports admin actions upstream has that this fork's registry does not, and
 * vice versa.
 *
 * Why this exists. After the registry migration,
 * `src/routes/(manage)/manage/api/+server.ts` is seven lines and bears no
 * resemblance to upstream's ~930. Taking that conflict on every sync is pure
 * cost, so the file is `merge=ours` in `.gitattributes`. But `merge=ours`
 * silently drops upstream's edits to the entire admin API, and the edit we most
 * need to see is "upstream added an action" - which would otherwise reach us as
 * nothing at all, and surface months later as a UI button that 400s.
 *
 * So the conflict is converted into a to-do list. Instead of a merge we cannot
 * resolve, the sync produces a sentence naming what to write.
 *
 * Both sides are read as text rather than executed: the registry is assembled by
 * Vite's `import.meta.glob` at runtime, which a sync script has no way to
 * evaluate, and upstream's file is a merge stage that may not even parse.
 *
 * Usage:
 *   node scripts/diff-upstream-actions.mjs <upstream-file> [--update-snapshot]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ACTIONS_DIR = "src/lib/server/manage/actions";
const SNAPSHOT = "docs/agents/upstream-manage-api.snapshot.ts";

/** Action strings dispatched by an upstream-shaped if/else chain. */
function actionsInChain(source) {
  return new Set([...source.matchAll(/action\s*===?\s*"([^"]+)"/g)].map((m) => m[1]));
}

/** Action strings the fork's registry answers to, including aliases. */
function actionsInRegistry() {
  const found = new Set();
  if (!existsSync(ACTIONS_DIR)) return found;
  for (const domain of readdirSync(ACTIONS_DIR, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    for (const file of readdirSync(join(ACTIONS_DIR, domain.name))) {
      if (!file.endsWith(".ts")) continue;
      const src = readFileSync(join(ACTIONS_DIR, domain.name, file), "utf8");
      const action = src.match(/^\s*action:\s*"([^"]+)"/m);
      if (action) found.add(action[1]);
      const aliases = src.match(/^\s*aliases:\s*\[([^\]]*)\]/m);
      if (aliases) for (const a of aliases[1].matchAll(/"([^"]+)"/g)) found.add(a[1]);
    }
  }
  return found;
}

/** Best-effort domain folder for a new action, so the report can name a path. */
function suggestDomain(action) {
  const a = action.toLowerCase();
  const rules = [
    ["maintenance", "maintenances"],
    ["incident", "incidents"],
    ["comment", "incidents"],
    ["subscriber", "subscribers"],
    ["subscription", "subscribers"],
    ["alert", "alerts"],
    ["trigger", "triggers"],
    ["apikey", "apikeys"],
    ["api_key", "apikeys"],
    ["monitor", "monitors"],
    ["page", "pages"],
    ["role", "roles"],
    ["permission", "roles"],
    ["user", "users"],
    ["oidc", "oidc"],
    ["template", "templates"],
    ["image", "images"],
    ["audit", "audit"],
  ];
  for (const [needle, domain] of rules) if (a.includes(needle)) return domain;
  return "settings";
}

const [upstreamFile, ...flags] = process.argv.slice(2);
if (!upstreamFile || !existsSync(upstreamFile)) {
  // Not an error: on most syncs upstream did not touch this file at all.
  console.log("no upstream manage API file to compare");
  process.exit(0);
}

const upstreamSource = readFileSync(upstreamFile, "utf8");
const upstream = actionsInChain(upstreamSource);
const previous = existsSync(SNAPSHOT) ? actionsInChain(readFileSync(SNAPSHOT, "utf8")) : new Set();
const registry = actionsInRegistry();

// Compared against the registry, not against the snapshot, so an action missed
// by an earlier sync keeps being reported until somebody writes it. The snapshot
// is only used to tell "upstream just added this" from "we never had this".
const missing = [...upstream].filter((a) => !registry.has(a)).sort();
const removed = [...registry].filter((a) => previous.has(a) && !upstream.has(a)).sort();

const lines = [];
if (missing.length > 0) {
  lines.push(`Upstream has ${missing.length} admin action(s) this fork's registry does not answer:`);
  for (const a of missing) {
    const isNew = !previous.has(a) ? "new upstream" : "still missing";
    lines.push(`  - \`${a}\` (${isNew}) -> add \`${ACTIONS_DIR}/${suggestDomain(a)}/${a}.ts\``);
  }
  lines.push("");
  lines.push("Until then those actions return 400. Their permissions arrive automatically in `allPerms.ts`.");
}
if (removed.length > 0) {
  lines.push("");
  lines.push(`Upstream removed ${removed.length} action(s) the fork still registers:`);
  for (const a of removed) lines.push(`  - \`${a}\` -> confirm it is still wanted, or delete its action file`);
}

if (lines.length === 0) {
  console.log("admin actions are in sync with upstream");
} else {
  console.log(lines.join("\n"));
}

if (flags.includes("--update-snapshot")) {
  writeFileSync(
    SNAPSHOT,
    `// Upstream's src/routes/(manage)/manage/api/+server.ts as of the last sync.\n` +
      `// Refreshed automatically by scripts/sync-upstream.sh. Never imported and\n` +
      `// never edited by hand: it exists only so the next sync can tell a newly\n` +
      `// added upstream action from one we have simply never implemented.\n` +
      `// See scripts/diff-upstream-actions.mjs.\n\n` +
      upstreamSource,
  );
}

// Always exit 0. A missing action is a to-do for the PR body, not a reason to
// fail a sync that is otherwise fine.
process.exit(0);
