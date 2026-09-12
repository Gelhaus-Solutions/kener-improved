---
title: "Inbound Alerts"
description: "Let alerting you already run open and close incidents in Kener"
---

An inbound endpoint gives your existing alerting a URL to post to. Kener maps each alert to a component and opens an incident, and closes it again when the alert clears. Repeated notifications about one alert update that incident rather than opening another.

This is the opposite direction to [Event Webhooks](/docs/v4/event-webhooks), which send Kener's events out.

## Set one up {#setup}

1. Go to **Operate → Inbound Alerts** and create an endpoint. Pick the provider that will post to it.
2. Copy the URL. It contains the token, is shown once, and cannot be recovered. Use the key button to issue a new one.
3. Paste it into your alerting tool as a webhook receiver.
4. Add mapping rules so alerts reach the right component.

## Providers {#providers}

| Provider | Payload |
| --- | --- |
| `ALERTMANAGER` | Prometheus Alertmanager's webhook |
| `GRAFANA` | Grafana unified alerting, which uses the same contract |
| `SENTRY` | Both the integration-platform and legacy plugin shapes |
| `CLOUDWATCH` | An SNS notification, or a raw-delivery alarm |
| `UPTIME_KUMA` | Uptime Kuma's webhook |
| `GENERIC` | The documented shape below |

Datadog, Zabbix and Checkmk each compose their payload from a template you write, so there is no fixed shape to parse. Use `GENERIC` and make the template match.

### The generic shape {#generic-shape}

```json
{
  "id": "db-cpu-high",
  "title": "Database CPU high",
  "status": "firing",
  "severity": "warning",
  "description": "CPU above 90% for 5 minutes",
  "labels": { "service": "db" }
}
```

`id` is the deduplication key: send the same one for as long as the problem persists. `status` accepts `resolved`, `recovered`, `ok`, `up`, `cleared` and `closed` as cleared; anything else is treated as firing.

## Mapping alerts to components {#mapping}

A rule matches one label against one value and names the component. The first matching rule wins, so order them from most specific to least.

An alert matching no rule falls back to the endpoint's default component. With no default it is recorded and opens nothing, which the endpoint's list shows as **no component**.

> [!TIP]
> If alerts arrive but no incident appears, the endpoint is almost always matching nothing. The alert list shows which component each one landed on.

## Deduplication {#deduplication}

Each alert carries a fingerprint: Alertmanager's own where it sends one, otherwise one derived from the fields that identify the alert. Kener keeps one record per fingerprint per endpoint.

- The first firing notification opens an incident.
- Later firing notifications update the record and change nothing else.
- A resolved notification closes the incident, if **auto-resolve** is on.
- An alert that resolves and fires again opens a new incident, because it is a new outage.

## Planned maintenance {#maintenance}

An alert whose component is inside an open maintenance window is recorded but opens no incident, and the response counts it under `suppressed`. This matches what Kener's own alerting already does, so planned work does not announce itself as an outage.

Suppression is not amnesia: if the alert is still firing when the window closes, the next notification opens an incident normally. A resolved notification still closes an incident that was already open before the window started.

> [!NOTE]
> Only components attached to the maintenance are suppressed. A dependent service that fails *because* of the work still alerts.

## Signing {#signing}

Set a signing secret on the endpoint and Kener will verify every request, refusing any that is unsigned or wrongly signed. The signature is a hex HMAC-SHA256 of the raw body.

| Provider | Header |
| --- | --- |
| `SENTRY` | `sentry-hook-signature` |
| Everything else | `x-kener-signature` |

> [!IMPORTANT]
> A token in a URL leaks through proxy logs, browser history and screenshots. Signing means a leaked URL alone is not enough to post incidents to your status page.

## Limits {#limits}

- 120 requests per minute per endpoint. Past that Kener answers `429` with `Retry-After`.
- Bodies above 1 MB are refused with `413`.

## Responses {#responses}

A successful request returns what it changed:

```json
{ "accepted": 1, "opened": 1, "resolved": 0, "unmapped": 0, "suppressed": 0 }
```

| Code | Meaning |
| --- | --- |
| `200` | Accepted. Read the counts to see what happened. |
| `400` | The body was not valid JSON. |
| `401` | Unknown token, or a missing or invalid signature. |
| `403` | The endpoint is disabled. |
| `413` | The body was too large. |
| `429` | Rate limited. |
| `500` | Kener failed. Retry. |

## Troubleshooting {#troubleshooting}

**Nothing arrives.** The endpoint list shows when it was last called. "never called" means the request is not reaching Kener at all, so check the URL and that the sender can reach your host.

**Alerts arrive but no incidents.** Look for **no component** in the alert list, then add a mapping rule or a default component.

**Incidents open but never close.** Turn on auto-resolve, and check the sender actually emits a resolved notification.

**Duplicate incidents.** Your sender is changing its fingerprint between notifications. With `GENERIC`, send a stable `id`.

**Alerts arrive but are counted as `suppressed`.** The component is in an open maintenance window. That is deliberate; see [Planned maintenance](#maintenance).
