---
title: Heartbeat Monitor
description: Push health signals from jobs, workers, and external systems
---

Heartbeat monitors are push-based: your job calls a URL, and Kener decides whether it arrived when it should have.

There are two ways to judge that. A **silence timeout** suits a job that runs on a short loop. An **expected schedule** suits a job that runs at a fixed time, and alerts as soon as it is late instead of waiting out a whole timeout.

## Heartbeat endpoint {#heartbeat-endpoint}

URL format:

```
/ext/heartbeat/{tag}/{secret}
```

Accepted methods: `GET` and `POST`.

> Older heartbeat URLs used a colon — `/ext/heartbeat/{tag}:{secret}`. Those still work; they are rewritten to the path-separated form automatically, so existing cron jobs need no changes.

<<<<<<< HEAD
## Silence timeout {#minimum-setup}
=======
## Heartbeat secret {#heartbeat-secret}

The `{secret}` part of the URL is the heartbeat secret. The monitor tag is public, so the secret is what stops others from sending fake heartbeats. Kener stores it in `type_data.secretString`.

Rule: at least 12 characters, using only `A-Z a-z 0-9 . _ ~ -`. A secret that follows the rule goes into the URL without encoding.

- **Admin UI**: type a value in **Heartbeat secret**, or click **New URL** for a random one.
- **API**: set `type_data.secretString` on `POST /api/v4/monitors` or `PATCH /api/v4/monitors/{tag}`. A new or changed value that breaks the rule returns HTTP `400` with code `BAD_REQUEST`, and the message starts with `Heartbeat secret breaks the rule`. See the [API Reference](/docs/spec/v4/).
- **Not set**: when a `HEARTBEAT` monitor is saved without `secretString`, Kener generates one, for example `focused-galois-sharp-chaum`. The `POST`/`PATCH` response includes it.
- **Clone**: a cloned heartbeat monitor gets a new secret. Give the sender the clone's URL.

> [!TIP]
> For infrastructure as code, set `secretString` yourself when you create the monitor. Then the sender (a cron job, a Prometheus Alertmanager rule) can be configured with the URL before the monitor exists.

Kener checks the rule only for a new or changed `secretString`. A secret stored before the rule keeps working, and a save that sends it back unchanged succeeds.

## Minimum setup {#minimum-setup}
>>>>>>> 68a6ea236ced714b081f0cac7f1d86383f3ef427

The default mode. Set:

- `degradedRemainingMinutes` (default `5`)
- `downRemainingMinutes` (default `10`)

`downRemainingMinutes` must be greater than `degradedRemainingMinutes`.

## Expected schedule {#expected-schedule}

Set `expectedCron` to switch the monitor into schedule mode.

| Option         | Default | Meaning                                                                        |
| -------------- | ------- | ------------------------------------------------------------------------------ |
| `expectedCron` | none    | Five-field cron the job is expected to keep. Empty means silence-timeout mode. |
| `cronTimezone` | `UTC`   | IANA zone the schedule is read in, including across DST.                       |
| `graceMinutes` | `15`    | How long after the expected time the run may still arrive.                     |

A daily 02:00 job with 15 minutes of grace is flagged at 02:15, not after a timeout has quietly elapsed.

> [!NOTE]
> If `expectedCron` cannot be parsed, the monitor falls back to the silence timeout and logs the reason. A typo cannot take a monitor down.

## Reporting an outcome {#reporting-outcome}

By default a ping means only "I am alive", so a job that runs punctually and fails every time still looks healthy. Report the outcome to fix that.

Pass either as query parameters or in a JSON body:

| Field         | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `exit_code`   | `0` succeeded, anything else failed. A failed run is **DOWN** immediately, without waiting for a missed window. |
| `status`      | `fail` or `ok`, for scripts that have no exit code to hand.                                                     |
| `duration_ms` | How long the run took. Recorded as the monitor's latency.                                                       |
| `duration`    | The same in seconds, which is what `time` and most CI variables report.                                         |

A value that does not parse is ignored rather than rejected: the heartbeat still counts.

## Status logic {#status-logic}

If no heartbeat has ever been received, status is **NO_DATA**.

Otherwise, in order:

1. Last run reported a non-zero `exit_code` → **DOWN**
2. With `expectedCron` set:
    - the run for the current window arrived, or grace has not run out → **UP**
    - one window missed past grace → **DEGRADED** (late)
    - two or more consecutive windows missed → **DOWN** (not running)
3. Without `expectedCron`, let `diff` = elapsed time since last heartbeat:
    - `diff > downRemainingMinutes` → **DOWN**
    - `diff > degradedRemainingMinutes` → **DEGRADED**
    - otherwise → **UP**

Latency is the reported `duration_ms` when the job sent one, and otherwise the elapsed time since the last heartbeat (ms).

## Example {#example}

<<<<<<< HEAD
A job on a short loop, judged by silence:
=======
Request body for `POST /api/v4/monitors`:
>>>>>>> 68a6ea236ced714b081f0cac7f1d86383f3ef427

```json
{
    "tag": "my-job",
    "name": "My job",
    "monitor_type": "HEARTBEAT",
    "type_data": {
        "degradedRemainingMinutes": 5,
        "downRemainingMinutes": 10,
        "secretString": "my-job-hb-secret-01"
    }
}
```

```bash
*/5 * * * * /path/to/job.sh && curl -s "https://your-kener-host/ext/heartbeat/my-job/my-job-hb-secret-01"
```

A nightly backup, judged by schedule, reporting whether it worked and how long it took:

```json
{
    "type": "HEARTBEAT",
    "type_data": {
        "expectedCron": "0 2 * * *",
        "cronTimezone": "Europe/Berlin",
        "graceMinutes": 15
    }
}
```

```bash
0 2 * * * start=$(date +%s); /path/to/backup.sh; code=$?; \
  curl -s "https://your-kener-host/ext/heartbeat/nightly-backup/my-secret?exit_code=$code&duration=$(( $(date +%s) - start ))"
```

Note that the `curl` runs whether or not the job succeeded, so a failure is reported rather than left to silence.

## Troubleshooting {#troubleshooting}

- **Always NO_DATA**: endpoint never called or wrong `tag`/`secret`
- **`Invalid heartbeat secret`**: the URL secret does not match `secretString`. Copy the URL again from the monitor page, or from the API response.
- **Always DOWN/DEGRADED**: thresholds too low for actual job interval
- **Signal accepted but stale**: ensure heartbeat is sent only after successful completion
- **Schedule seems ignored**: check the editor's next expected runs preview. An unparseable `expectedCron` falls back to the silence timeout
- **Flagged late every time**: the job starts on time but finishes later than `graceMinutes`. Either raise the grace period or ping at the start of the run as well as the end
- **Wrong time of day**: set `cronTimezone`. The schedule defaults to UTC, not the server's local zone
