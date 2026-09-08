import type { Knex } from "knex";

// Tier 2, PostgreSQL only: make the audit log append-only at the database level.
//
// The application already refuses to update or delete (AuditRepository has no
// such method), but that is a promise the application makes about itself, and an
// audit log whose only protection is the code it audits is worth less. On
// Postgres we can take the privilege away outright.
//
// SQLite and MySQL keep application-level enforcement alone, which the tiered
// rule in AGENTS.md explicitly permits: the feature degrades rather than blocking
// the migration.
//
// DELETE is revoked too, so retention pruning needs its own path. dailyCleanup
// calls a SECURITY DEFINER function created here rather than issuing a DELETE,
// which means pruning is possible only through the one narrow, date-bounded
// entry point and not by anything else that gets hold of the connection.
const PRUNE_FN = "audit_log_prune";

export async function up(knex: Knex): Promise<void> {
  if (knex.client.config.client !== "pg") return;
  if (!(await knex.schema.hasTable("audit_log"))) return;

  const { rows } = await knex.raw("SELECT current_user AS role");
  const role = rows?.[0]?.role;
  if (!role) return;

  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${PRUNE_FN}(cutoff_ts integer)
    RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    DECLARE removed bigint;
    BEGIN
      DELETE FROM audit_log WHERE ts < cutoff_ts;
      GET DIAGNOSTICS removed = ROW_COUNT;
      RETURN removed;
    END;
    $$;
  `);

  // Revoke from the app role after the function exists, so pruning is never
  // impossible in between.
  await knex.raw(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${knex.client.wrapIdentifier(role)}`);
}

export async function down(knex: Knex): Promise<void> {
  if (knex.client.config.client !== "pg") return;
  if (!(await knex.schema.hasTable("audit_log"))) return;

  const { rows } = await knex.raw("SELECT current_user AS role");
  const role = rows?.[0]?.role;
  if (role) {
    await knex.raw(`GRANT UPDATE, DELETE, TRUNCATE ON audit_log TO ${knex.client.wrapIdentifier(role)}`);
  }
  await knex.raw(`DROP FUNCTION IF EXISTS ${PRUNE_FN}(integer)`);
}
