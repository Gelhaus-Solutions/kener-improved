import type { Knex } from "knex";

// Scoped API keys.
//
// What this replaces: a key with no scopes at all. `apiAuthHandle` checked that
// the bearer token hashed to an ACTIVE row and stopped there, so every key could
// do everything the v4 API exposes - read every monitor, PATCH site
// configuration, delete incidents. There was one privilege level, "all of it",
// and an integration that only needed to read uptime had to be handed it.
//
// The scope vocabulary is deliberately *not* new. It is the permission ids from
// `allPerms.ts` (plus the fork's `orgPerms.ts`), so a key runs through the same
// vocabulary a cookie session does, there is one set of names to maintain, and a
// permission upstream adds becomes scopeable here for free.
//
// `hashed_key` is untouched on purpose. It is already an HMAC-SHA256 keyed with
// KENER_SECRET_KEY over 256 bits of randomness, which is the right shape; the
// only thing changing it would achieve is invalidating every key an operator has
// already deployed.
//
// **This migration changes no existing key's behaviour.** Every row is backfilled
// to `["*"]`, the synthetic full-access scope, and `*` bypasses the route map
// entirely - so an old key keeps working everywhere, including on v4 routes
// upstream adds later. Narrowing is opt-in, per key, from the admin screen.

export async function up(knex: Knex): Promise<void> {
  const hasScopes = await knex.schema.hasColumn("api_keys", "scopes");

  await knex.schema.alterTable("api_keys", (table) => {
    if (!hasScopes) {
      // A JSON array of permission ids, or the single synthetic entry "*".
      // Stored as text rather than a native json column because this table has
      // to work identically on SQLite, MySQL and Postgres, and the value is
      // never queried into - it is read whole on every authentication.
      //
      // NOT NULL with a default is what makes the backfill happen: all three
      // dialects fill existing rows with the default when the column is added,
      // so every key that predates this migration becomes a "*" key.
      table.text("scopes").notNullable().defaultTo('["*"]');
    }
  });

  // Belt and braces for the backfill above. A dialect that added the column as
  // NULL rather than applying the default would otherwise leave keys that
  // authenticate to an unparseable scope list, which fails closed and would
  // silently break every existing integration.
  if (!hasScopes) {
    await knex("api_keys").whereNull("scopes").orWhere("scopes", "").update({ scopes: '["*"]' });
  }

  if (!(await knex.schema.hasColumn("api_keys", "expires_at"))) {
    await knex.schema.alterTable("api_keys", (table) => {
      // UTC seconds, like every other timestamp the fork writes. NULL means the
      // key never expires, which is what every existing key gets.
      table.integer("expires_at").nullable();
    });
  }

  if (!(await knex.schema.hasColumn("api_keys", "last_used_at"))) {
    await knex.schema.alterTable("api_keys", (table) => {
      // Written at most once a minute per key, the same treatment
      // `sessions.last_seen_at` gets and for the same reason: an API key on a
      // polling integration would otherwise turn every request into a write.
      table.integer("last_used_at").nullable();
      table.string("last_used_ip", 64).nullable();
    });
  }

  if (!(await knex.schema.hasColumn("api_keys", "created_by"))) {
    await knex.schema.alterTable("api_keys", (table) => {
      // Who minted it. Deliberately *not* a foreign key: deleting a user must
      // not cascade into their API keys (that would silently break running
      // integrations), and an ON DELETE SET NULL constraint added by ALTER on
      // SQLite forces a table rebuild for no benefit a nullable integer does
      // not already give. A dangling id renders as "unknown" and that is fine.
      table.integer("created_by").nullable();
    });
  }

  if (!(await knex.schema.hasColumn("api_keys", "rotated_from"))) {
    await knex.schema.alterTable("api_keys", (table) => {
      // The id of the key this one replaced. Rotation mints a new row rather
      // than editing the old one, because the old secret has to keep working
      // for a grace period while deployments pick up the new one.
      table.integer("rotated_from").nullable();
    });
  }

  if (!(await knex.schema.hasColumn("api_keys", "revoked_at"))) {
    await knex.schema.alterTable("api_keys", (table) => {
      // Distinct from `status`, which is a reversible on/off switch an operator
      // flips. This is one-way: a revoked key never authenticates again, even if
      // somebody sets its status back to ACTIVE.
      table.integer("revoked_at").nullable();
    });
  }

  if (!(await knex.schema.hasColumn("api_keys", "key_prefix"))) {
    await knex.schema.alterTable("api_keys", (table) => {
      // The leading, non-secret part of the key ("kener_" plus six hex
      // characters), so an operator can match a key in a log line against a row
      // in the list. `masked_key` shows the *trailing* characters, which are
      // secret-adjacent and are not what anything logs.
      //
      // Keys that predate this migration keep NULL: the prefix cannot be
      // recovered from a hash, and inventing one would be worse than showing none.
      table.string("key_prefix", 16).nullable();
    });
  }

  if (!(await knex.schema.hasColumn("api_keys", "org_id"))) {
    await knex.schema.alterTable("api_keys", (table) => {
      // P4. Nullable and unread until orgs exist, seeded now so that the tenancy
      // migration does not have to alter a table whose rows are live
      // credentials. NULL means "the single implicit org", which is every key today.
      table.integer("org_id").nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const column of [
    "scopes",
    "expires_at",
    "last_used_at",
    "last_used_ip",
    "created_by",
    "rotated_from",
    "revoked_at",
    "key_prefix",
    "org_id",
  ]) {
    if (await knex.schema.hasColumn("api_keys", column)) {
      await knex.schema.alterTable("api_keys", (table) => {
        table.dropColumn(column);
      });
    }
  }
}
