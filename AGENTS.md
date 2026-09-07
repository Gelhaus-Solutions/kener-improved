You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.

## Database compatibility rule

Kener supports **SQLite**, **PostgreSQL** and **MySQL**, but not equally. Database
work falls into two tiers.

### Tier 1 - core

The schema every install needs, and all CRUD on it. **Must work on all three
dialects** via the Knex schema and query builders. Avoid raw SQL unless it is
wrapped in a dialect-safe helper.

- Use `knex.schema.hasTable` / `knex.schema.hasColumn` guards for idempotency.
- Use Knex column types (`.string()`, `.integer()`, `.text()`), not raw `ALTER TABLE`.
- Seed data inside migrations with the query builder (`.insert()`, `.update()`, `.first()`).
- Check that `defaultTo()` values and `notNullable()` constraints behave on all three.

### Tier 2 - advanced

Rollups, partitioning, full-text search, reporting and row-level security.
**PostgreSQL is the reference implementation.** SQLite and MySQL get either a
correct-but-slower fallback or the feature disabled at runtime. Do not cripple
the Postgres path to reach the lowest common denominator.

### Migrations must not fail, but may do less

A migration is allowed to skip work on a dialect. It is not allowed to crash on
one. SQLite implements several structural changes by rebuilding the whole table,
so `dropUnique`, `.alter()` to `notNullable`, and adding a foreign key all need a
dialect guard. **Skipping a constraint is acceptable; crashing is not.** Log what
was skipped so the gap is visible in the migration output rather than only in the
schema.

A migration that is meaningful only on Postgres early-returns as a no-op
elsewhere. The precedent is
[`migrations/20260831120000_monitoring_data_autovacuum.ts`](migrations/20260831120000_monitoring_data_autovacuum.ts),
which returns immediately when `knex.client.config.client !== "pg"`.

### Capability checks live in one file

Every dialect-gated behaviour carries a one-line comment naming what the other
dialects get instead.

Outside migrations, **never test the client string in application code**. Ask
[`src/lib/server/db/capabilities.ts`](src/lib/server/db/capabilities.ts) for a
capability: `hasDeclarativePartitioning()`, `hasFullTextSearch()`,
`supportsInsertReturning()`, `hasRowLevelSecurity()`, `hasFloorFunction()`. Add a
new named capability there rather than a `client === "pg"` check in a repository.
Migrations are the one exception and check the client directly.

Twelve inherited call sites still branch on `GetDbType() === "postgresql"` in the
repositories. Every one of them is the insert-returning pattern, and
`supportsInsertReturning()` deliberately answers the same way. Fold them in as
you touch those functions; do not do a sweep for its own sake, because each one
is a merge conflict on the next upstream sync.

## Documentation writing skill

When the user asks to write or edit documentation, follow the skill file:

- `.claude/skills/documentation-writer/SKILL.md`

This is mandatory for docs-related tasks. Prioritize short, clear, action-oriented docs and avoid bloat.
