---
title: Upgrading and Rolling Back
description: How Kener applies schema changes on start, and what to do when you need to go back
---

Kener migrates its database automatically when the container starts, before it accepts traffic. Upgrading is normally just pulling a newer image.

## Upgrade {#upgrade}

```bash
docker pull ghcr.io/gelhaus-solutions/kener-improved:latest
docker compose up -d
```

On start Kener runs pending migrations, then the seeds, and only then opens the port. If a migration fails the container exits non-zero rather than serving traffic against a half-changed schema.

> [!IMPORTANT]
> Back up your database before upgrading. A migration that rewrites a table cannot be undone from the application.

## Rolling back {#rolling-back}

> [!WARNING]
> **Rolling the image back does not roll the schema back.** Migrations have already run. An older image started against a newer schema will see columns and tables it does not know about, and may fail on ones it expects to be shaped differently.

To go back to an earlier release:

1. Stop the container.
2. Restore the database backup you took before upgrading.
3. Start the older image.

If you have no backup, roll the schema back by hand before starting the older image. Each migration knows how to reverse itself:

```bash
# undo the most recent migration
npx knex migrate:down

# see what has been applied and what is pending
npx knex migrate:list
```

Some migrations cannot restore what they removed, and say so in a comment where the reversal would be. Rolling those back recreates the structure, not the data.

## Applying migrations deliberately {#auto-migrate}

Set `KENER_AUTO_MIGRATE=false` to stop the container migrating on start. It then checks the schema instead: if anything is pending it lists it and refuses to start, so an instance never runs new code against an old schema.

```bash
# with auto-migrate off, apply the schema change yourself first
npx knex migrate:latest
docker compose up -d
```

| Variable             | Description                                      | Default |
| -------------------- | ------------------------------------------------ | ------- |
| `KENER_AUTO_MIGRATE` | Run pending migrations when the container starts | `true`  |

Seeds run either way. They provision an organisation's own rows, are safe to re-run, and need a current schema, which the check above guarantees.

## Verify {#verify}

After upgrading, confirm the schema is current and nothing is pending:

```bash
npx knex migrate:list
```

Then load your status page and the admin dashboard. A page that renders and a monitor that has a recent sample are the two signals worth checking.

## Troubleshooting {#troubleshooting}

- **Container exits with "Refusing to start on a partially migrated database"**: a migration failed. The error above it names which. Fix the cause (usually permissions or disk), then start again; applied migrations are not re-run.
- **Container exits with "KENER_AUTO_MIGRATE is off and N migration(s) have not been applied"**: run `npx knex migrate:latest` against the same `DATABASE_URL`, then start again.
- **Older image fails to start after a rollback**: the schema is ahead of the code. Restore the backup, or roll the migrations back with `npx knex migrate:down` until the versions match.
- **Migration failed on PostgreSQL**: ensure the database exists and the user can `CREATE` and `ALTER`. See [Database Setup](/docs/v4/setup/database-setup#troubleshooting).
