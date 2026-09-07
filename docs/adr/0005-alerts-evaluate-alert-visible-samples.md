# ADR 0005: Alert evaluation sees only alert-visible sample types

- **Status:** Accepted. Describes current behaviour.
- **Origin:** Upstream decision, **reconstructed by this fork** from the code that cites it. See [README](README.md).
- **Cited from:** `src/lib/server/db/repositories/monitoring.ts` (`ALERT_VISIBLE_TYPES`), `src/routes/(api)/api/v4/monitors/[monitor_tag]/data/+server.ts`

## Context

`monitoring_data` is not one stream. Rows arrive from several unrelated sources
and are distinguished by `type`:

| Type | Written by |
| --- | --- |
| `REALTIME`, `ERROR`, `TIMEOUT` | Scheduled checks: the actual probe result |
| `DEFAULT_STATUS` | Default-status fill for a monitor with no sample in a minute |
| `MANUAL` | Pushes through the data API |
| `SIGNAL` | Raw heartbeat receipts |
| `INCIDENT`, `MAINTENANCE` | Overlays written by incident and maintenance handling |

Alert evaluation asks "has this monitor been down for N consecutive minutes?"
over a window of that table. If it reads every row, the answer depends on
overlays that say nothing about whether the service is reachable. An operator
opening an incident writes `INCIDENT` rows, and the alerting engine reads its
own status page back as evidence.

## Decision

**Alert evaluation reads a fixed allowlist of sample types. Everything else is
invisible to it.**

```ts
/**
 * Sample types alert evaluation can see.
 * Exactly the types written by flows that enqueue alert evaluation: scheduler checks
 * (REALTIME/ERROR/TIMEOUT), default-status fill (DEFAULT_STATUS), and data-API pushes (MANUAL).
 * SIGNAL rows (raw heartbeat receipts) and INCIDENT/MAINTENANCE overlays stay invisible, so the
 * alert window freezes during manual overlays instead of triggering or resolving on them.
 */
const ALERT_VISIBLE_TYPES = [GC.REALTIME, GC.ERROR, GC.TIMEOUT, GC.MANUAL, GC.DEFAULT_STATUS];
```

The membership rule is precise, and worth stating as a rule rather than a list:
**a type is alert-visible if and only if writing it enqueues alert evaluation.**
Anything that triggers evaluation must be visible to it, or evaluation runs on a
window that does not contain the row that caused it. Anything that does not
trigger evaluation must not be visible, or it silently perturbs a window
computed for some other reason.

`MANUAL` is in the list for exactly this reason, and the data API says so at the
call site:

```ts
// MANUAL samples are alert-visible (docs/adr/0005), so re-evaluate alerts once for the ...
```

### Overlays freeze the window; they do not change it

Excluding `INCIDENT` and `MAINTENANCE` means an overlay does not add rows the
evaluator can see. The window does not fill with bad samples, and it does not
fill with good ones either. **The alert window freezes**: an alert that was
pending stays pending, and one that was firing does not resolve merely because
maintenance was declared.

This is deliberately not the same thing as suppression. Nothing is discarded and
no timer is reset; evaluation simply has no new evidence, so its conclusion does
not move. When real samples resume, evaluation continues from where it was.

`SIGNAL` is excluded on different grounds: it is the raw receipt of a heartbeat,
not an assessment of one. Heartbeat monitors turn receipts into `REALTIME` or
`TIMEOUT`, and that derived row is the one alerting reads.

### Three overlapping sets, not one

The same file defines two narrower sets, and the distinction matters:

```ts
// Scheduled-check sample types that count toward Confirmation Threshold.
// Intentionally narrower than ALERT_VISIBLE_TYPES: MANUAL pushes
// and DEFAULT_STATUS fill stay transparent to threshold counting.
const OBSERVED_CHECK_TYPES = [GC.REALTIME, GC.TIMEOUT, GC.ERROR];

// Overlay sample types that FREEZE Confirmation Threshold counting:
// while one is active the count does not advance, and it acts as a hard
// boundary the pending run cannot cross.
const OVERLAY_TYPES = [GC.INCIDENT, GC.MAINTENANCE];
```

So a type's visibility is per-question, not global. `MANUAL` is visible to
alerting and transparent to confirmation counting. `INCIDENT` is invisible to
alerting and an explicit boundary for confirmation. Reusing one list for both
would be wrong in both directions.

## Consequences

- Declaring an incident or a maintenance window cannot itself trigger or resolve
  an alert.
- A new sample type is invisible to alerting until it is added to the list, and
  the correct question is not "is this important?" but "does writing it enqueue
  alert evaluation?". If yes, add it, or evaluation will run on a window missing
  its own trigger.
- Alerting and the public status page can legitimately disagree during an
  overlay. The page shows the overlay; alerting shows the last real evidence.
  That is intended, not a bug to reconcile.
- Changing the list changes alert timing for every existing monitor, since the
  window contents change retroactively.

## Alternatives rejected

- **Evaluate every row.** Lets the status page feed itself back into alerting.
- **Suppress alerting outright during maintenance.** Loses the pending state, so
  a failure that starts during a window restarts its confirmation count from
  zero afterwards. Freezing preserves it.
- **One shared visibility list for alerting and confirmation counting.** Would
  make `MANUAL` pushes count toward the confirmation threshold, letting an API
  client manufacture a confirmed alert.
