import type { Knex } from "knex";

// F4: scheduled report delivery.
//
// **Two tables with different lifetimes, for the same reason F1a's two have
// them.** `report_schedules` is what somebody configured and changes only when a
// human changes it. `report_artifacts` is generated output: a file on disk, a
// token, an expiry, and it is meant to be swept. Losing every artifact costs the
// recipients a re-send; losing the schedules loses the configuration.
//
// **`rrule` rather than a cron string.** `rrule` is already a dependency, is
// already what `maintenances` stores, and is already bundled specially by
// `scripts/build-server.js`. A second recurrence vocabulary in the same product
// would be a thing to explain forever.
//
// **`timezone` is a real column and it matters here**, which is the opposite of
// the call F1a made for SLO windows. An SLO window is UTC because it is summed
// out of UTC-aligned rollup buckets and a per-target zone would collide with the
// :30 and :45 offsets. A *delivery schedule* has no such constraint: "send it on
// the 1st at 09:00" means nine in the morning where the reader is, and shifting
// it by an hour twice a year would be a bug rather than a rounding. The reported
// *range* stays UTC; only the firing instant is zoned.
//
// **`download_token` is a bearer secret in a URL.** It is what lets an auditor
// with no Kener account open the report from their mail client, which is the
// whole point of the feature. It is therefore long, random, unique, and expiring,
// and the column is indexed because the download path looks a row up by it
// before it knows which org it belongs to.

const SCHEDULES = "report_schedules";
const ARTIFACTS = "report_artifacts";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(SCHEDULES))) {
    await knex.schema.createTable(SCHEDULES, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable();
      table.string("name", 255).notNullable();

      // MONITOR | PAGE | CATEGORY | ALL, and `scope_ref` is the identifier for
      // whichever it is - the same one-string-for-all-four shape `sla_targets`
      // uses, and for the same reason: only one of the four is an integer.
      table.string("scope_type", 16).notNullable().defaultTo("ALL");
      table.string("scope_ref", 255).notNullable().defaultTo("");

      // csv | pdf. Not a list: a schedule that sent both would need two
      // artifacts, two links and two rows on the delivery log, and an operator
      // who wants both can have two schedules that say so.
      table.string("format", 8).notNullable().defaultTo("pdf");

      // The rollup grain the CSV is written at. Meaningless for the PDF, which
      // is a summary, and stored anyway so switching format keeps the setting.
      table.string("grain", 8).notNullable().defaultTo("1d");

      // PREV_MONTH | PREV_WEEK | LAST_7D | LAST_30D | LAST_90D.
      //
      // A *kind* rather than two stored timestamps, because the point of a
      // schedule is that the range moves with it. Resolved at fire time against
      // the schedule's own timezone, so "previous month" means the month that
      // just ended where the reader lives.
      table.string("range_kind", 16).notNullable().defaultTo("PREV_MONTH");

      table.string("rrule", 500).notNullable();
      table.string("timezone", 64).notNullable().defaultTo("UTC");

      // JSON array of literal email addresses.
      table.text("recipients").notNullable().defaultTo("[]");
      // JSON array of page ids whose subscribers also receive it. Empty by
      // default and deliberately so: a monthly PDF landing on every status-page
      // subscriber is a surprising thing to do by accident.
      table.text("recipient_page_ids").notNullable().defaultTo("[]");

      table.string("exclude_maintenance", 8).notNullable().defaultTo("YES");
      table.string("degraded_counts_as_bad", 8).notNullable().defaultTo("NO");
      table.string("status", 16).notNullable().defaultTo("ACTIVE");

      // When this schedule is next due, in UTC seconds. The scheduler reads
      // exactly this column, so a schedule whose rrule cannot be parsed simply
      // never becomes due rather than throwing on every hourly tick.
      table.integer("next_run_at").nullable();
      table.integer("last_run_at").nullable();
      // The last failure, kept on the row so the admin screen can show why a
      // schedule has gone quiet without anyone reading the container logs.
      table.text("last_error").nullable();

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();

      table.index(["org_id"], "idx_report_schedules_org");
      // The scheduler's only query: due schedules, cheapest first.
      table.index(["status", "next_run_at"], "idx_report_schedules_due");
    });
  }

  if (!(await knex.schema.hasTable(ARTIFACTS))) {
    await knex.schema.createTable(ARTIFACTS, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable();
      // Null when somebody generated an artifact by hand rather than from a
      // schedule, and `onDelete` is deliberately not set: deleting a schedule
      // must not silently revoke links already sitting in people's inboxes.
      table.integer("report_schedule_id").nullable();

      table.string("filename", 255).notNullable();
      table.string("format", 8).notNullable();
      table.string("content_type", 128).notNullable();
      // Relative to the artifact root, never absolute: the root is an env var
      // and a stored absolute path would break the first time the volume moved.
      table.string("storage_key", 512).notNullable();
      table.integer("size_bytes").notNullable().defaultTo(0);

      table.integer("range_from").notNullable();
      table.integer("range_to").notNullable();

      table.string("download_token", 128).notNullable();
      table.integer("expires_at").notNullable();
      table.integer("created_at").notNullable();

      table.index(["org_id"], "idx_report_artifacts_org");
      // Unique, because it is the credential: two rows sharing a token would
      // make which report you get depend on row order.
      table.unique(["download_token"], { indexName: "uq_report_artifacts_token" });
      // The sweeper's query.
      table.index(["expires_at"], "idx_report_artifacts_expires");
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(ARTIFACTS)) await knex.schema.dropTable(ARTIFACTS);
  if (await knex.schema.hasTable(SCHEDULES)) await knex.schema.dropTable(SCHEDULES);
}
