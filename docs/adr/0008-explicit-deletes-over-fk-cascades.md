# ADR 0008: Delete child rows explicitly; never rely on FK cascades

- **Status:** Accepted. Describes current behaviour.
- **Origin:** Upstream decision, **reconstructed by this fork** from the code that cites it. See [README](README.md).
- **Cited from:** `src/lib/server/db/repositories/monitorAlertConfig.ts` (`deleteMonitorAlertConfig`)

## Context

The schema declares foreign keys with `ON DELETE CASCADE`, and on PostgreSQL and
MySQL they work. Deleting a parent removes its children.

SQLite is the default database for a Kener install, and **SQLite does not
enforce foreign keys unless `PRAGMA foreign_keys = ON` is set on every
connection**. Kener does not set it. The constraints are parsed and stored, and
then ignored.

So a cascade that is tested on Postgres and shipped orphans rows on the
deployment most users actually run. There is no error and no warning; the parent
disappears, the children stay, and they surface later as configuration that
still fires for a monitor nobody can see.

## Decision

**Delete children explicitly, in the repository, in dependency order. Treat FK
cascades as documentation of intent, never as a mechanism.**

```ts
/**
 * Delete a monitor alert config by ID, including all child rows.
 *
 * Child rows are removed explicitly even though FK cascades are declared:
 * SQLite never enforces them (foreign_keys pragma is off), so relying on
 * CASCADE orphans children on the default deployment.
 */
async deleteMonitorAlertConfig(id: number): Promise<number> {
  await this.knex("monitor_alerts_v2").where({ config_id: id }).del();
  await this.knex("monitor_alerts_config_triggers").where({ monitor_alerts_id: id }).del();
  await this.knex("monitor_alerts_config_monitors").where({ monitor_alerts_id: id }).del();
  return await this.knex("monitor_alerts_config").where({ id }).del();
}
```

Deepest child first, parent last. The order is what keeps the operation safe to
interrupt: at every point the rows that remain are still reachable from a parent
that still exists.

The same reasoning extends to partial detaches, where there is no cascade to
imitate in the first place:

```ts
// Remove the monitor from the junction table, along with its per-monitor
// alert state - a shared config survives the detach, but its v2 rows for
// this tag would otherwise dangle (see deleteMonitorAlertConfig on why
// FK cascades can't be relied on)
await this.knex("monitor_alerts_v2").where({ monitor_tag: monitorTag }).del();
await this.knex("monitor_alerts_config_monitors").where({ monitor_tag: monitorTag }).del();
```

Removing one monitor from a shared config must not delete the config, but it
must clear that monitor's alert state. Only application code knows the
difference, so the cleanup is application code, and configs left with zero
monitors are then deleted in a follow-up pass.

## Consequences

- Deletes are multi-statement and therefore not atomic on their own. Interrupted
  midway they leave a consistent parent with fewer children, which is the
  survivable direction, but a delete that must be all-or-nothing has to be
  wrapped in a transaction by its caller.
- **Adding a child table means editing the delete path.** A new table referencing
  `monitor_alerts_config` will orphan rows on SQLite until its `.del()` is added,
  and Postgres will hide the omission by cascading correctly. Grep for the parent
  table's delete whenever you add a table that references it.
- Deletes cost several round trips. Acceptable: they are rare and
  administrator-initiated.
- The declared cascades stay in the migrations. They document the relationship
  and do the right thing on Postgres and MySQL, so nothing is lost by keeping
  them, as long as no code assumes they ran.

## Alternatives rejected

- **Enable `PRAGMA foreign_keys = ON` for SQLite.** The honest fix, but it turns
  every previously-ignored constraint on at once, across a schema and an existing
  install base that were built while they were off. Enforcement would begin
  failing writes that work today, on user data nobody can inspect first. Possible
  later, behind a migration that verifies existing rows; not a prerequisite for
  correct deletes.
- **Rely on cascades and document SQLite as unsupported.** SQLite is the default.
- **A generic cascade helper driven by schema metadata.** More machinery, and the
  partial-detach case above still has to be written by hand.
