# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Kener?

Kener is an open-source status page application built with **SvelteKit 2.x (Svelte 5)** and **Node.js/Express**. It is a **TypeScript-first** codebase providing real-time monitoring, uptime tracking, incident management, and customizable dashboards.

## Development Commands

```bash
npm run dev          # Start dev server (SvelteKit + cron scheduler in parallel)
npm run build        # Production build (SvelteKit then esbuild server bundle)
npm run start        # Run production build (node build/main.js)
npm run check        # Svelte + TypeScript type checking
npm run prettify     # Format all files with Prettier
npm run migrate      # Run database migrations via Knex
npm run seed         # Run database seeds (migrations run automatically first)
npm test             # Run all tests (server unit + browser component projects)
npm run test:server  # Server-side unit tests only (Node)
npm run test:client  # Component tests only (headless Chromium via Playwright)
npm run test:watch   # Watch mode
```

Component tests need a one-time `npx playwright install chromium`.

## Architecture

### Dual Process Model

In development, `npm run dev` runs two parallel processes:

1. **SvelteKit dev server** (`vite dev`) - serves the frontend
2. **Cron scheduler** (`vite-node src/lib/server/startup.ts`) - runs monitor checks, maintenance scheduler, daily cleanup

In production, `scripts/main.ts` is the single entry point: Express server + SvelteKit handler + migrations + seeds + scheduler startup.

### SvelteKit Route Groups

- **`(kener)/`** - Public status page
- **`(manage)/`** - Admin dashboard (authenticated)
- **`(embed)/`** - Embeddable widgets
- **`(docs)/`** - Documentation pages
- **`(api)/`** - SvelteKit API routes; also `src/lib/server/api-server/` for Express-side API handlers (file-based routing: `./action/method.ts`)
- **`(account)/`** - Account/auth pages
- **`(ext)/`** - External integrations
- **`(assets)/`** - Asset serving

### Database

- **Knex.js** for query building and migrations. Supports SQLite (default), PostgreSQL, MySQL
- Connection configured via `DATABASE_URL` env var: `sqlite://./path`, `postgresql://...`, `mysql://...`
- Migrations in `/migrations/`, seeds in `/seeds/`
- Always use the db singleton: `import db from "$lib/server/db/db"`

### Monitor Services

Each monitor type has a dedicated implementation in `src/lib/server/services/`:

- Types: API, Ping, TCP, DNS, SSL, SQL, Heartbeat, GameDig, Group, gRPC, None
- Scheduled via `src/lib/server/schedulers/` using `croner`
- Job queues managed with **BullMQ** + **Redis** (`src/lib/server/queues/`)

### Build System

`npm run build` is a two-step process:

1. `scripts/build-sveltekit.js` - Vite build of SvelteKit app (optionally with `--with-docs`)
2. `scripts/build-server.js` - esbuild bundles `scripts/main.ts` into `build/main.js`

## Key Conventions

- Always ask a lot of questions.
- Never commit with any desc or coauthor. Use only a small conventional title for regular commits too. 
- Never use any em-dashes.

### Svelte 5 + TypeScript

- Use **TypeScript** for new/modified code
- Use **Svelte 5 runes** (`$state`, `$derived`, `$effect`, `$props()`) in new components
- Use generated `$types` for SvelteKit route typing (`import type { PageServerLoad } from './$types'`)
- Use `import type { ... }` for type imports

### UI Components

- **shadcn-svelte** components in `src/lib/components/ui/`
- Import: `import { Button } from "$lib/components/ui/button"`
- Styling: **Tailwind CSS v4** with HSL CSS variables for theming

### Timestamps

All timestamps are **UTC seconds** (not milliseconds). Use helpers from `src/lib/server/tool.ts`.

### Status Constants

Constants are exported as a **default export** from `src/lib/global-constants.ts`:

```typescript
// In Svelte/client code or SvelteKit routes:
import GC from "$lib/global-constants"
// Usage: GC.UP, GC.DOWN, GC.DEGRADED, GC.MAINTENANCE, GC.NO_DATA

// In server code (use relative path):
import GC from "../../global-constants.js"
// Usage: GC.UP, GC.DOWN, etc.
```

### API Authentication

APIs use Bearer token auth: `import { VerifyAPIKey } from "$lib/server/controllers/apiController"`

### Types Location

- `src/lib/types/` - Shared types (client + server)
- `src/lib/server/types/` - Server-only types
- `src/lib/client/types/` - Client-only types

### i18n

Locale files in `src/lib/locales/`. Add translations by creating `{code}.json` and updating `locales.json`.

## Environment Variables

Required: `KENER_SECRET_KEY`, `ORIGIN`, `REDIS_URL`
Optional: `DATABASE_URL` (defaults to SQLite), `KENER_BASE_PATH`, `PORT` (default 3000), `RESEND_API_KEY`, `RESEND_SENDER_EMAIL`

## This repo is a fork

`Gelhaus-Solutions/kener-improved` is a fork of `rajnandan1/kener` that diverges
on purpose in `src/` and `migrations/`, while never renaming or rebranding the
product. **Read `FORK.md` before changing anything outside `src/`.**

Practical rules when working here:

- **Do not rename or rebrand the product.** "Kener", the UI strings, the seeded
  site data and the docs content are intentionally identical to upstream.
  Renaming them would make every future upstream merge conflict, and that
  restraint is what pays for diverging freely everywhere else.
- **Fix things here, not upstream.** Nothing is contributed back; the sync is
  one-directional. An upstream bug this fork also carries may be *reported*
  upstream, but the fix still lands here first.
- **Never `git merge upstream/main` directly.** Use `npm run sync:upstream`. The
  `merge=ours` driver that `.gitattributes` relies on is registered by that
  script; a plain merge silently ignores it.
- **Adding a fork-owned file?** Add it to the *Fork-owned files* block in
  `.gitattributes` and to the divergence table in `FORK.md`.

## Skills

Read `.claude/skills/` for specialized instructions on:

- **svelte-code-writer** - Svelte component creation/editing
- **documentation-writer** - Editing docs in `src/routes/(docs)/docs/content/`
- **tailwindcss** - Tailwind CSS v4 patterns

## Agent skills

### Issue tracker

Roadmap work, PRDs and agent tasks are tracked in **Plane**, project `KENER`
(`427cd087-24cd-489f-9bb9-53454dea0a70`), via the `plane` MCP server. Work items
are `KENER-<n>`; modules are backlog categories A-J plus Z, cycles are phases
P0-P11. Move an item to `In Progress` when you start it, and comment with the
commit and any deviation before moving it to `Done`.

GitHub Issues is retained **only** for reporting bugs that also exist upstream
in `rajnandan1/kener`, so the fix arrives here on the next sync. Nothing else
goes there. See `docs/agents/issue-tracker.md`.

### Triage labels

Not used. Triage state is the Plane work item state. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-doc layout. See `docs/agents/domain.md`.
