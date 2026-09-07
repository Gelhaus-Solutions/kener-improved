# ADR 0002: Address by id, never by concatenating an id onto a path

- **Status:** Accepted. Describes current behaviour.
- **Origin:** Upstream decision, **reconstructed by this fork** from the code that cites it. See [README](README.md).
- **Cited from:** `src/lib/types/api.ts` (`MaintenanceResponse.url`)

> The citation in `src/` is the bare string `docs/adr/0002`, with no slug. The
> filename here was chosen by the fork; the number is upstream's.

## Context

A REST response carries an `id`. The obvious way for a client to build a link is
to append it to the public path: `` `${siteUrl}/maintenances/${id}` ``.

For maintenances that produces a URL that resolves, and resolves to the **wrong
record**. The public route is keyed by maintenance *event* id by default, while
the API resource is a *maintenance*. Two different id spaces, one path shape:

```ts
// src/routes/(kener)/maintenances/[maintenance_id]/+page.server.ts
let idType = "event";
if (url.searchParams.get("type") === "maintenance") {
  idType = "maintenance";
}
```

A maintenance has many events. Without `?type=maintenance` the route reads the
number as an event id, so `/maintenances/7` and the API's maintenance `7` are
only the same thing by coincidence. The failure is silent: a valid page for
someone else's maintenance window, or a 404 that looks like deleted data.

## Decision

**Responses carry the resolved absolute URL as a field. Clients follow that
field. Nobody builds a public URL by string-concatenating an id onto a path.**

The three v4 maintenance endpoints all construct it server-side, in one shape:

```ts
url: siteUrl + serverResolver(`/maintenances/${maintenance.id}?type=maintenance`);
```

`serverResolver` applies the base path, and `?type=maintenance` selects the id
space. Both are things a client cannot be expected to know, which is the point:
the server knows the routing, so the server emits the link.

The type carries the rule where a caller will read it:

```ts
/**
 * Absolute URL of the public page for this maintenance.
 * Note: the public /maintenances/<id> route is keyed by maintenance EVENT id
 * by default, so this URL carries ?type=maintenance. Link via this field,
 * never by concatenating `id` onto a path.
 */
url: string;
```

`id` stays in the response, but its job is **identity, not location**: use it to
address the resource through the API (`/api/v4/maintenances/{id}`), correlate
records, or key a cache. Never to build a link.

## Consequences

- Routing can change without breaking clients. Query parameters, base paths and
  id-space selection are all server-side details.
- `url` is part of the response contract. Dropping it, or emitting a relative
  value, breaks integrations that correctly followed this rule.
- Any new resource with a public page carries the same treatment: resolve the
  URL server-side and expose it as a field.
- A client that ignores this and concatenates gets a plausible wrong page rather
  than an error, so review new API consumers for it specifically.

## Alternatives rejected

- **Document the URL shape and let clients build it.** Pushes `?type=maintenance`
  and base-path handling onto every consumer, and the penalty for getting it
  wrong is a wrong page rather than a failure.
- **Re-key the public route to maintenance ids.** Would break every existing
  link to an event, including ones already sent in notifications.
