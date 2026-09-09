import type { Knex } from "knex";

// C2: severity, and the second impact layer.
//
// The design decision this migration exists to serve is that there are now *two*
// impact vocabularies and they answer different questions:
//
//   monitor_impact     mechanical. DOWN | DEGRADED | MAINTENANCE. What status the
//                      monitor's timeline should show for this window. It drives
//                      the synthetic monitoring_data rows that monitorExecuteQueue
//                      merges, and through them the 90-day bars, the uptime
//                      percentages and alert evaluation.
//
//   component_impact   communication. OPERATIONAL | DEGRADED_PERFORMANCE |
//                      PARTIAL_OUTAGE | MAJOR_OUTAGE | UNDER_MAINTENANCE. What
//                      the status page, the incident header, the page rollup and
//                      the webhook payload say.
//
// **The point of adding a column rather than widening the existing one is that
// monitorExecuteQueue is not touched at all.** The overlay merge, the
// confirmation-threshold freeze gate and ninety days of history keep working
// exactly as they do, because the column they read still holds exactly the three
// values it always held. A single widened vocabulary would have forced every one
// of those to learn five values, and the freeze gate is not a thing to be
// casually taught a new state.
//
// After this, `component_impact` is what a user sets and `monitor_impact` is
// derived from it on write, by the one-way projection in
// `src/lib/server/incidents/impact.ts`. The mapping is deliberately lossy in one
// direction only: DEGRADED_PERFORMANCE and PARTIAL_OUTAGE both mean DEGRADED to
// the timeline, and OPERATIONAL means no overlay row at all.

/**
 * The backfill direction, which is the projection read backwards.
 *
 * DEGRADED is genuinely ambiguous - it could have been either of the two
 * communication values that map onto it - and it resolves to PARTIAL_OUTAGE. The
 * alternative, DEGRADED_PERFORMANCE, claims the whole component was slow;
 * PARTIAL_OUTAGE claims part of it was affected, which is the weaker and more
 * defensible statement to put in front of customers about an incident nobody can
 * now go back and assess.
 */
const MONITOR_TO_COMPONENT: Record<string, string> = {
  DOWN: "MAJOR_OUTAGE",
  DEGRADED: "PARTIAL_OUTAGE",
  MAINTENANCE: "UNDER_MAINTENANCE",
};

/** Worst-first, so a backfill can pick the worst impact on an incident. */
const SEVERITY_BY_MONITOR_IMPACT: Record<string, string> = {
  DOWN: "MAJOR",
  DEGRADED: "MINOR",
  MAINTENANCE: "MAINTENANCE",
};

