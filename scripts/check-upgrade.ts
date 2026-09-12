/**
 * Checks that an upgrade does not quietly destroy configuration (I10).
 *
 * `npm run db:check-upgrade`
 *
 * **What CI already covers, and what it cannot.** The Tests workflow migrates a
 * throwaway Postgres twice and seeds it twice, which proves a fresh install
 * works and that every migration is re-runnable. It proves nothing at all about
 * an upgrade, because the database it migrates is EMPTY. A migration that
 * rewrites or drops rows has nothing to rewrite or drop, so it passes.
 *
 * Migrations run automatically on container start - `scripts/main.ts` calls
 * `db.migrate.latest()` inside the listen callback - so the first database with
 * data in it that a migration ever meets is a production one, with no human in
 * the loop.
 *
 * **What this adds.** A populated database, taken down and back up:
 *
 *   1. migrate, seed, and install a fixture of the configuration an operator
 *      would actually lose and notice
 *   2. count it
 *   3. roll back `--depth` migrations and roll forward again
 *   4. count it again
 *   5. run what the app runs after migrating, and count a third time
 *
 * **Step 5 is the one that is easy to leave out and is the reason this exists.**
 * B1e's migration carried every probe assignment across correctly and passed a
 * schema check, a clean `down`/`up` round trip and the full test suite. It had
 * not written the exception rows that justify those assignments, so the
 * scheduler's first reconcile - correct, and doing exactly its job - deleted all
 * of them a minute after the deploy. A migration is not finished when the rows
 * are in the right shape. It is finished when the code that reads them agrees.
 *
 * Exits 2 on loss, deliberately distinct from 1, so "could not check" is never
 * read as "checked and found nothing".
 */

import knexLib from "knex";
import type { Knex } from "knex";
import knexOb from "../knexfile.js";
import { runWithOrg } from "../src/lib/server/db/orgContext.js";
import { reconcileProbeAssignments } from "../src/lib/server/probes/reconcile.js";

/**
 * The tables whose rows are an operator's configuration.
 *
 * Not every table: `monitoring_data` and the rollups are observations, and an
 * upgrade that prunes or rewrites them is doing its job. These are the ones
 * somebody typed, where a row disappearing is work lost and, worse, silence.
 */
const CONFIGURATION_TABLES = [
  "orgs",
  "monitors",
  "pages",
  "pages_monitors",
  "component_dependencies",
  "monitor_rollup_settings",
  "probe_agents",
  "monitor_probe_assignments",
  "probe_region_rules",
  "monitor_region_overrides",
  "monitor_merge_policies",
  "monitor_source_policies",
  "regions",
  "site_data",
  "triggers",
  "monitor_alerts_config",
  "sla_targets",
  "incidents",
  "incident_monitors",
  "maintenances",
  "maintenance_monitors",
] as const;

type Census = Map<string, number>;

const isPg = knexOb.databaseType === "postgresql";

async function tableExists(knex: Knex, table: string): Promise<boolean> {
  return await knex.schema.hasTable(table);
}

async function census(knex: Knex): Promise<Census> {
  const counts: Census = new Map();
  for (const table of CONFIGURATION_TABLES) {
    if (!(await tableExists(knex, table))) continue;
    const [row] = await knex(table).count({ n: "*" });
    counts.set(table, Number((row as { n: string | number }).n));
  }
  return counts;
}

/**
 * Configuration an upgrade must not lose.
 *
 * Deliberately the fork's own tables rather than upstream's. Those are the ones
 * the roadmap keeps migrating, and the ones with no upstream history to lean on.
 * Inserted with raw knex rather than through the controllers so this script
 * keeps working while the controllers change.
 */
