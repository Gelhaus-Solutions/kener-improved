# ADR 0004: The home page is addressed in the API by the token `~home`

- **Status:** Accepted. Describes current behaviour.
- **Origin:** Upstream decision, **reconstructed by this fork** from the code that cites it. See [README](README.md).
- **Cited from:** `src/lib/global-constants.ts` (`HOME_PAGE_TOKEN`), `src/lib/types/api.ts` (`PageResponse.page_path`)

## Context

Status pages are stored in one table and identified by `page_path`. A page at
`/status` has `page_path = "status"`. The home page has no path segment at all,
so its stored `page_path` is the **empty string**, and its public URL is the
site root.

That empty string is fine as storage and impossible as a URL segment. The v4 API
addresses a page as `/api/v4/pages/{page_path}`, and there is no request that
puts an empty segment there: `/api/v4/pages/` is a different route, and any
encoding of `""` collapses. The one page every install has is the one page the
API cannot name.

## Decision

**Reserve a token that cannot collide with a real path, and use it at the API
boundary only.**

```ts
// Special path segment addressing the home page in the v4 API; its stored
// page_path is an empty string.
HOME_PAGE_TOKEN: "~home",
```

`~` is stripped by the path sanitiser (`replace(/[^a-z0-9_-]/g, "")`), so no
user-created page can ever be called `~home`. The token is reserved by
construction rather than by a uniqueness check.

The translation happens at exactly two points:

**Inbound**, once, in `hooks.server.ts`, before any endpoint sees the request:

```ts
// The home page has an empty page_path, unreachable as a URL segment;
// the ~home token addresses it instead
const lookupPath = pagePath === GC.HOME_PAGE_TOKEN ? "" : pagePath;
const page = await db.getPageByPath(lookupPath);
```

**Outbound**, when serialising a page:

```ts
page_path: page.page_path === "" ? GC.HOME_PAGE_TOKEN : page.page_path,
```

The database still stores `""`. The token exists only in the API surface.

### Read-modify-write is not a rename

The outbound mapping creates a trap: a client that GETs the home page and PUTs
it back sends `page_path: "~home"`, which naively reads as a request to rename
the page to `~home`. That is handled explicitly:

```ts
// API responses render the home page's path as ~home, so a read-modify-write
// client sends it back unchanged; treat that as "no path change"
if (page.page_path === "" && body.page_path === GC.HOME_PAGE_TOKEN) {
  body.page_path = undefined;
}
```

The home page's path is fixed and cannot be changed, matching the manage UI,
which disables the field with "Home page path cannot be changed".

## Consequences

- Every page, home included, is addressable through one uniform route shape.
- The mapping must stay at the boundary. A query written against `"~home"`
  matches nothing, and one written against `""` from an API-facing layer misses
  the token. Both directions fail quietly, so new code that touches `page_path`
  needs to be clear which side of the boundary it is on.
- Any new endpoint taking a `page_path` inherits inbound translation for free
  via the hook, but must apply the outbound mapping itself when it serialises a
  page.
- `~home` is a permanent reserved word in the page-path namespace.

## Alternatives rejected

- **A numeric id route.** Works, but the whole v4 page API is path-addressed and
  a second addressing scheme for one page is worse than a reserved token.
- **Giving the home page a real path such as `home`.** Changes the stored value
  every install already has, and collides with a user page genuinely called
  `home`.
- **A dedicated `/api/v4/pages/home` endpoint.** Duplicates every page endpoint
  for one special case, and the duplicates drift.
