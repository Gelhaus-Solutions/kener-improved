import type { Knex } from "knex";

// Append-only record of who did what.
//
// Enforced twice, per the tiered database rule in AGENTS.md. Tier 1 is the
// application: AuditRepository exposes an insert and read queries, and no update
// or delete method exists to call. Tier 2 is Postgres-only and lives in the next
// migration, which revokes UPDATE and DELETE from the app role outright.
//
// Retention is handled by dailyCleanup, which is why there is no ON DELETE
// anything here: rows are pruned by date, never cascaded away by the
// disappearance of whatever they describe. That is the point of an audit log.
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable("audit_log")) return;

  await knex.schema.createTable("audit_log", (table) => {
    table.bigIncrements("id").primary();

    // Nullable: instance-level events (org creation, sign-in before an org is
    // resolved) genuinely belong to no organisation. A zero sentinel would
    // collide with P4's instance-level org_id = 0.
    table.integer("org_id").nullable();

    // UTC seconds, matching every other timestamp in this schema.
    table.integer("ts").notNullable();

    table.string("request_id", 64).nullable();

    // user | api_key | system | oidc | anonymous
    table.string("actor_type", 32).notNullable();
    table.string("actor_id", 128).nullable();
    // Denormalised on purpose. Users get deleted; an audit row that can no
    // longer say who acted has stopped being evidence.
    table.string("actor_label", 255).nullable();

    table.string("action", 128).notNullable();
    table.string("permission", 128).nullable();

    table.string("target_type", 64).nullable();
    table.string("target_id", 128).nullable();

    // ok | denied | error
    table.string("outcome", 16).notNullable();
    table.integer("status_code").nullable();

    table.string("ip", 64).nullable();
    table.text("user_agent").nullable();

    // Shallow diffs, redacted, stored as JSON text rather than a json column:
    // the three dialects disagree on json support and nothing queries into them.
    table.text("before_json").nullable();
    table.text("after_json").nullable();
    table.text("meta_json").nullable();

    // (org_id, ts) is the default listing. The action and actor variants back
    // the two filters the UI offers. request_id ties a row to everything else
    // that happened in the same request.
    table.index(["org_id", "ts"], "idx_audit_log_org_ts");
    table.index(["org_id", "action", "ts"], "idx_audit_log_org_action_ts");
    table.index(["request_id"], "idx_audit_log_request_id");
    table.index(["actor_type", "actor_id", "ts"], "idx_audit_log_actor_ts");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("audit_log");
}