async function installFixture(knex: Knex): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const orgId = 1;

  const monitors = await knex("monitors").select("tag").limit(2);
  if (monitors.length < 2) {
    throw new Error("the seed produced fewer than two monitors, so the fixture has nothing to configure");
  }
  const [parent, child] = monitors.map((m: { tag: string }) => m.tag);

  await knex("regions")
    .insert({ id: 901, org_id: orgId, code: "chk", name: "Upgrade check", is_active: true })
    .onConflict("id")
    .ignore();

  await knex("probe_agents")
    .insert({
      org_id: orgId,
      name: "upgrade-check-agent",
      region_id: 901,
      token_hash: "upgrade-check",
      token_hint: "chk1",
      status: "ACTIVE",
      connection_state: "DISCONNECTED",
      created_at: now,
      updated_at: now,
    })
    .onConflict()
    .ignore();

  // The exact shape B1e's migration got wrong: an assignment is only legitimate
  // while the exception that justifies it exists.
  await knex("monitor_region_overrides")
    .insert({
      org_id: orgId,
      monitor_tag: child,
      region_id: 901,
      decision: "INCLUDE",
      created_at: now,
      updated_at: now,
    })
    .onConflict(["monitor_tag", "region_id"])
    .ignore();
  await knex("monitor_probe_assignments")
    .insert({
      org_id: orgId,
      monitor_tag: child,
      region_id: 901,
      mode: "REMOTE_PREFERRED",
      source: "OVERRIDE",
      created_at: now,
      updated_at: now,
    })
    .onConflict(["monitor_tag", "region_id"])
    .ignore();

  await knex("component_dependencies")
    .insert({
      org_id: orgId,
      parent_monitor_tag: parent,
      child_monitor_tag: child,
      relation: "DEPENDS_ON",
      propagation: "WORST",
      weight: 1,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .onConflict(["parent_monitor_tag", "child_monitor_tag", "relation"])
    .ignore();

  await knex("monitor_rollup_settings")
    .insert({
      org_id: orgId,
      monitor_tag: parent,
      rollup_mode: "WORST",
      manual_override: null,
      manual_override_reason: null,
      manual_override_expires_at: null,
      show_dependencies: "YES",
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .onConflict(["monitor_tag"])
    .ignore();
}

function diff(before: Census, after: Census): Array<{ table: string; before: number; after: number }> {
  const lost: Array<{ table: string; before: number; after: number }> = [];
  for (const [table, count] of before) {
    // A table the round trip removed is a destructive migration doing what it
    // says. Reported separately below rather than counted as silent loss.
    if (!after.has(table)) continue;
    const now = after.get(table)!;
    if (now < count) lost.push({ table, before: count, after: now });
  }
  return lost;
}

function report(label: string, lost: Array<{ table: string; before: number; after: number }>): boolean {
  if (lost.length === 0) {
    console.log(`  PASS  ${label}`);
    return true;
  }
  console.log(`  FAIL  ${label}`);
  for (const row of lost) {
    console.log(`        ${row.table}: ${row.before} rows before, ${row.after} after`);
  }
  return false;
}

async function main(): Promise<void> {
  const depthArg = process.argv.find((arg) => arg.startsWith("--depth="));
  const depth = depthArg ? Number(depthArg.split("=")[1]) : 1;
  if (!Number.isInteger(depth) || depth < 1) {
    console.error("--depth must be a positive integer");
    process.exit(1);
  }

  const knex = knexLib(knexOb as Knex.Config);
  let ok = true;

  try {
    console.log(`\nUpgrade safety check (${isPg ? "postgresql" : knexOb.databaseType}), depth ${depth}\n`);

    await knex.migrate.latest();
    await knex.seed.run();
    await installFixture(knex);

    const before = await census(knex);
    console.log(`  fixture installed: ${[...before.values()].reduce((a, b) => a + b, 0)} configuration rows\n`);

    // Down and back up, with the data in place. Knex rolls back one migration
    // per `down()` call, newest first, and `up()` replays them in order.
    const rolledBack: string[] = [];
    for (let i = 0; i < depth; i++) {
      const [, files] = (await knex.migrate.down()) as [number, string[]];
      if (!files || files.length === 0) break;
      rolledBack.push(...files);
    }
    if (rolledBack.length === 0) {
      console.error("  nothing could be rolled back, so nothing was checked");
      process.exit(2);
    }
    console.log(`  rolled back: ${rolledBack.join(", ")}`);
    for (let i = 0; i < rolledBack.length; i++) await knex.migrate.up();
    console.log(`  and replayed\n`);

    ok = report("configuration survives a rollback and replay", diff(before, await census(knex))) && ok;

    // What the app does next. A migration whose rows are the right shape but
    // which the reading code then discards is the failure this catches, and it
    // is invisible to every check that stops at the schema.
    await runWithOrg(1, async () => {
      const result = await reconcileProbeAssignments();
      console.log(
        `  post-migration reconcile: ${result.created} created, ${result.updated} updated, ${result.removed} removed`,
      );
    });

    const after = await census(knex);
    ok = report("configuration survives what the app runs after migrating", diff(before, after)) && ok;

    // Not a failure. A migration that drops a table on the way down and
    // recreates it empty on the way up is destructive by design, and the
    // migration says so. Named anyway, because an operator reading a green run
    // should know which tables that clean bill of health does not cover.
    const dropped = [...before.keys()].filter((table) => !after.has(table));
    if (dropped.length > 0) {
      console.log(
        `  NOTE these tables did not survive the round trip, which their migration declares (${dropped.length}):`,
      );
      for (const table of dropped.sort()) console.log(`        - ${table}`);
    }

    console.log(ok ? "\nALL PASS - an upgrade preserves what an operator configured\n" : "\nPROBLEMS FOUND\n");
  } finally {
    await knex.destroy();
  }

  process.exit(ok ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  // 1 means "could not check", 2 means "checked and found loss". Kept distinct
  // so a broken script is never read as a clean bill of health.
  process.exit(1);
});
