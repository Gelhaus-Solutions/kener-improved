# Triage Labels

**This repo does not use triage labels.** The five canonical roles the skills
speak in (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`) have no counterpart here, and creating them would be theatre: there
is no inbound public issue queue to triage.

If a skill asks you to apply a triage label, **skip that step** and say so once.
Do not invent a label to satisfy it.

## What we use instead

The tracker is Plane, not GitHub Issues (see
[issue-tracker.md](issue-tracker.md)). Triage state is carried by the **work
item state**, not by a label:

| Triage role in the skills | Equivalent here |
| --- | --- |
| `needs-triage` | State `Backlog` |
| `needs-info` | No equivalent. Comment on the item and leave its state alone. |
| `ready-for-agent` | State `Todo` |
| `ready-for-human` | No equivalent. Say so in a comment. |
| `wontfix` | State `Cancelled` |

Plane's own labels (`effort:*`, `risk:high`, `blocks-others`,
`schema-migration`, `perf`, `security`, `already-upstream`) describe the shape
of the work, not its triage status. They are documented in
[issue-tracker.md](issue-tracker.md) and are the only labels in the project.
