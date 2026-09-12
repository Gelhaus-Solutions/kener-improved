import type { Knex } from "knex";

// Remote probes, phase 1: the tables and nothing that talks (B1b).
//
// A probe is a small daemon somewhere else in the world that runs a check Kener
// asks it to run and reports the result back. This migration adds only what has
// to exist before any of that can be wired up, so the networking in B1c lands on
// a schema that is already deployed rather than arriving with one.
//
// **Why `monitor_probe_assignments` is a side table rather than columns on
// `monitors`.** `appScheduler` hashes `JSON.stringify(monitor)` to decide whether
// a monitor's BullMQ scheduler needs rebuilding, so *any* new column on
// `monitors` tears down and recreates every scheduler on every edit. C3 put
// component dependencies in a side table for exactly this reason and this
// follows it.
//
// **Why the token is hashed and not encrypted.** Kener never needs to replay a
// probe's token - it only ever checks one the probe presents - so there is no
// reason to be able to read it back. That is the opposite of
// `webhook_endpoints.secret_encrypted`, which has to sign every outbound request.
// The hash is the existing `CreateHash` HMAC-SHA256 that already guards API
// keys, and `token_hint` exists so the UI can say which token an agent holds
// without being able to show it.

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("probe_agents"))) {
    await knex.schema.createTable("probe_agents", (table) => {
      table.increments("id").primary();

      // Present from birth and defaulted, so this runs against a live install.
      table.integer("org_id").notNullable().defaultTo(1);

      table.string("name", 255).notNullable();

      // The region this agent reports for. Its samples land at this
      // `region_id`, which is what keeps them distinct from the merged verdict
      // at region 0 all the way down to `monitoring_data`'s primary key.
      table.integer("region_id").notNullable();

      table.text("token_hash").notNullable();
      // Last four characters only. Enough to tell two tokens apart in the UI and
      // useless to anyone who reads the table.
      table.string("token_hint", 32).nullable();

      // ACTIVE | DISABLED. Whether an operator wants this agent used at all,
      // which is a different question from whether it is currently connected.
      table.string("status", 32).notNullable().defaultTo("ACTIVE");

      // DISCONNECTED | CONNECTED | OFFLINE. Observed rather than configured, and
      // kept apart from `status` on purpose: an agent an operator disabled and
      // an agent whose host died look identical in a single column, and the two
      // need completely different responses.
      table.string("connection_state", 32).notNullable().defaultTo("DISCONNECTED");

      table.string("agent_version", 64).nullable();
      // JSON array of what this agent can run, reported at connect time. Kener
      // intersects it with PROBE_ELIGIBLE_TYPES rather than trusting either
      // alone, so an old agent cannot be handed a check it does not implement.
      table.text("capabilities").nullable();

      // UTC seconds, like every other timestamp in this schema.
      table.integer("last_seen_at").nullable();
      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });

    await knex.schema.alterTable("probe_agents", (table) => {
      table.index(["org_id"], "idx_probe_agents_org_id");
      // The connect path's only lookup: find the agent presenting this hash.
      table.index(["token_hash"], "idx_probe_agents_token_hash");
      table.index(["org_id", "region_id"], "idx_probe_agents_org_region");
    });
  }

  if (!(await knex.schema.hasTable("monitor_probe_assignments"))) {
    await knex.schema.createTable("monitor_probe_assignments", (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable().defaultTo(1);

      // The monitor's physical tag, matching every other table that references a
      // monitor. Globally unique, so no org column is needed to disambiguate it -
      // `org_id` is here for scoping, not for identity.
      table.string("monitor_tag", 255).notNullable();
      table.integer("agent_id").notNullable();

      // REMOTE_PREFERRED is the only mode phase 1 ships: run it on the probe when
      // the probe is there, and locally when it is not. REMOTE_ONLY and
      // LOCAL_ONLY are the obvious later values, and the column exists now so
      // adding them is data rather than schema.
      table.string("mode", 32).notNullable().defaultTo("REMOTE_PREFERRED");

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });

    await knex.schema.alterTable("monitor_probe_assignments", (table) => {
      table.index(["org_id"], "idx_monitor_probe_assignments_org_id");
      table.index(["agent_id"], "idx_monitor_probe_assignments_agent_id");
      // One assignment per monitor per agent. Assigning the same monitor to two
      // *different* agents is allowed and is what multi-region checking is.
      table.unique(["monitor_tag", "agent_id"], { indexName: "monitor_probe_assignments_tag_agent_unique" });
    });
  }
}

// Both tables are new, hold no data anything else depends on, and have no
// inbound foreign keys, so dropping them is genuinely reversible.
export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable("monitor_probe_assignments")) {
    await knex.schema.dropTable("monitor_probe_assignments");
  }
  if (await knex.schema.hasTable("probe_agents")) {
    await knex.schema.dropTable("probe_agents");
  }
}
