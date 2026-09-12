---
title: Event Webhooks
description: Receive signed HTTP callbacks when incidents, maintenances and monitors change
---

Event webhooks POST a signed JSON payload to your URL whenever something happens on your status page: an incident is opened, updated or resolved, a maintenance starts, a monitor flips.

This is different from [alerting triggers](/docs/v4/alerting), which fire only on monitor status changes and send a template you write. Event webhooks cover the full incident and maintenance lifecycle, use a fixed versioned payload, and are retried.

## Create an endpoint {#create-an-endpoint}

1. Go to **Manage → Webhooks** and select **Add endpoint**.
2. Enter a **name** and the **HTTPS URL** that will receive events.
3. Choose the **event types** to subscribe to.
4. Choose a **format**: Generic JSON, or Discord if the URL is a Discord webhook.
5. Save. **The signing secret is shown once and never again**, so copy it now.

If you lose the secret, rotate it (see [Rotating the secret](#rotating-the-secret)) rather than recreating the endpoint.

## Event types {#event-types}

Subscribe to exact types, or to a whole domain with a wildcard such as `incident.*`.

| Domain        | Types                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incident`    | `created`, `updated`, `state_changed`, `severity_changed`, `component_impact_changed`, `comment_added`, `comment_updated`, `comment_hidden`, `resolved`, `reopened`, `deleted`, `backfilled` |
| `maintenance` | `scheduled`, `reminder`, `started`, `completed`, `cancelled`, `updated`, `deleted`                                                                                                           |
| `monitor`     | `status_changed`, `alert_triggered`, `alert_resolved`, `created`, `updated`, `deleted`, `paused`, `resumed`                                                                                  |
| `postmortem`  | `drafted`, `updated`, `published`, `unpublished`                                                                                                                                             |

`incident.resolved` fires alongside `incident.state_changed`. Subscribe to whichever suits you; subscribing to both delivers two events.

> [!NOTE]
> Administrative events (user, API key, role and settings changes) are recorded in the audit log and are never deliverable to a webhook.

## Discord {#discord}

A Discord webhook URL will not accept Kener's own payload: it requires a body of its own shape. Set the endpoint's **format** to Discord and Kener sends what Discord expects. Without it every delivery fails and the endpoint disables itself after 20 consecutive failures.

The delivery is still signed. Discord ignores the signature header, and leaving it on means changing an endpoint's format never quietly changes whether it is signed.

### The message {#discord-message}

The **Message** field is the line posted to the channel. The event detail is added underneath it as an embed automatically, so the message is only what you want said and who you want told. Leave it empty to post the event name alone.

```
<@&123456789012345678> {{type}}: {{object.title}}
```

| Variable                 | Is                                                    |
| ------------------------ | ----------------------------------------------------- |
| `{{type}}`               | The event type, such as `incident.created`            |
| `{{object.title}}`       | The incident or maintenance title                     |
| `{{object.status}}`      | `UP`, `DOWN`, `DEGRADED`, where the event carries one |
| `{{object.severity}}`    | The incident severity                                 |
| `{{object.monitor_tag}}` | The monitor, where the event is about one             |
| `{{site_name}}`          | Your status page's name                               |

A variable the event does not carry renders as nothing rather than the word `undefined`.

### Mentions {#discord-mentions}

Mention a role with `<@&ROLE_ID>` and a person with `<@USER_ID>`. In Discord, right-click the role or user and **Copy ID** (Developer Mode must be on).

> [!IMPORTANT]
> **Only mentions written in the Message field can notify anyone.** A mention that arrives through a variable is displayed but never pings. This is deliberate: an incident title is text somebody typed, and without this rule anyone who can open an incident could put `@everyone` in its title and notify your whole server from your status page.
>
> `@everyone` and `@here` work only when the Message field itself contains them.

## Payload {#payload}

```json
{
    "id": "01JQ8ZK5T3V9WXYZ0ABCDEFGHJ",
    "type": "incident.resolved",
    "api_version": "2026-09-08",
    "occurred_at": 1788861599,
    "seq": 4821,
    "data": {
        "object": { "id": 42, "title": "Checkout is failing", "state": "RESOLVED" },
        "previous": { "state": "MONITORING" }
    },
    "diff": { "before": { "state": "MONITORING" }, "after": { "state": "RESOLVED" } }
}
```

| Field         | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `id`          | Unique event id. Use it to discard duplicates.                                               |
| `seq`         | Total ordering across your instance. Events can arrive out of order; sort by this.           |
| `occurred_at` | UTC seconds when the change happened.                                                        |
| `data.object` | Current state of the object. On a retry this reflects the object **now**, not when it fired. |
| `diff`        | Only the fields the event changed.                                                           |

These headers accompany every request: `Kener-Signature`, `Kener-Event-Id`, `Kener-Event-Type`, `Kener-Delivery-Seq`.

## Verify the signature {#verify-the-signature}

The `Kener-Signature` header looks like `t=1788861599,v1=5f3a…`, where `v1` is `HMAC_SHA256(secret, "<t>.<raw body>")`.

Verify against the **raw request body**, before any JSON parsing — re-serializing changes the bytes and the signature will not match.

**Node.js (Express):**

```js
import crypto from "node:crypto"
import express from "express"

const app = express()
const SECRET = process.env.KENER_WEBHOOK_SECRET

app.post("/hook", express.raw({ type: "application/json" }), (req, res) => {
    const header = req.get("Kener-Signature") ?? ""
    const timestamp = header.match(/t=(\d+)/)?.[1]
    const signatures = [...header.matchAll(/v1=([0-9a-f]{64})/g)].map((m) => m[1])
    if (!timestamp || signatures.length === 0) return res.sendStatus(400)

    // Reject anything older than 5 minutes, so a captured request cannot be replayed.
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return res.sendStatus(400)

    const expected = crypto.createHmac("sha256", SECRET).update(`${timestamp}.${req.body}`).digest("hex")

    // During a rotation Kener sends several v1 signatures; any match is valid.
    const valid = signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    if (!valid) return res.sendStatus(401)

    const event = JSON.parse(req.body.toString("utf8"))
    console.log(event.type, event.id)
    res.sendStatus(200)
})

app.listen(3000)
```

**Python (Flask):**

```python
import hashlib, hmac, os, re, time
from flask import Flask, request

app = Flask(__name__)
SECRET = os.environ["KENER_WEBHOOK_SECRET"].encode()

@app.post("/hook")
def hook():
    header = request.headers.get("Kener-Signature", "")
    match = re.search(r"t=(\d+)", header)
    signatures = re.findall(r"v1=([0-9a-f]{64})", header)
    if not match or not signatures:
        return "", 400

    timestamp = match.group(1)
    # Reject anything older than 5 minutes, so a captured request cannot be replayed.
    if abs(int(time.time()) - int(timestamp)) > 300:
        return "", 400

    body = request.get_data()
    expected = hmac.new(SECRET, f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()

    # During a rotation Kener sends several v1 signatures; any match is valid.
    if not any(hmac.compare_digest(sig, expected) for sig in signatures):
        return "", 401

    event = request.get_json()
    print(event["type"], event["id"])
    return "", 200
```

## Retries {#retries}

Respond `2xx` within the endpoint timeout (10s by default). Anything else is a failure.

- Retries follow 10s → 1m → 5m → 30m → 2h → 6h, with jitter. Seven attempts over roughly nine hours.
- A `4xx` other than `408` and `429` is treated as permanent and not retried.
- Exhausted deliveries are marked `DEAD` and can be retried by hand from **Manage → Delivery Log**, which also shows what was sent and what came back.

Deliver idempotently: use `id` to discard a duplicate, since a delivery can arrive twice after a crash.

> [!IMPORTANT]
> After 20 consecutive failures an endpoint is disabled automatically and shown as `DISABLED_AUTO`. Fix the receiver, then set it back to active — this also resets the failure count.

## Rotating the secret {#rotating-the-secret}

Select **Rotate secret** on the endpoint. The new secret is shown once.

For 24 hours Kener signs every request with **both** the new and the previous secret, sending two `v1` values. Update your receiver at any point in that window; the snippets above already accept either. After 24 hours only the new secret is used.

## Private and internal endpoints {#private-endpoints}

Kener resolves each endpoint's hostname and refuses to send to loopback, link-local (including cloud metadata addresses) or private ranges. This prevents a webhook URL from being used to reach services inside your network.

To deliver to an internal receiver, set:

```bash
KENER_ALLOW_PRIVATE_WEBHOOKS=true
```

See [environment variables](/docs/v4/setup/environment-variables).

## Troubleshooting {#troubleshooting}

- **Discord returns 400 on every delivery**: the endpoint's format is still Generic JSON. Change it to Discord.
- **The mention shows in the message but nobody is notified**: the mention arrived through a variable rather than being written in the Message field. Put the `<@&ROLE_ID>` in the Message field itself.

| Symptom                                  | Cause                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Signature never matches                  | The body was parsed and re-serialized. Sign the raw bytes.                                                                   |
| Nothing is delivered                     | The event type is not subscribed. A misspelled wildcard is rejected at save time.                                            |
| `URL resolves to a private address`      | The receiver is on a private range; set `KENER_ALLOW_PRIVATE_WEBHOOKS=true`.                                                 |
| Endpoint became `DISABLED_AUTO`          | 20 consecutive failures. Fix the receiver and re-enable it, then use **Retry all dead for this target** on the delivery log. |
| `Endpoint secret could not be decrypted` | `KENER_SECRET_KEY` changed. Rotate the endpoint's secret to set a new one.                                                   |

> [!WARNING]
> Webhook secrets are encrypted with a key derived from `KENER_SECRET_KEY`. Changing that variable makes existing secrets unreadable — as it already does for every API key hash.
