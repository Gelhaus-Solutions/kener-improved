import type { Knex } from "knex";

// TOTP second factors and their recovery codes.
//
// Two tables because the two secrets have opposite requirements, and getting
// that backwards is the classic way to build MFA wrong:
//
//   The TOTP secret is **encrypted, not hashed.** Verifying a code means
//   recomputing it from the shared secret, so the server has to be able to read
//   the secret back. A hash would be one-way and useless here.
//
//   A recovery code is **hashed, not encrypted.** It is compared against
//   something the user types, exactly like a password, and nothing ever needs to
//   read it back. Storing it recoverably would put a set of working credentials
//   in the database for no reason at all.
//
// The encrypted secret uses the same `secretBox` envelope as the OIDC client
// secret, so it is one string rather than the separate ciphertext/iv/tag columns
// the plan named. Splitting them across three columns would mean this table and
// `secretBox.ts` had to agree on a format forever; one opaque column means the
// envelope can change without a migration.

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("user_mfa_totp"))) {
    await knex.schema.createTable("user_mfa_totp", (table) => {
      // One TOTP factor per user, enforced by the primary key rather than by
      // application code. Multiple authenticator apps sharing one secret is a
      // supported thing to do; multiple secrets is a different feature.
      table.integer("user_id").primary().references("id").inTable("users").onDelete("CASCADE");

      // A `secretBox` envelope over the base32 TOTP secret.
      table.text("secret_enc").notNullable();

      // Null until the user has proved they can generate a code from it. An
      // unconfirmed row must never gate a login: enrolment that half-completed
      // would otherwise lock the user out of their own account with a secret
      // their phone never received.
      table.integer("confirmed_at").nullable();

      /**
       * The last 30-second time step this user successfully consumed.
       *
       * The replay guard, and it is not optional. TOTP codes are valid for their
       * whole step plus whatever drift window the server allows, so without this
       * a code observed over someone's shoulder, or captured from a phished
       * form, stays usable for up to a minute. Rejecting a step that has already
       * been spent makes each code strictly single-use.
       */
      table.integer("last_used_step").nullable();

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });
  }

  if (!(await knex.schema.hasTable("user_mfa_recovery_codes"))) {
    await knex.schema.createTable("user_mfa_recovery_codes", (table) => {
      table.increments("id").primary();
      table.integer("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");

      // bcrypt, the same as a password. Never the code itself.
      table.string("code_hash", 255).notNullable();

      // Single use. Kept rather than deleted so the list can show how many are
      // spent, which is what tells a user it is time to regenerate.
      table.integer("used_at").nullable();

      table.integer("created_at").notNullable();

      // The lookup on every recovery attempt: a user's unused codes.
      table.index(["user_id", "used_at"], "idx_mfa_recovery_user_unused");
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("user_mfa_recovery_codes");
  await knex.schema.dropTableIfExists("user_mfa_totp");
}
