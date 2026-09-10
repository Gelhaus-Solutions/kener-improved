import type { Knex } from "knex";

// F1a: SLO targets and their precomputed evaluations.
//
// **Two tables with very different jobs.** `sla_targets` is what somebody typed:
// the objective, the scope, the window. It changes when a human changes it and
// never otherwise. `sla_evaluations` is arithmetic derived from the rollups,
// rewritten every five minutes by `slaScheduler`, and holds nothing that cannot
// be recomputed from the rollups and the target. Losing the whole evaluations
// table costs one scheduler tick; losing the targets table loses somebody's
// contract, which is why they are not one table with a few cached columns.
//
// **One evaluation row per target, upserted.** The dashboard and the burn-rate
// alerting both ask "where does this target stand right now", which is an O(1)
// read of the current row. Keeping every five-minute evaluation would be 288
// rows per target per day needing a retention policy of its own, for a history
// nothing in this slice reads. Trend history is F3's question and can add its
// own table with its own retention when it has one.
//
// **Windows are UTC, deliberately and visibly.** `monitor_rollup_1d` is
// UTC-aligned by definition, so a UTC calendar month is a plain sum of daily
// buckets with nothing re-derived. The alternative - each target carrying its
// own IANA zone - runs straight into the :30 and :45 offsets that the rollup
// tables already document as unservable at the daily grain. The admin UI says
// "UTC" next to every window rather than letting somebody assume otherwise.

const TARGETS = "sla_targets";
const EVALUATIONS = "sla_evaluations";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TARGETS))) {
    await knex.schema.createTable(TARGETS, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable();
      table.string("name", 255).notNullable();

      // MONITOR | PAGE | CATEGORY.
      //
      // `scope_ref` is deliberately a string for all three rather than three
      // nullable typed columns: a monitor is named by `monitors.tag`, a page by
      // `pages.id`, a category by `monitors.category_name`, and only one of them
      // is an integer. One column that always holds the identifier keeps the
      // reader from having to ask which of three is populated.
      table.string("scope_type", 16).notNullable();
      table.string("scope_ref", 255).notNullable();

      // WORST | AVERAGE. Only consulted for PAGE and CATEGORY, where the scope
      // resolves to more than one monitor.
      //
      // WORST is the default because it is the honest reading: a page is up in
      // a given minute when every component on it was up. AVERAGE exists because
      // some contracts really are written per component and averaged, but it can
      // report 99.9% for a page that had one component down all month, so it is
      // never what somebody gets without asking.
      table.string("combination", 16).notNullable().defaultTo("WORST");

      // Region 0 is the merged verdict, and is what an SLA is written about.
      table.integer("region_id").notNullable().defaultTo(0);

      // A percentage, so 99.9 rather than 0.999. It is what the operator typed
      // and what every screen shows, and storing the fraction would mean every
      // read and every write converted.
      table.double("objective_percent").notNullable();

      // ROLLING with window_days, or CALENDAR with calendar_period.
      table.string("window_type", 16).notNullable().defaultTo("ROLLING");
      table.integer("window_days").nullable();
      table.string("calendar_period", 16).nullable();

      // Strings rather than booleans, matching `monitors.is_hidden` and
      // `monitor_rollup_settings.show_dependencies`: this codebase reads YES/NO
      // everywhere, and SQLite storing a boolean as 0/1 while Postgres stores a
      // real boolean is a dialect difference worth not having.
      //
      // `exclude_maintenance` defaults to YES because that is what an SLA
      // almost always means: planned, announced maintenance is not downtime the
      // provider is answerable for. It reads the `*_excl_maint` rollup columns,
      // which are derived from maintenance *events* rather than from a sample's
      // own type - those are different questions, and an SLA is written about
      // the window.
      table.string("exclude_maintenance", 3).notNullable().defaultTo("YES");

      // Defaults to NO: degraded is by definition still serving, and counting it
      // as a full breach surprises people who set a 99.9% target.
      table.string("degraded_counts_as_bad", 3).notNullable().defaultTo("NO");

      // Opt-in, and off by default. Publishing an error budget is a business
      // decision, and a target that appears on the public page the moment it is
      // created would make that decision for the operator.
      table.string("show_on_public", 3).notNullable().defaultTo("NO");

      table.string("status", 16).notNullable().defaultTo("ACTIVE");
      table.timestamp("created_at").defaultTo(knex.fn.now());
      table.timestamp("updated_at").defaultTo(knex.fn.now());

      table.index(["org_id", "status"], "idx_sla_targets_org_status");
      table.index(["org_id", "scope_type", "scope_ref"], "idx_sla_targets_org_scope");
    });
  }

  if (!(await knex.schema.hasTable(EVALUATIONS))) {
    await knex.schema.createTable(EVALUATIONS, (table) => {
      // The target's id *is* the key. One row per target is the whole design, and
      // a surrogate key would let a second row exist without anything noticing.
      table.integer("sla_target_id").primary();
      table.integer("org_id").notNullable();

      table.integer("window_start").notNullable();
      table.integer("window_end").notNullable();

      // Sample counts, not minutes. The rollups count samples, and a monitor's
      // cron decides how many of those there are per hour - so converting to
      // minutes here would invent a precision the source does not have. Every
      // ratio below is counts over counts, which is unaffected.
      table.integer("count_total").notNullable().defaultTo(0);
      table.integer("count_good").notNullable().defaultTo(0);
      table.integer("count_bad").notNullable().defaultTo(0);
      // Samples inside a maintenance window, when the target excludes them. Kept
      // rather than dropped so a report can say how much of the window was
      // excluded, which is the first thing anybody asks about a suspiciously
      // good month.
      table.integer("count_excluded").notNullable().defaultTo(0);

      table.double("uptime_percent").nullable();

      // Snapshotted from the target, so the row explains its own numbers even
      // after somebody edits the objective. Without it a stored budget would
      // silently belong to an objective that no longer exists.
      table.double("objective_percent").notNullable();

      table.double("budget_total").nullable();
      table.double("budget_consumed").nullable();
      table.double("budget_remaining_percent").nullable();

      // Burn rate over each window: (bad_W / total_W) / (1 - objective). 1.0
      // exhausts the budget exactly at window end; 14.4 exhausts a 30-day budget
      // in about two days. Nullable because a window with no samples has no burn
      // rate, which is different from a burn rate of zero.
      table.double("burn_1h").nullable();
      table.double("burn_6h").nullable();
      table.double("burn_24h").nullable();
      table.double("burn_3d").nullable();

      // How many monitors the scope resolved to when this was computed. A page
      // SLO that quietly went from six components to one is not the same
      // measurement, and nothing else in the row would say so.
      table.integer("monitor_count").notNullable().defaultTo(0);

      table.integer("computed_at").notNullable();

      table.index(["org_id"], "idx_sla_evaluations_org");
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(EVALUATIONS)) await knex.schema.dropTable(EVALUATIONS);
  if (await knex.schema.hasTable(TARGETS)) await knex.schema.dropTable(TARGETS);
}
