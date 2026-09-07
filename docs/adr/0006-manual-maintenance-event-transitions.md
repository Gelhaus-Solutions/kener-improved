# ADR 0006: Manually ending a maintenance event rewrites its window only if it started

- **Status:** Accepted. Describes current behaviour.
- **Origin:** Upstream decision, **reconstructed by this fork** from the code that cites it. See [README](README.md).
- **Cited from:** `src/lib/server/controllers/maintenanceController.ts` (`UpdateMaintenanceEventStatus`)

## Context

A maintenance event has a planned window (`start_date_time`, `end_date_time`)
and a status that normally advances on its own: `SCHEDULED` → `READY` →
`ONGOING` → `COMPLETED`.

Operators need to override that. Work finishes early, or a window is called off
before it begins. Both are "end this event now", but they are not the same
record change, because in one case the window describes something that happened
and in the other it describes something that never did.

The event's window is not merely display. It drives maintenance overlays, alert
window freezing ([ADR 0005](0005-alerts-evaluate-alert-visible-samples.md)) and
uptime accounting, so rewriting it rewrites history.

## Decision

**Only two manual transitions exist, and the window is rewritten only for an
event that actually started.**

Allowed transitions, enforced explicitly:

```ts
const allowedFrom: string[] =
  targetStatus === GC.COMPLETED ? [GC.ONGOING] : [GC.SCHEDULED, GC.READY, GC.ONGOING];
```

- `ONGOING` → `COMPLETED`
- `SCHEDULED` / `READY` / `ONGOING` → `CANCELLED`

Anything else throws. In particular an event that never started cannot be
*completed*, only cancelled: "completed" is a claim that the work happened.

The window rule follows from the status it is leaving, not the one it is
entering:

```ts
if (existing.status === GC.ONGOING) {
  // Ended now, but never before its first minute nor after its planned end
  const endDateTime = Math.min(
    existing.end_date_time,
    Math.max(GetMinuteStartNowTimestampUTC(), existing.start_date_time + 60),
  );
  await db.updateMaintenanceEvent(id, { status: targetStatus, end_date_time: endDateTime });
} else {
  await db.updateMaintenanceEventStatus(id, targetStatus);
}
```

**An event that started** has `end_date_time` moved to the moment it was ended,
so the record reflects what actually happened. The new end is clamped at both
sides:

- **Not after the planned end** (`Math.min` with `existing.end_date_time`).
  Ending early shortens the window; it can never extend one.
- **Not before `start_date_time + 60`** (`Math.max`). Every event that ran
  occupies at least one whole minute, because `monitoring_data` is bucketed per
  minute and a zero-length window would produce an event that ran but overlays
  nothing.

**An event that never started** keeps its planned window untouched, and only its
status changes. A cancelled window records what was intended, which is what a
reader of the history wants to know. Moving its end to "now" would invent a
window that never occurred, and moving it to its start would fabricate a
zero-length event.

The status write is unconditional and precedes notification. Notification is
best-effort and wrapped in its own `try/catch`, so a failure to notify never
leaves the event in its old status.

## Consequences

- A manually completed event is always at least one minute long, even if it is
  ended seconds after it starts.
- A completed event's window never extends past what was announced, so the
  public record cannot retroactively claim more maintenance than was scheduled.
- Cancelled events are distinguishable from completed ones by more than status:
  their window is still the planned one.
- Because the branch keys on the status being **left**, adding a new pre-start
  status means adding it to `allowedFrom` for `CANCELLED` and leaving the window
  logic alone. Adding a new in-progress status means it must also take the
  rewrite branch, or a running event can end without its window being corrected.
- Timestamps are UTC seconds snapped to a minute boundary
  (`GetMinuteStartNowTimestampUTC`), consistent with `monitoring_data`.

## Alternatives rejected

- **Always move `end_date_time` to now.** Rewrites cancelled events into windows
  that never happened.
- **Allow `SCHEDULED` → `COMPLETED`.** Records work as done that was never
  started; "cancelled" already covers it honestly.
- **Allow a zero-length completed event.** Produces an event with no minute
  bucket, so it overlays nothing and is invisible to everything downstream while
  still appearing in the history.
- **Let the manual end exceed the planned end.** Would let an operator quietly
  extend an announced window after the fact.
