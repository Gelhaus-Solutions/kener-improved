# Kener remote probe

A small daemon that runs Kener's checks from somewhere other than the Kener
server and reports the results back over a WebSocket.

It holds no database, no Redis and none of Kener's environment. Everything a
check needs arrives in the assignment, with `$SECRET` tokens already resolved by
the server. It connects outwards, so it works behind NAT with no inbound
firewall rule.

## What it can check

`API`, `PING`, `TCP`, `DNS` and `SSL`.

The rest of Kener's monitor types need something only the server has: `GROUP`
reads Redis for its members' statuses, `HEARTBEAT` reads the database,
`SQL` needs a connection Kener holds, and `PROMETHEUS` and `DOCKER` need
server-side reachability. The probes screen only offers monitors it can actually
run.

## Setting one up

1. In Kener, go to **Operate → Probes** and create an agent. Pick its region:
    - **Merged verdict**: this agent runs the local check remotely. Kener stops
      checking these monitors from its own server and this agent's answer takes
      local's place.
    - **Any other region**: this agent observes as its own region, alongside the
      local check.

    Kener publishes one status per monitor per minute. When more than one source
    reports, the **merge policy** decides what that status is: a weighted
    majority, a trust order where the most trusted source that answered wins, or
    a quorum that will not call something down until enough sources agree. Set it
    on the same screen, per region and per monitor. Trust order is the one for a
    provider that blocks datacenter ranges: rank the probe above the local check
    and the local 403 stops deciding.

2. Copy the token. It is shown once and cannot be recovered; if it is lost,
   issue a new one with the key button.

3. Make sure the Kener instance has a listener. `KENER_PROBE_WS_PORT` must be
   set on the process that runs the schedulers, and the port reachable from
   wherever the probe runs. With it unset there is no listener at all and no
   agent can connect.

4. Run the probe.

## Running it

```bash
docker run -d --name kener-probe-frankfurt \
  -e KENER_PROBE_URL=ws://kener.example.com:3390 \
  -e KENER_PROBE_TOKEN=kener_probe_... \
  ghcr.io/gelhaus-solutions/kener-probe:latest
```

The image is versioned on its own tag line, not Kener's. What has to agree
between a probe and a server is the wire protocol, which is versioned in the
messages themselves, so a probe works against any Kener that speaks the same
protocol version and does not need to be upgraded alongside it.

To build it yourself, from the repository root:

```bash
docker build -f probe/Dockerfile -t kener-probe .
```

Or without Docker, from a checkout:

```bash
node probe/build.js
KENER_PROBE_URL=ws://localhost:3390 KENER_PROBE_TOKEN=kener_probe_... node probe/dist/probe.js
```

| Variable              | Required | Meaning                                                                          |
| --------------------- | -------- | -------------------------------------------------------------------------------- |
| `KENER_PROBE_URL`     | yes      | WebSocket address of the Kener scheduler process                                 |
| `KENER_PROBE_TOKEN`   | yes      | The token shown once when the agent was created                                  |
| `KENER_PROBE_VERSION` | no       | Reported to Kener and shown on the probes screen                                 |
| `KENER_PROBE_DEBUG`   | no       | `1` logs every check it runs. Useful for the first ten minutes, noisy after that |

## What happens when it goes away

Nothing stops being monitored. Kener notices after three missed heartbeats
(90 seconds), drops the agent, and checks its monitors locally again from the
next tick. A probe that disconnects cleanly is dropped at once. This is the
point: for a status page, the safest thing to do when a probe is unreliable is
to check the thing yourself.

An agent whose token is refused exits non-zero rather than retrying, because
every retry would fail identically. Anything else, such as a restarting server
or a network blip, is retried with backoff up to 30 seconds.

## Security

The probe is sent monitor configuration with secrets already substituted in, so
it sees the credentials of the monitors assigned to it. It never sees Kener's
environment, and it can only ever report results for checks the server asked it
to run. Give an agent only the monitors it needs.
