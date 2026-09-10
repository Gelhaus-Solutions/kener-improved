---
title: Live Updates
description: Keep public status pages current without a reload, and size the connection cap for your deployment
---

Public status pages update themselves when a monitor or a page changes status, using [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events). No configuration is required: it is on by default and needs only the Redis you already run.

## How it works {#how-it-works}

1. A check records a status **change** (not every sample).
2. The change is published to Redis.
3. Every browser with that page open receives it on an open stream and updates the affected component and the overall status headline.

Only transitions are sent. A page checking hundreds of monitors a minute is silent while nothing changes.

## Requirements {#requirements}

- **Redis** must be reachable by the web process. See [Redis Setup](/docs/v4/setup/redis-setup).
- Your reverse proxy must not buffer responses. Kener sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`, which nginx and most proxies honour. See [Reverse Proxy](/docs/v4/guides/reverse-proxy).

## Capacity {#capacity}

> [!IMPORTANT]
> Live updates hold **one open connection per viewer** for as long as that page stays open. This caps concurrent viewers far below a stateless page, so size it for your deployment.

| Variable                    | Default | Purpose                                                |
| --------------------------- | ------- | ------------------------------------------------------ |
| `KENER_SSE_MAX_CONNECTIONS` | `1000`  | Maximum simultaneous live connections per web process. |

Set it to `0` to turn live updates off entirely.

Beyond the cap, new viewers are told to retry later and their page simply stops updating on its own. Nothing breaks: the page still renders and is accurate at load.

A single-VPS Compose deployment is comfortable with the default. Raise it only alongside the file-descriptor limit of the container.

## Verify {#verify}

1. Open a public status page.
2. In your browser's network tab, find the request to `/live` and confirm it stays open with type `eventstream`.
3. Force a monitor to fail and watch the component and the header change without a reload.

## Troubleshooting {#troubleshooting}

**The `/live` request completes immediately instead of staying open.**
A proxy is buffering it. Confirm your proxy passes `X-Accel-Buffering` through and does not gzip `text/event-stream`.

**The page never updates, but everything else works.**
Check that the web process can reach Redis. With Redis unavailable the stream still opens and simply delivers nothing, which looks identical to a quiet page.

**Updates stop after a while on one tab.**
Kener sends a keep-alive every 25 seconds, which is under the usual 30- and 60-second proxy idle timeouts. If your proxy uses a shorter one, raise it.

> [!NOTE]
> Behind more than one web process, a browser that reconnects to a different process is not replayed the handful of changes it missed; it stays accurate from the next change onward. Reconnects to the same process are replayed in full.