export async function up(knex: Knex): Promise<void> {
  const isPg = knex.client.config.client === "pg";

  // ---- incidents: severity and the fields C4 and C7 will read -------------
  if (await knex.schema.hasTable("incidents")) {
    if (!(await knex.schema.hasColumn("incidents", "severity"))) {
      await knex.schema.alterTable("incidents", (table) => {
        // Deliberately NOT the alert vocabulary. monitor_alerts_config.severity is
        // CRITICAL|WARNING and describes the *rule* that fired; this describes
        // customer impact. They are mapped on auto-creation and never unified:
        // conflating them is a one-way door, because once one column means both
        // things there is no way to say "a critical rule caught a minor problem".
        table.string("severity", 32).notNullable().defaultTo("NONE");
        table.integer("severity_changed_at").nullable();
      });
    }
    if (!(await knex.schema.hasColumn("incidents", "impact_override"))) {
      await knex.schema.alterTable("incidents", (table) => {
        // Pins the whole incident's component impact, overriding what the
        // per-monitor rows would derive. Null means "derive it".
        table.string("impact_override", 32).nullable();
      });
    }
    if (!(await knex.schema.hasColumn("incidents", "suppress_notifications"))) {
      await knex.schema.alterTable("incidents", (table) => {
        // For C7's backfill: an incident imported from history must not mail
        // subscribers about an outage that ended last March.
        table.string("suppress_notifications", 15).notNullable().defaultTo("NO");
      });
    }
    if (!(await knex.schema.hasColumn("incidents", "template_id"))) {
      await knex.schema.alterTable("incidents", (table) => {
        // C4. No foreign key: the templates table does not exist yet, and a
        // template deleted later must not take its incidents with it.
        table.integer("template_id").nullable();
      });
    }
  }

  // ---- the communication layer, on both impact tables --------------------
  for (const table of ["incident_monitors", "maintenance_monitors"]) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await knex.schema.hasColumn(table, "component_impact")) continue;
    await knex.schema.alterTable(table, (t) => {
      t.string("component_impact", 32).nullable();
    });
  }

  // ---- backfill ----------------------------------------------------------
  //
  // Every existing row gets a communication value that matches what the page was
  // already showing, so nothing visibly changes on deploy. Done with explicit
  // per-value updates rather than a CASE expression because it reads the same on
  // both dialects and there are three of them.
  for (const table of ["incident_monitors", "maintenance_monitors"]) {
    if (!(await knex.schema.hasTable(table))) continue;
    for (const [monitorImpact, componentImpact] of Object.entries(MONITOR_TO_COMPONENT)) {
      await knex(table)
        .where("monitor_impact", monitorImpact)
        .whereNull("component_impact")
        .update({ component_impact: componentImpact });
    }
    // A row whose monitor_impact is null or unrecognised. It contributes nothing
    // to the timeline, so OPERATIONAL is the honest projection.
    await knex(table).whereNull("component_impact").update({ component_impact: "OPERATIONAL" });
  }

  // ---- backfill incidents.severity ---------------------------------------
  //
  // Derived from what the incident actually did rather than defaulted flat. A
  // history where every incident is NONE would make the severity reporting P8
  // builds on top meaningless from day one.
  if ((await knex.schema.hasTable("incidents")) && (await knex.schema.hasTable("incident_monitors"))) {
    // Maintenance-typed incidents first, so the impact-derived pass below cannot
    // overwrite them: a maintenance window is not a MAJOR incident even though
    // its monitors are down.
    await knex("incidents")
      .where("incident_type", "MAINTENANCE")
      .where("severity", "NONE")
      .update({ severity: "MAINTENANCE" });

    // Worst impact wins, applied **strongest first**.
    //
    // Each pass is guarded on `severity = 'NONE'` so it cannot overwrite a value
    // already set, and that guard is what forces the order: weakest-first would
    // set an incident to MINOR for its DEGRADED monitor and then skip it on the
    // DOWN pass, because it is no longer NONE. An incident that took a component
    // down would be filed as minor. Strongest-first makes the guard mean "not yet
    // classified" instead of "already classified, worse luck".
    for (const monitorImpact of ["DOWN", "DEGRADED", "MAINTENANCE"]) {
      const severity = SEVERITY_BY_MONITOR_IMPACT[monitorImpact];
      const ids = (await knex("incident_monitors").where("monitor_impact", monitorImpact).distinct("incident_id")).map(
        (r: { incident_id: number }) => r.incident_id,
      );
      if (ids.length === 0) continue;
      await knex("incidents")
        .whereIn("id", ids)
        .whereNot("incident_type", "MAINTENANCE")
        .where("severity", "NONE")
        .update({ severity });
    }
  }

  // ---- the missing foreign key, Postgres only ----------------------------
  //
  // `maintenance_monitors` has had this FK since it was created;
  // `incident_monitors` never got one, so an orphan impact row survives its
  // monitor being deleted and then breaks the page rollup, which joins on the
  // tag expecting a monitor.
  //
  // **Postgres only, and this is not a preference.** knex implements adding a
  // foreign key on SQLite as a table rebuild - create temp, copy, DROP the
  // original, rename - and it issues `PRAGMA foreign_keys = OFF` first, which is
  // a no-op inside a transaction. knex runs every migration in one. So the DROP
  // cascades to anything referencing the table being rebuilt. That is exactly how
  // adding `org_id` to `roles` silently deleted 77 `roles_permissions` rows in
  // I3b. The constraint is worth having where it is free and not worth a table
  // rebuild where it is not; SQLite is the development dialect and Postgres is
  // the deployment target.
  if (isPg && (await knex.schema.hasTable("incident_monitors"))) {
    // Orphans must go first or the constraint cannot be created. They are rows
    // whose monitor no longer exists, which is the condition this FK prevents.
    await knex("incident_monitors").whereNotIn("monitor_tag", knex("monitors").select("tag")).del();

    const existing = await knex.raw(
      `select 1 from information_schema.table_constraints
       where constraint_name = 'incident_monitors_monitor_tag_foreign' and table_name = 'incident_monitors'`,
    );
    if (existing.rows.length === 0) {
      await knex.schema.alterTable("incident_monitors", (table) => {
        table.foreign("monitor_tag").references("tag").inTable("monitors").onDelete("CASCADE");
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const isPg = knex.client.config.client === "pg";

  if (isPg && (await knex.schema.hasTable("incident_monitors"))) {
    const existing = await knex.raw(
      `select 1 from information_schema.table_constraints
       where constraint_name = 'incident_monitors_monitor_tag_foreign' and table_name = 'incident_monitors'`,
    );
    if (existing.rows.length > 0) {
      await knex.schema.alterTable("incident_monitors", (table) => {
        table.dropForeign(["monitor_tag"]);
      });
    }
  }

  for (const table of ["incident_monitors", "maintenance_monitors"]) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, "component_impact"))) continue;
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn("component_impact");
    });
  }

  // Postgres only, for the same reason the foreign key above is, but with a
  // different victim. knex implements `dropColumn` on SQLite as a table rebuild,
  // and `monitor_alerts_v2.incident_id` references `incidents(id)` ON DELETE SET
  // NULL - so rebuilding `incidents` would null out the incident link on every
  // alert that ever opened one. The rows survive and the association does not,
  // which is the quietest kind of damage.
  //
  // A rollback that leaves five unused columns behind is a smaller problem than a
  // rollback that severs alert history, so on SQLite this leaves them. `up()` is
  // unaffected: ADD COLUMN is a real ALTER on SQLite, not a rebuild.
  if (isPg && (await knex.schema.hasTable("incidents"))) {
    for (const column of [
      "severity",
      "severity_changed_at",
      "impact_override",
      "suppress_notifications",
      "template_id",
    ]) {
      if (!(await knex.schema.hasColumn("incidents", column))) continue;
      await knex.schema.alterTable("incidents", (t) => {
        t.dropColumn(column);
      });
    }
  } else if (await knex.schema.hasTable("incidents")) {
    console.log(
      "incident severity migration: leaving the incidents columns in place on SQLite; dropping them rebuilds the table and would null monitor_alerts_v2.incident_id",
    );
  }
}
