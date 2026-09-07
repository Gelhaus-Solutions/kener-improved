# ADR 0007: Problem-first overall status

- **Status:** Accepted. Describes current behaviour.
- **Origin:** Upstream decision, **reconstructed by this fork** from the code that cites it. See [README](README.md).
- **Cited from:** `src/lib/clientTools.ts` (`CollapseStatusCounts`)

## Context

A status bucket is not a status. It is a count of samples:

```ts
type StatusCounts = Pick<
  TimestampStatusCount,
  "countOfUp" | "countOfDown" | "countOfDegraded" | "countOfMaintenance"
>;
```

One bar on the 90-day chart, or one monitor's current state, or a whole page's
headline, all come from collapsing such a bucket into a single status. A day
with 1,438 UP samples and 2 DOWN samples has to become one word.

The obvious collapse is majority rule, and it is wrong for a status page. A
two-minute outage inside a 24-hour bucket is 99.86% healthy and would render as
"All Systems Operational" while the incident is still being written up. The
whole purpose of the page is to surface the problem.

## Decision

**Collapse by severity, not by frequency. A single sample of a worse state beats
any number of samples of a better one.**

```ts
function CollapseStatusCounts(counts: StatusCounts): StatusType {
  const total = counts.countOfUp + counts.countOfDown + counts.countOfDegraded + counts.countOfMaintenance;
  if (total === 0) return GC.NO_DATA;
  if (counts.countOfDown > 0) return GC.DOWN;
  if (counts.countOfDegraded > 0) return GC.DEGRADED;
  if (counts.countOfMaintenance > 0) return GC.MAINTENANCE;
  return GC.UP;
}
```

The precedence is fixed and total:

`NO_DATA` (empty bucket) > `DOWN` > `DEGRADED` > `MAINTENANCE` > `UP`

Three consequences are load-bearing:

1. **`UP` is the fallback, not a match.** It is returned only when every other
   count is zero. It is never possible to reach `UP` with a non-zero
   `countOfDown`.
2. **Maintenance never masks a problem.** `MAINTENANCE` sits *below* `DOWN` and
   `DEGRADED`, so a monitor that broke during its own maintenance window still
   reads as broken. It sits *above* `UP` so a window that passed cleanly still
   reads as maintenance rather than disappearing.
3. **An empty bucket is not healthy.** `total === 0` returns `NO_DATA` before
   any other test. Absence of evidence is reported as absence of evidence, which
   is why the check comes first rather than falling through to `UP`.

### Proportion decides wording, never the status

Counts *are* allowed to influence how the status is phrased, once the status
itself is settled. `GetStatusSummary` re-reads the same bucket only to pick
between a partial and a major label:

```ts
case GC.DOWN:
  return (item.countOfDown / total) * 100 >= 75
    ? PAGE_STATUS_MESSAGES.MAJOR_OUTAGE      // "Major System Outage"
    : PAGE_STATUS_MESSAGES.PARTIAL_OUTAGE;   // "Partial System Outage"
case GC.DEGRADED:
  return (item.countOfDegraded / total) * 100 >= 75
    ? PAGE_STATUS_MESSAGES.DEGRADED_PERFORMANCE
    : PAGE_STATUS_MESSAGES.PARTIAL_DEGRADED;
```

The 75% threshold is a wording threshold. Below it the outage is "partial", at
or above it "major". It **cannot** turn a `DOWN` bucket into an `UP` one. The
two-minute outage above is `DOWN` / "Partial System Outage", never
"All Systems Operational".

`MAINTENANCE` and `UP` have no proportional split; each has exactly one message.

### One collapse, reused everywhere

`CollapseStatusCounts` is the single definition, and `GetStatusSummary`,
`GetStatusColor` and `GetStatusBgColor` all switch on its result rather than
re-deriving one. Colour therefore cannot disagree with wording, and the tooltip
on a bar cannot disagree with the bar.

Despite living in `clientTools.ts`, it is already called from the server
(`monitorsController.ts`, `dashboardController.ts`,
`routes/(kener)/monitors/[monitor_tag]/+page.server.ts`) as well as from
components. It is shared logic that happens to be filed under a client-sounding
name.

## Consequences

- The page is **pessimistic by construction**. Operators cannot make an incident
  look smaller by waiting for healthy samples to accumulate; only ending the
  incident changes the status.
- Any new status type must be given an explicit position in the precedence
  chain. There is no default slot, and adding a `case` to `GetStatusSummary`
  without adding a line to `CollapseStatusCounts` yields a status that can never
  be produced.
- Bucket size changes what is reported. A wider bucket makes `DOWN` stickier,
  since one bad sample colours the whole bucket. That is intended; it is also
  why the bar's bucket boundaries matter (they are computed in the viewer's
  timezone, not UTC).
- Because proportion only picks wording, **the 75% constant is safe to tune**.
  Changing the precedence order is not: it changes what the page claims.

## Alternatives rejected

- **Majority wins.** Hides short outages entirely. Rejected: it inverts the
  page's purpose.
- **Weighted severity score.** More expressive, but it makes "why does it say
  that?" unanswerable without re-running the arithmetic, and it lets tuning
  silently downgrade a real outage.
- **Maintenance above DOWN.** Would let a scheduled window swallow a genuine
  failure that happened to overlap it. Rejected as actively misleading, and it
  is also why maintenance overlays are invisible to alert evaluation
  ([ADR 0005](0005-alerts-evaluate-alert-visible-samples.md)).
- **`UP` for an empty bucket.** Reports a monitor that stopped reporting as
  healthy, which is the exact failure a status page must not have.

## Note for the fork

This ADR is the **specification** for moving page-status derivation server-side.
Any server-side implementation must reproduce the precedence chain, the
`total === 0` short-circuit, and the wording-only role of the 75% threshold,
exactly. If a refactor changes any of those, it is a product decision and needs a
new ADR, not a silent rewrite.
