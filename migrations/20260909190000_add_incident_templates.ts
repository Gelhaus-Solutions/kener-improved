import type { Knex } from "knex";

// C4: pre-written incident text, per scenario.
//
// The metric this exists to move is time-to-first-update, which is the one that
// actually matters during an outage: the gap between "we know" and "customers
// know". Writing the first update from scratch while a page is red is how that
// gap gets to twenty minutes.
//
// **A template is not a second way to create an incident.** `applyTemplate`
// renders the template into an ordinary incident input plus a first comment, and
// the caller submits that through the normal create path. Nothing here writes an
// incident. The alternative - a "create from template" endpoint that inserts the
// row itself - would mean every future change to incident creation has to be
// made twice, and the copy nobody remembers is the one that silently stops
// emitting events. `incidents.template_id`, added by C2, is the only trace a
// template leaves on the incident it produced.
//
// **Mustache, not a new templating engine.** It is already a dependency and
// already the renderer for trigger bodies, so operators writing `{{service}}`
// here see exactly the syntax they already see there.

const TABLE = "incident_templates";

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (table) => {
    table.increments("id").primary();
    table.integer("org_id").notNullable();

    table.string("name", 255).notNullable();
    table.text("description").nullable();

    // The incident's title and its first comment. Both Mustache.
    table.text("title_template").notNullable();
    table.text("body_template").nullable();

    // What the incident starts as. Nullable because a template that says nothing
    // about severity should leave the create form's own default alone rather
    // than assert NONE - "unspecified" and "explicitly none" are different
    // instructions and only one of them is what an empty field means.
    table.string("default_severity", 32).nullable();
    table.string("default_state", 32).nullable();

    /**
     * Components to attach, as a JSON array of {monitor_tag, component_impact}.
     *
     * JSON rather than a junction table, and unlike most such calls this one is
     * about *dangling references*. A template naming a monitor that is later
     * deleted must keep working - it names four components and one of them is
     * gone, so it attaches three. A junction table with a foreign key would
     * either cascade the row away silently or refuse the delete, and neither is
     * what an operator wants from a template they wrote last year.
     */
    table.text("default_components").nullable();

    /**
     * The variables an operator fills in, as a JSON array declaring key, label,
     * type, required, default and options.
     *
     * Declared rather than inferred from the template text, which would have
     * been possible - Mustache can list its own tags. Inference cannot express a
     * label, a type, a default or a closed set of options, and those are most of
     * what makes a form usable under pressure. A template with one free-text box
     * called `service` is barely better than typing the update.
     */
    table.text("variables").nullable();

    // Available to every page in the org rather than being picked per page. A
    // flag now so the per-page association C-something eventually wants has a
    // place to differ from, rather than a column added later to a table that
    // already assumed the answer.
    table.string("is_global", 15).notNullable().defaultTo("YES");

    // Incremented on use. The point is the ordering: during an outage the
    // template somebody wants is overwhelmingly the one they used last time, and
    // sorting by usage puts it at the top of a list nobody has time to read.
    table.integer("usage_count").notNullable().defaultTo(0);

    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.timestamp("updated_at").defaultTo(knex.fn.now());

    // Unique per org, not globally. `org_id` is NOT NULL, so no row can slip
    // past the constraint by leaving it null - which is the trap a nullable
    // column in a UNIQUE always sets.
    table.unique(["org_id", "name"], { indexName: "incident_templates_org_name_unique" });
    table.index(["org_id"], "idx_incident_templates_org_id");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
