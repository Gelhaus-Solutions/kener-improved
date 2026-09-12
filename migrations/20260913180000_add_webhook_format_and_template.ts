import type { Knex } from "knex";

// E11. What shape an endpoint receives, and what the operator wrote in it.
//
// **`format`.** `sendWebhook` posts Kener's own envelope, which is right for a
// receiver written against Kener and wrong for a chat service with a required
// body of its own. A Discord webhook URL configured today rejects every delivery
// and the endpoint auto-disables after twenty consecutive failures, which reads
// to the operator as "Kener is broken" rather than "that is the wrong shape".
//
// GENERIC on every existing row, so nothing that works today changes. This sits
// beside `api_version`, which already froze the envelope per endpoint for the
// same reason: a receiver in the field must not be broken by a change made for
// somebody else's receiver.
//
// **`message_template`.** A notification that cannot mention anybody is a
// notification nobody reads at 3am, so the operator has to be able to say what
// arrives rather than only whether something does. Nullable, meaning "use the
// format's default", rather than seeded with that default: a default stored as a
// row can never be improved, because there is no way to tell a copy of the old
// default from a deliberate choice to keep it.
//
// Deliberately NOT a per-event-type template. One template per endpoint covers
// the case this was asked for - mention on-call for anything this endpoint
// carries - and per-type authoring is a table rather than a column. The column
// does not block it later.

const TABLE = "webhook_endpoints";

const COLUMNS: Array<[string, (table: Knex.CreateTableBuilder) => void]> = [
  ["format", (table) => table.string("format", 16).notNullable().defaultTo("GENERIC")],
  ["message_template", (table) => table.text("message_template").nullable()],
];

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return;

  for (const [name, define] of COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, name)) continue;
    await knex.schema.alterTable(TABLE, (table) => {
      define(table as unknown as Knex.CreateTableBuilder);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return;

  for (const [name] of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, name))) continue;
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropColumn(name);
    });
  }
}
