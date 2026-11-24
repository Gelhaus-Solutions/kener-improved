---
title: Standby Instance
description: Run a second, read-only Kener elsewhere that keeps the status page up when the primary is down
---

A standby serves the public status page from data it pulls from the primary every minute. It runs no monitor checks, schedulers or probe listener, sends no notifications or emails, and refuses every write: the admin, sign-in, heartbeat pings, inbound alerts and API writes answer `503`.

Send traffic to the standby only while the primary is down, from your DNS or load balancer, using the [health endpoint](#health).

## Setup {#setup}

1. Pick a long random token, for example `openssl rand -hex 32`.
2. On the primary, set `KENER_STANDBY_TOKEN` to it and restart. This turns on `GET /ext/standby/export`.
3. Start the standby on another host with the same Kener release, its own database (SQLite is enough) and its own Redis:

```bash
KENER_ROLE=standby
KENER_STANDBY_PRIMARY_URL=https://status.example.com
KENER_STANDBY_TOKEN=<the same token>
KENER_SECRET_KEY=<any secret>
ORIGIN=https://status.example.com
REDIS_URL=redis://localhost:6379
DATABASE_URL=sqlite://./database/kener.sqlite.db
```

The first pull copies 90 days of history and can take a few minutes; later pulls send only what changed.

> [!IMPORTANT]
> Run the same release on both. A standby on a different schema refuses the data and its page goes stale.

## Variables {#variables}

| Variable                      | Where   | Purpose                                                                     | Default   |
| ----------------------------- | ------- | --------------------------------------------------------------------------- | --------- |
| `KENER_ROLE`                  | standby | `primary` or `standby`; anything else stops Kener at start                  | `primary` |
| `KENER_STANDBY_TOKEN`         | both    | Shared token. On the primary it enables the export; the standby presents it | unset     |
| `KENER_STANDBY_PRIMARY_URL`   | standby | The primary's public URL, base path included                                | unset     |
| `KENER_STANDBY_STALE_SECONDS` | standby | How old the last good pull may be before the page stops showing a status    | `300`     |

## When the data is stale {#stale}

Once the last good pull is older than `KENER_STANDBY_STALE_SECONDS`, the page shows a banner with the time of its data and every component's current status reads **No Data**. History bars, incidents and maintenances stay as last pulled.

## Health {#health}

`GET /healthcheck/instance` returns the role and, on a standby, the last good pull and the data age. With `?strict=1` a stale standby answers `503`.

```json
{
    "role": "standby",
    "ok": true,
    "lastPullAt": 1795555200,
    "dataAt": 1795555199,
    "dataAgeSeconds": 31,
    "staleAfterSeconds": 300,
    "stale": false,
    "lastAttemptAt": 1795555200,
    "lastAttemptFailed": false
}
```

## What is mirrored {#mirrored}

Site settings, pages and their domains, monitors and groups, dependencies and published SLOs, incidents and maintenances from the last 90 days plus open and upcoming ones, the uptime rollups behind the bars, and the last day of raw samples. Monitor check settings, users, API keys, subscribers, alerting and instance settings stay on the primary.

## Troubleshooting {#troubleshooting}

- **Banner never goes away**: check the standby's log for `Standby: pull from the primary failed`. A `401` means the tokens differ; `schema differs` means the releases differ.
- **`404` from the export**: `KENER_STANDBY_TOKEN` is not set on the primary, or the request reached a standby.
