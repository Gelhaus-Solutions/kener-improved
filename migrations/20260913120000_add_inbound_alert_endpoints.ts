import type { Knex } from "knex";

// H1. Inbound alert webhooks: somebody else's alerting drives Kener's incidents.
//
// **Why two tables rather than one.** `inbound_endpoints` is configuration an
// operator types once; `inbound_alerts` is the state machine that makes a
// repeated notification idempotent. They have completely different lifetimes and
// completely different write rates, and the second is the one that has to carry
// a unique constraint the receiver can lean on.
//
// **The unique key is the whole feature.** Alertmanager re-sends a firing alert
// every `repeat_interval` for as long as it fires, and Grafana and the rest
// behave similarly. Without an idempotency key that survives across requests,
// every re-notification opens another incident and the public status page fills
// with duplicates of one outage - the most visible possible failure for a status
// page, and the reason `(endpoint_id, fingerprint)` is UNIQUE here rather than
// being deduplicated in application code that could be bypassed by a second
// process.
//
// **One row per fingerprint, reused rather than accumulated.** An alert that
// fires, resolves and fires again is the same alert, so the row is updated and a
// fresh incident opened rather than a second row inserted. That keeps the unique
// constraint simple and keeps "is this alert currently firing" a single lookup.

const ENDPOINTS = "inbound_endpoints";
const ALERTS = "inbound_alerts";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(ENDPOINTS))) {
    await knex.schema.createTable(ENDPOINTS, (table) => {
      table.increments("id").primary();

      // Defaulted so this runs against a live single-org install, matching every
      // other table added since I3a.
      table.integer("org_id").notNullable().defaultTo(1);

      table.string("name", 255).notNullable();

      // ALERTMANAGER | GRAFANA | SENTRY | DATADOG | CLOUDWATCH | ZABBIX |
      // CHECKMK | UPTIME_KUMA. A string rather than an enum: adding a provider
      // is a parser file, and it should not also be a migration.
      table.string("provider", 32).notNullable();

      // **Hashed, not encrypted**, the opposite of `webhook_endpoints.secret_encrypted`.
      // Kener never replays this token, it only recognises one presented to it,
      // so there is no reason to be able to read it back. Same `CreateHash` HMAC
      // that guards API keys and probe tokens.
      table.text("token_hash").notNullable();
      table.string("token_hint", 32).nullable();

      // **Encrypted, because this one has to be replayed.** Sentry and Datadog
      // sign their requests with a shared secret, and verifying a signature means
      // recomputing it, which means reading the secret back out. Null for the
      // providers that sign nothing.
      table.text("signing_secret_encrypted").nullable();
      table.string("signing_secret_hint", 32).nullable();

      // ACTIVE | DISABLED. No DISABLED_AUTO twin: an outbound endpoint is
      // disabled automatically because Kener is the one failing to deliver and
      // can count its own failures. Nothing here is Kener's fault to count, and
      // switching off a receiver because its sender is noisy would silently stop
      // recording real alerts.
      table.string("status", 32).notNullable().defaultTo("ACTIVE");

      // Where an alert lands when no rule matches. Null means the endpoint
      // records the alert but opens no incident, which is the safe default for a
      // receiver somebody is still wiring up.
      table.string("default_monitor_tag", 255).nullable();

      // JSON array of {label, equals, monitor_tag}: the first match wins and
      // decides which component the alert is about. Text rather than a JSON
      // column type, because SQLite has none and the three dialects have to
      // agree (Z4's tiered rule).
      table.text("mapping_rules").nullable();

      // Null on both means "use the shipped default", so an operator who
      // configures nothing gets sensible behaviour and a later change to that
      // default reaches every endpoint that never overrode it. A stored value
      // would freeze today's default into every row ever created.
      table.string("default_impact", 32).nullable();
      table.string("default_severity", 32).nullable();

      // Whether a `resolved` payload closes the incident it opened. On by
      // default: the sender knowing the alert has cleared is the entire reason
      // to accept a resolved notification at all.
      table.boolean("auto_resolve").notNullable().defaultTo(true);

      // Operational feedback for the screen. A receiver that is never called and
      // one that is called and rejected look identical without these, and the
      // difference is the whole of "why is my alerting not showing up".
      table.integer("last_request_at").nullable();
      table.integer("last_success_at").nullable();
      table.integer("last_failure_at").nullable();
      table.text("last_error").nullable();

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });

    await knex.schema.alterTable(ENDPOINTS, (table) => {
      // The authentication lookup on every inbound request, so it is unique
      // rather than merely indexed: two endpoints sharing a token would make
      // which one receives an alert depend on row order.
      table.unique(["token_hash"], { indexName: "inbound_endpoints_token_hash_unique" });
      table.index(["org_id", "status"], "idx_inbound_endpoints_org_status");
    });
  }

  if (!(await knex.schema.hasTable(ALERTS))) {
    await knex.schema.createTable(ALERTS, (table) => {
      table.increments("id").primary();
      table.integer("org_id").notNullable().defaultTo(1);
      table.integer("endpoint_id").notNullable();

      // The sender's own identity for this alert, normalised by the provider's
      // parser. Alertmanager supplies a real fingerprint; a provider that
      // supplies none gets one derived from the fields that identify the alert,
      // so every provider has the same idempotency guarantee.
      table.string("fingerprint", 255).notNullable();

      // FIRING | RESOLVED.
      table.string("status", 16).notNullable();

      // The component this alert was mapped to, recorded even when no incident
      // was opened so the screen can explain what the receiver decided.
      table.string("monitor_tag", 255).nullable();

      // The incident this alert opened, if it opened one. Deliberately not a
      // foreign key: an operator deleting an incident by hand must not cascade
      // into the alert history that explains where it came from.
      table.integer("incident_id").nullable();

      table.string("severity", 32).nullable();
      table.text("title").nullable();
      table.text("description").nullable();
      // JSON object of the provider's labels, kept verbatim so a mapping rule
      // can be debugged against what actually arrived.
      table.text("labels").nullable();

      table.integer("first_seen_at").notNullable();
      table.integer("last_seen_at").notNullable();
      table.integer("resolved_at").nullable();
      // How many notifications this one alert has produced. The number an
      // operator wants when asking whether their alerting is too chatty.
      table.integer("notification_count").notNullable().defaultTo(1);

      table.integer("created_at").notNullable();
      table.integer("updated_at").notNullable();
    });

    await knex.schema.alterTable(ALERTS, (table) => {
      // The idempotency key, and the reason this table exists. See the note at
      // the top: without it, a re-notification is a new incident.
      table.unique(["endpoint_id", "fingerprint"], { indexName: "inbound_alerts_endpoint_fingerprint_unique" });
      table.index(["org_id", "status"], "idx_inbound_alerts_org_status");
      table.index(["incident_id"], "idx_inbound_alerts_incident");
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Both tables are dropped, which loses the alert history along with the
  // endpoints. That is honest rather than careless: the history is only
  // meaningful next to the endpoint that received it, and an endpoint cannot be
  // restored anyway because its token was never recoverable.
  await knex.schema.dropTableIfExists(ALERTS);
  await knex.schema.dropTableIfExists(ENDPOINTS);
}
