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

## Releasing a new image

Push a tag; the workflow does the rest, including bumping `probe/package.json`
to match and committing that back to the default branch.

```bash
git tag probe-v1.0.1 && git push origin probe-v1.0.1
```

The version is baked into the bundle at build time, so the version the probes
screen reports is always the version of the image that is running. You do not
need to bump the file by hand first.

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

2. Put more than one agent in a region if you want that vantage point to keep
   reporting when a machine goes down. Every agent in the region runs every
   check, and their answers are reduced to the one answer that region gives
   before anything else sees them, using that region's own merge policy. So a
   region's say in the final status does not grow because you deployed a second
   box there: two agents in Frankfurt are two machines answering "what does
   Frankfurt see", not two votes.

    By default they count equally. If one of them should settle a disagreement,
    give it a higher **weight** on the agent: a weight of 2 against two agents at
    1 means it decides, and a weight of 0 records an agent's result without
    letting it vote. Weight applies only among the agents of one region, so
    raising it still cannot buy that region more say over the others.

    Weight is read by the `weighted majority` policy only, exactly as the
    per-region weights are. Under `trust order` the first agent listed decides,
    and under `quorum down` it is a headcount, so in both cases the number is
    ignored.

3. Copy the token. It is shown once and cannot be recovered; if it is lost,
   issue a new one with the key button.

4. Make sure the Kener instance has a listener. `KENER_PROBE_WS_PORT` must be
   set on the process that runs the schedulers, and the port reachable from
   wherever the probe runs. With it unset there is no listener at all and no
   agent can connect.

5. Run the probe.

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

| Variable              | Required | Meaning                                                                                                          |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `KENER_PROBE_URL`     | yes      | WebSocket address of the Kener scheduler process                                                                 |
| `KENER_PROBE_TOKEN`   | yes      | The token shown once when the agent was created. A comma-separated list runs one probe for several organisations |
| `KENER_PROBE_VERSION` | no       | Reported to Kener and shown on the probes screen                                                                 |
| `KENER_PROBE_DEBUG`   | no       | `1` logs every check it runs. Useful for the first ten minutes, noisy after that                                 |

## One probe, several organisations

A probe agent belongs to one organisation, so monitoring several tenants used to
mean running a container each. Give `KENER_PROBE_TOKEN` a comma-separated list
instead and the probe opens one session per token against the same Kener:

```bash
docker run -d --name kener-probe-frankfurt \
  -e KENER_PROBE_URL=ws://kener.example.com:3390 \
  -e KENER_PROBE_TOKEN=kener_probe_aaa...,kener_probe_bbb... \
  ghcr.io/gelhaus-solutions/kener-probe:latest
```

Each session authenticates as that organisation's own agent, is handed only that
organisation's monitors, and reports only to it. Kener needs no configuration for
this and cannot tell the difference from several separate containers.

**Still one upstream.** `KENER_PROBE_URL` is singular and stays that way: a probe
answering to two Kener servers would have two sources of truth about what it
should be checking.

Every log line is prefixed with the session it belongs to, as the token's last
four characters until it connects and as `agent <id>` afterwards.

**One bad token does not stop the others.** A token Kener refuses takes down its
own session and is not retried, because every retry would fail identically. The
container exits non-zero only when _every_ token has been refused, so a wholly
broken configuration still fails fast instead of idling.

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
