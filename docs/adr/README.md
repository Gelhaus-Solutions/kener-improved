# Architecture Decision Records

Short records of decisions the code depends on. Comments in `src/` cite these by
path, so a missing file is a broken reference, not just a missing doc.

## Two number ranges

**0001-0099 are upstream decisions, reconstructed.** Upstream
(`rajnandan1/kener`) cites ADR numbers from source comments but has never
published the documents themselves. This fork reconstructed them **from the code
that cites them**: the decision each file states is the decision the code
actually implements, quoted alongside it. Where upstream's original reasoning is
unknown, the file says so rather than inventing one.

Treat these as an accurate description of current behaviour and a reliable spec
to refactor against. Do not treat them as upstream's own words.

**0100 and up are this fork's own decisions.** Numbering fork ADRs from 0100
means upstream can keep allocating 00xx forever without ever colliding with us.

## Reconstructed so far

| ADR | Decision | Cited from |
| --- | --- | --- |
| [0002](0002-address-by-id-not-constructed-paths.md) | Link via the response's `url` field, never by concatenating an id onto a path | `src/lib/types/api.ts` |
| [0004](0004-home-page-api-token.md) | The home page is addressed in the API by the token `~home`; its stored `page_path` is `""` | `src/lib/global-constants.ts`, `src/lib/types/api.ts` |
| [0005](0005-alerts-evaluate-alert-visible-samples.md) | Alert evaluation sees only alert-visible sample types; overlays are invisible to it | `src/lib/server/db/repositories/monitoring.ts` |
| [0006](0006-manual-maintenance-event-transitions.md) | Manually ending a maintenance event rewrites `end_date_time` only if it had started | `src/lib/server/controllers/maintenanceController.ts` |
| [0007](0007-problem-first-overall-status.md) | Overall status is problem-first: a healthy majority never masks an active problem | `src/lib/clientTools.ts` |
| [0008](0008-explicit-deletes-over-fk-cascades.md) | Delete child rows explicitly; never rely on FK cascades | `src/lib/server/db/repositories/monitorAlertConfig.ts` |

ADRs 0001 and 0003 are not cited from `src/`, so there was nothing to
reconstruct from. They are almost certainly real upstream decisions; we simply
have no evidence of what they said. Do not reuse those numbers.

## Writing a new one

Fork ADRs start at `0100`. Keep them short: the decision, why, and what it rules
out. If code depends on the decision, cite the ADR path from the code, the way
the reconstructed ones are cited.

`docs/adr/` is fork-owned in `.gitattributes`, so upstream edits to it are
dropped on sync.
