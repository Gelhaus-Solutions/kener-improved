import type { Knex } from "knex";

// Real, revocable sessions.
//
// What this replaces: a JWT signed over the *entire user record* with
// `expiresIn: "1y"`, and no server-side record of it existing at all. The
// consequences were not theoretical. A leaked `kener-user` cookie was valid for
// a year and could not be revoked by anybody, because there was nothing to
// revoke; logging out deleted the browser's copy and nothing else; and a role
// change or a deactivation never reached a token already issued, so a
// demoted-or-removed admin kept full access until the token expired in a year.
//
// The fix is that the session row is the authority. Every request loads it and
// checks `revoked_at`, `expires_at` and `epoch`, so revoking a session or
// changing a role takes effect on the next request rather than eventually. The
// cookie still carries a JWT, and it still carries only identifiers - never the
// user record - so a stolen cookie is worth exactly one revocable session.
//
// This costs a database read per authenticated request. It replaces the
// `getUserByEmail` that every authenticated request already performed, so the
// cost is a wash.
//
// **Deploying this logs everyone out.** That is deliberate and was decided
// rather than defaulted: a compatibility branch that kept honouring the old
// tokens would keep the unrevokable-token window open for a year, which is the
// entire thing being fixed here. Announce it before deploying.

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("sessions"))) {
    await knex.schema.createTable("sessions", (table) => {
      // Opaque and random, never a JWT and never derived from anything about the
      // user. It is what a revocation names and what the audit log records, so it
      // must stay meaningless to anybody who sees it.
      table.string("id", 64).primary();
      table.integer("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");

      // P4 makes this the org a session is currently acting in, so that switching
      // org is a session change rather than a re-login. Nullable until then.
      table.integer("active_org_id").nullable();

      // UTC seconds, like every other timestamp the fork writes.
      table.integer("issued_at").notNullable();
      // Written at most once a minute, so an active session does not turn every
      // request into a write. The value is for the "last active" column on the
      // session list, where a minute of staleness is invisible.
      table.integer("last_seen_at").notNullable();
      table.integer("expires_at").notNullable();

      table.integer("revoked_at").nullable();
      // A short code, never user-facing copy: "logout", "revoked_by_user",
      // "revoked_by_admin", "password_changed", "mfa_enrolled", "epoch_changed".
      table.string("revoked_reason", 64).nullable();

      // The value of `users.session_epoch` when this session was minted. A
      // mismatch means the user's permissions changed since, and the session is
      // rejected. This is what makes a role change take effect immediately
      // without adding a permissions read to the session lookup.
      table.integer("epoch").notNullable().defaultTo(0);

      // How strongly the user authenticated: "none", "totp", "recovery", "idp".
      // Written by A2 (MFA), and the reason MFA needs no table of its own to
      // integrate: step-up auth later is a check on this column.
      table.string("mfa_level", 16).notNullable().defaultTo("none");

      // Captured at sign-in and never updated, so the session list can say where
      // a session came from. Not used for validation: pinning a session to an IP
      // breaks mobile networks far more often than it stops an attacker.
      table.string("ip", 64).nullable();
      table.string("user_agent", 512).nullable();

      table.timestamp("created_at").defaultTo(knex.fn.now());
      table.timestamp("updated_at").defaultTo(knex.fn.now());

      // The session list, and the bulk revoke on a role change.
      table.index(["user_id", "revoked_at"], "idx_sessions_user_active");
      // The cleanup sweep.
      table.index(["expires_at"], "idx_sessions_expires_at");
    });
  }

  if (!(await knex.schema.hasColumn("users", "session_epoch"))) {
    await knex.schema.alterTable("users", (table) => {
      // Bumped whenever anything changes what this user is allowed to do. Every
      // session minted before the bump stops validating on its next request.
      //
      // A counter rather than a timestamp because two role changes inside one
      // second must both invalidate, and a second-resolution timestamp would
      // silently let the second one through.
      table.integer("session_epoch").notNullable().defaultTo(0);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("sessions");
  if (await knex.schema.hasColumn("users", "session_epoch")) {
    await knex.schema.alterTable("users", (table) => {
      table.dropColumn("session_epoch");
    });
  }
}
