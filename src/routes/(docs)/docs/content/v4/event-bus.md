---
title: Event Bus
description: Control what each outbound channel is allowed to send, and rehearse a change before making it
---

Everything Kener sends out is driven by an internal event bus. A **consumer** turns those events into one kind of outbound message, and **Manage → Event Bus** decides what each consumer is allowed to do.

Changes take effect within ten seconds and need no restart, so a consumer that misbehaves can be pulled back immediately.

## Consumers {#consumers}

| Consumer        | What it does                                                                             |
| --------------- | ---------------------------------------------------------------------------------------- |
| `audit`         | Writes audit log entries, including for changes made through the API or by the scheduler |
| `webhook`       | Delivers [event webhooks](/docs/v4/event-webhooks) to your endpoints                     |
| `subscribers`   | Rehearses the emails sent to [status page subscribers](/docs/v4/subscriptions)           |
| `triggers`      | Rehearses the notifications sent to your [alerting triggers](/docs/v4/alerting)          |
| `email`         | Records subscriber emails on the delivery log and makes a failed one retryable           |
| `alert_trigger` | Records alert trigger sends on the delivery log so a failed one is visible               |

## Modes {#modes}

| Mode     | Sends? | Records                                                           |
| -------- | ------ | ----------------------------------------------------------------- |
| `off`    | No     | Nothing                                                           |
| `legacy` | No     | Who would have been notified                                      |
| `shadow` | No     | Who would have been notified, and the full message they would get |
| `live`   | Yes    | The delivery and its outcome                                      |

`off` and `legacy` differ in what they leave behind: `off` tells you nothing, `legacy` tells you what the consumer would have selected while risking nothing.

> [!NOTE]
> `subscribers` and `triggers` ship in `shadow` and cannot be set `live` from this screen. Their existing send paths are still running, so turning them live here would send every notification twice.

## Shadow diff {#shadow-diff}

While a consumer is in `shadow`, the **Shadow diff** panel compares what it would have sent against what was actually sent.

| Verdict          | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `MATCH`          | The rehearsal and the real send agree                                        |
| `PRESENCE_ONLY`  | Both reached the same recipient; the existing path stores no body to compare |
| `MISSING_LIVE`   | The rehearsal would have notified someone the existing path did not          |
| `BODY_DIFFERS`   | Both reached the same recipient, but the message differs                     |
| `SHADOW_ERROR`   | The rehearsal could not work out what to send                                |
| `MISSING_SHADOW` | The existing path notified someone the rehearsal would have missed           |

> [!IMPORTANT]
> `MISSING_SHADOW` is the one verdict that means a message would be lost. Treat any occurrence as a blocker.

Use **Only show findings that would block a move** to filter to `MISSING_SHADOW`, `SHADOW_ERROR` and `BODY_DIFFERS`. The counts cover the current page of events, not the whole history.

## Verify {#verify}

1. Post a comment on an incident, or let an alert fire.
2. Open **Manage → Event Bus** and refresh the shadow diff.
3. A row appears for each recipient. Select **Compare** to see both messages side by side.

If nothing appears, check **Manage → Delivery Log** for the event; see [Retries](/docs/v4/event-webhooks#retries).

## Permissions {#permissions}

| Permission       | Grants                                  |
| ---------------- | --------------------------------------- |
| `eventbus.read`  | Opening the screen and reading the diff |
| `eventbus.write` | Changing a consumer's mode              |

## Troubleshooting {#troubleshooting}

**A mode change did not take effect.** Modes are cached for ten seconds in each process. Wait, then refresh.

**A consumer shows a mode you did not set.** It has no stored setting and is using its built-in default. Saving any mode stores it.

**The diff is empty.** Nothing has happened yet that this consumer handles. `subscribers` reacts to incident comments and maintenance changes; `triggers` reacts to alerts firing and resolving.

**Trigger bodies show `$env.NAME` unsubstituted.** Deliberate. Environment secrets are never rendered into the delivery log.
