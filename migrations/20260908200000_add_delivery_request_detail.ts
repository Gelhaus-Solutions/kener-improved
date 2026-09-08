import type { Knex } from "knex";

// What was actually sent, so the delivery log can answer "why did this fail".
//
// A status code and a truncated response body tell an operator that the receiver
// said no. They do not tell them *what* it said no to, which is the question
// that actually gets asked: was the signature header there, did the payload
// carry the field the receiver needs, was a custom header substituted correctly.
// Without the request side, debugging a webhook means adding logging and waiting
// for it to fail again.
//
// It also makes a retry possible for channels that cannot rebuild their own
// message. A webhook can be regenerated from the event; a subscriber email
// cannot, because the template and the rendered variables are gone by the time
// anyone clicks retry. Storing the request body is what lets one retry button
// work for both.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("event_deliveries"))) return;

  const additions: Array<[string, (table: Knex.AlterTableBuilder) => void]> = [
    [
      "request_headers",
      // Redacted before it is written: the signature header proves nothing to a
      // reader and an Authorization header in a custom header set is a
      // credential. See audit/redact.ts, which does the same job for the audit log.
      (table) => table.text("request_headers").nullable(),
    ],
    ["request_body", (table) => table.text("request_body").nullable()],
    [
      "duration_ms",
      // How long the attempt took. A receiver that is slow rather than broken
      // looks identical in a status code, and is the more common problem.
      (table) => table.integer("duration_ms").nullable(),
    ],
  ];

  for (const [column, add] of additions) {
    if (await knex.schema.hasColumn("event_deliveries", column)) continue;
    await knex.schema.alterTable("event_deliveries", add);
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("event_deliveries"))) return;
  for (const column of ["request_headers", "request_body", "duration_ms"]) {
    if (!(await knex.schema.hasColumn("event_deliveries", column))) continue;
    await knex.schema.alterTable("event_deliveries", (table) => table.dropColumn(column));
  }
}
