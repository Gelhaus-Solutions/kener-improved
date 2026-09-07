# Issue tracker: Plane

Roadmap work, PRDs and every task an agent picks up live in **Plane**, not in
GitHub Issues.

| | |
| --- | --- |
| Project | `KENER` |
| Project id | `427cd087-24cd-489f-9bb9-53454dea0a70` |
| Workspace id | `a617282b-6201-48b1-93b7-a7af31c62626` |
| Work item ids | `KENER-<n>`, e.g. `KENER-14` |

Operate on it through the `plane` MCP server. Its tools are `workitem`,
`workitem_comment`, `workitem_relation`, `module`, `cycle`, `label`, `state`
and `page`; each takes an `action` plus `project_id`. There is no CLI.

## How the project is organised

**Modules are backlog categories.** A work item belongs to the area it changes.

| Module | Area |
| --- | --- |
| `A - Identity and access control` | Sessions, MFA, scoped API keys, audit log, per-page permissions |
| `B - Monitoring depth` | Regions and probes, percentiles, cert expiry, third-party ingestion |
| `C - Incident management` | Postmortems, severity, dependency rollup, templates, backfill |
| `D - Maintenance windows` | Lead times, iCal, alert suppression, timezone correctness |
| `E - Notifications and subscribers` | Event bus, lifecycle webhooks, subscriptions, escalation |
| `F - Reporting, SLA, analytics` | Rollups and retention, SLOs, exports, incident metrics |
| `G - Public page experience` | Filtering, group display, custom domains, live updates |
| `H - Integrations and automation` | Inbound webhooks, declarative config, Terraform, Slack |
| `I - Platform, operations, compliance` | Multi-tenancy, logging, backups, rate limiting, performance |
| `J - Fork differentiators` | Probe federation, blast radius, evidence export, signed history |
| `Z - Fork infrastructure` | Fork ownership, sync tooling, ADRs, AGENTS.md rules, refactors |

**Cycles are delivery phases**, `P0 - Foundations` through
`P11 - Private pages and audiences`. A cycle is *when*, a module is *what*.
Sequencing between phases is load-bearing: read the cycle description before
pulling an item out of order.

**Labels** carry effort, risk and review triggers:

| Label | Meaning |
| --- | --- |
| `effort:S` / `effort:M` / `effort:L` | Days / one to three weeks / more than a month |
| `risk:high` | Irreversible, silent-failure, or breaks login or notifications for everyone |
| `blocks-others` | Other work items cannot start until this lands |
| `schema-migration` | Adds or alters tables; needs a migration and a dialect-guard review |
| `perf` | Measurable latency or query-count improvement |
| `security` | Auth, tenancy isolation, secrets, or a cross-tenant leak surface |
| `already-upstream` | The backlog claimed this was missing but upstream already ships it |

**States**: `Backlog`, `Todo`, `In Progress`, `Testing`, `Done`, `Cancelled`.

## Conventions

- **Create a work item**: `workitem` with `action: "create"`, `project_id`, and
  `name`. `description_html` is HTML, not markdown. Attach it to a module and a
  cycle with `module` / `cycle` `action: "manage_workitems"`.
- **Read one by its identifier**: `workitem` with
  `action: "retrieve_by_identifier"` and `workitem_identifier: "KENER-14"`. This
  is the usual entry point, since that is the id a human quotes.
- **Read one by uuid**: `workitem` with `action: "retrieve"`, `project_id` and
  `workitem_id`.
- **List / filter**: `workitem` with `action: "list"` and a `pql` filter, e.g.
  `pql: 'state = "<uuid>" AND label = "<uuid>"'`. PQL wants UUIDs, so resolve
  names through `state list` / `label list` first. `get_pql_reference` has the
  full syntax.
- **Comment**: `workitem_comment` with `action: "create"` and `comment_html`.
- **Change state**: `workitem` with `action: "update"` and `state: "<uuid>"`.
  Only the fields you pass are changed.
- **Labels**: `workitem` with `action: "manage_label"`, `add_label_id` /
  `remove_label_id`. The list is merged, not replaced.

### Working an item

1. Move it to `In Progress` before you start.
2. When it lands, comment with the commit sha and subject, what you actually
   did, and **any deviation from the item's description with the reason**. The
   comment is the handoff to the next session.
3. Move it to `Done`.

## GitHub Issues

Retained for exactly one purpose: **reporting a bug that also exists upstream**
in [`rajnandan1/kener`](https://github.com/rajnandan1/kener/issues). Those go
upstream so the fix reaches everyone and arrives here on the next sync. See
[FORK.md](../../FORK.md).

Nothing else belongs there. Do not open roadmap work, PRDs or fork-specific
tasks as GitHub issues on either repo.

## When a skill says "publish to the issue tracker"

Create a Plane work item in project `KENER`.

## When a skill says "fetch the relevant ticket"

Retrieve the Plane work item, and list its comments as well. The comments
carry the implementation history.
