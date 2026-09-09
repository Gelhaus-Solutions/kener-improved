import type { Knex } from "knex";

// C1: postmortems as their own object with their own lifecycle.
//
// **Why not a final incident comment**, which is what you would abuse today.
// A comment is published the instant it is written, is ordered inside a live
// timeline, and notifies subscribers as a status update. A postmortem is the
// opposite of all three: it is drafted after the incident closed, sits in review
// for days, and is published as a document rather than as an update. Modelling it
// as a comment would mean either publishing every draft immediately or teaching
// `incident_comments` a second visibility rule that only one kind of comment
// uses.
//
// **One per incident**, enforced by a UNIQUE on `incident_id` rather than by
// convention. A second postmortem on the same incident is not a thing anybody
// wants; it is a thing that happens when two people open the editor at once, and
// the failure it produces is two documents that disagree.
//
// **What is deliberately NOT here: a copy of the lifecycle timestamps.** The C1
// item lists "the MTTD/MTTR timestamps" as columns of this table, defaulting from
// `incidents` and refined later by C2c. C2c has since landed and put
// `detected_at`, `acknowledged_at`, `identified_at`, `mitigated_at` and
// `resolved_at` on `incidents` itself, so copying them here would create a second
// source of truth for a set of facts that already has one. The failure mode is
// specific and bad: an operator corrects a resolution time on the incident, the
// incident page updates, and the published postmortem sitting under it keeps
// quoting the old number. A postmortem's *narrative* is frozen at publication
// because somebody wrote it; the *timings* are facts about the incident, and a
// document that contradicts the incident it describes is worse than one that
// changes.

const TABLE = "incident_postmortems";

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (table) => {
    table.increments("id").primary();
    table.integer("org_id").notNullable();
    table.integer("incident_id").notNullable();

    // DRAFT | PUBLISHED | ARCHIVED.
    //
    // ARCHIVED rather than a delete, because a postmortem that was public and is
    // now not is a fact worth keeping: somebody linked to it, and "we withdrew
    // it" is a different answer from "it never existed".
    table.string("status", 20).notNullable().defaultTo("DRAFT");

    table.string("title", 255).notNullable();
    table.text("summary").nullable();
    table.text("root_cause").nullable();
    table.text("impact_description").nullable();
    table.text("resolution").nullable();
    // The long-form body. Markdown, rendered through `src/lib/marked.js` - the
    // same pipeline and therefore the same sanitisation as incident comments, so
    // no new dependency and no second answer to what HTML a customer may inject.
    table.text("body_md").nullable();

    /**
     * Follow-up actions, as a JSON array of {text, owner, due_at, status}.
     *
     * JSON rather than a table, and the line is worth drawing: these are prose
     * commitments attached to one document, never queried across documents,
     * never joined, and edited only as a whole list by the person writing the
     * postmortem. A table would buy referential integrity nobody needs and cost a
     * second editor, a second set of actions and a second migration when the
     * shape changes.
     */
    table.text("action_items").nullable();

    // COMMENTS: render the incident's own comment timeline. CUSTOM: render
    // `timeline_custom`, a JSON array of {at, text}, because the live timeline
    // during an incident is written under pressure and is often not the account
    // you want to publish a week later.
    table.string("timeline_source", 20).notNullable().defaultTo("COMMENTS");
    table.text("timeline_custom").nullable();

    // Null while it is a draft. Set on the first publish and **not cleared by an
    // unpublish**: it answers "when was this first made public", which is what a
    // reader and an auditor both want, and an unpublish does not un-happen.
    table.integer("published_at").nullable();

    // No foreign keys to `users`: a postmortem outlives the person who wrote it,
    // and CASCADE would delete the document when the author's account is removed
    // while SET NULL would need an ALTER on a table users already references.
    // The UI resolves these defensively.
    table.integer("author_user_id").nullable();
    table.integer("last_editor_user_id").nullable();

    // Whether publishing mails subscribers. Default NO, because the safe default
    // for a thing that sends mail is not to.
    table.string("notify_subscribers", 15).notNullable().defaultTo("NO");

    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.timestamp("updated_at").defaultTo(knex.fn.now());

    // Inline foreign key on a table being *created*, which is safe on both
    // dialects; the SQLite rebuild hazard is specific to adding one to an
    // existing table. CASCADE because a postmortem with no incident is not a
    // document anybody can read - every surface it appears on is reached through
    // the incident.
    table.foreign("incident_id").references("id").inTable("incidents").onDelete("CASCADE");

    table.unique(["incident_id"], { indexName: "incident_postmortems_incident_unique" });
    table.index(["org_id"], "idx_incident_postmortems_org_id");
    // The public read: published postmortems for an org, newest first. Both the
    // incident page and the RSS feed go through it.
    table.index(["org_id", "status", "published_at"], "idx_incident_postmortems_org_status_published");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
