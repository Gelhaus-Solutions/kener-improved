import { json, type Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { requestIdHandle } from "$lib/server/http/requestId";
import { manageRedirectHandle } from "$lib/server/http/manageRedirects";
import { orgResolveHandle } from "$lib/server/http/orgResolve";
import { isForbiddenCrossSiteForm } from "$lib/server/http/csrf";
import { sessionOrgHandle } from "$lib/server/http/sessionOrg";
import { eventContextHandle } from "$lib/server/http/eventContext";
import { auditApiKeyAuthFailure, auditApiKeyScopeDenied } from "$lib/server/audit/events";
import { AuthenticateAPIKey, ApiKeyHasScope, TouchAPIKey } from "$lib/server/controllers/apiController";
import { requiredScopeForRoute } from "$lib/server/api/routeScopes";
import { ResolvePublicMonitorTag } from "$lib/server/controllers/publicMonitorResolver";
import db from "$lib/server/db/db";
import type { UnauthorizedResponse, ForbiddenResponse, NotFoundResponse } from "$lib/types/api";
import { GetMonitorsParsed } from "$lib/server/controllers/monitorsController";
import GC from "$lib/global-constants";
import { InstallEnvProxy } from "$lib/server/proxy";

// Dev runs the SvelteKit server and the scheduler as separate processes; each installs once.
InstallEnvProxy();

const API_PATH_PREFIX = "/api/";

// Paths that don't require authentication
const PUBLIC_API_PATHS = ["/api/status"];

// Regex to match routes with monitor_tag parameter
const MONITOR_TAG_ROUTE_REGEX = /^\/api\/(?:v\d+\/)?monitors\/([^/]+)/;

// Regex to match routes with incident_id parameter
const INCIDENT_ID_ROUTE_REGEX = /^\/api\/(?:v\d+\/)?incidents\/(\d+)/;

// Regex to match routes with maintenance_id parameter
const MAINTENANCE_ID_ROUTE_REGEX = /^\/api\/(?:v\d+\/)?maintenances\/(\d+)/;

// Regex to match routes with page_path parameter
const PAGE_PATH_ROUTE_REGEX = /^\/api\/(?:v\d+\/)?pages\/([^/]+)/;

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith(API_PATH_PREFIX);
}

function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.some((path) => pathname === path || pathname === path + "/");
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return null;
}

function extractMonitorTag(pathname: string): string | null {
  const match = pathname.match(MONITOR_TAG_ROUTE_REGEX);
  return match ? match[1] : null;
}

function extractIncidentId(pathname: string): number | null {
  const match = pathname.match(INCIDENT_ID_ROUTE_REGEX);
  return match ? parseInt(match[1], 10) : null;
}

function extractMaintenanceId(pathname: string): number | null {
  const match = pathname.match(MAINTENANCE_ID_ROUTE_REGEX);
  return match ? parseInt(match[1], 10) : null;
}

function extractPagePath(pathname: string): string | null {
  const match = pathname.match(PAGE_PATH_ROUTE_REGEX);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * The CSRF origin check, made custom-domain aware (G4).
 *
 * **This is the only origin check the app runs.** SvelteKit's built-in one is
 * off, and has been since `csrf.trustedOrigins: ["*"]` was set in
 * `svelte.config.js` - SvelteKit expands that wildcard at build time rather than
 * matching it per request. SvelteKit compares `Origin` against
 * `url.origin`, and under `adapter-node` `url.origin` is pinned by the `ORIGIN`
 * environment variable to one hostname for the whole process. That is right for
 * a single-domain install and wrong here: a tenant reaching its own
 * `org_domains` or `page_domains` hostname sends `Origin: https://status.acme.com`
 * while `url.origin` still reads the main domain, so **every form POST on a
 * custom domain was refused, sign-in included**. `csrf.trustedOrigins` could not
 * fix it either - it is an exact-match list fixed when the app is built, and
 * custom domains are rows an operator adds at runtime.
 *
 * So the comparison is against the host the request actually arrived on. That is
 * the same `Host` header `orgResolveHandle` already trusts to decide *which
 * tenant's data to serve*, so relying on it here asks less of it than the
 * request already does a few handlers later.
 *
 * **The check is no weaker than the one it replaces.** A cross-site POST from
 * `evil.com` carries `Origin: https://evil.com` and a `Host` of whichever Kener
 * hostname it is aimed at, so the two still disagree and it is still refused. A
 * A missing or opaque `Origin` is refused too. The comment this replaces claimed
 * such requests were allowed; since this handler is the only check, "allowed"
 * meant genuinely allowed, and refusing them is a deliberate tightening.
 *
 * The port comes off both sides before comparing, because a proxy terminating TLS
 * commonly forwards `Host: example.com:3000` while the browser's `Origin` carries
 * no port at all. `orgResolveHandle` strips it for the same reason.
 */
const csrfHandle: Handle = async ({ event, resolve }) => {
  const { request } = event;

  const forbidden = isForbiddenCrossSiteForm({
    method: request.method,
    contentType: request.headers.get("content-type"),
    origin: request.headers.get("origin"),
    // `event.url.host` only as a fallback: HTTP/1.1 requires a Host header and
    // Node synthesises one from `:authority` on HTTP/2, so a request with none
    // is the case that should not arise rather than one that is supported.
    host: request.headers.get("host") ?? event.url.host,
  });

  if (forbidden) {
    return new Response(`Cross-site ${request.method} form submissions are forbidden`, { status: 403 });
  }

  return resolve(event);
};

const apiAuthHandle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;

  // Check if this is an API route that requires authentication
  if (isApiRoute(pathname) && !isPublicApiPath(pathname)) {
    const authHeader = event.request.headers.get("authorization");
    const token = extractBearerToken(authHeader);

    if (!token) {
      const errorResponse: UnauthorizedResponse = {
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid authorization header",
        },
      };
      auditApiKeyAuthFailure(event, "missing_bearer_token", pathname);
      return json(errorResponse, { status: 401 });
    }

    const principal = await AuthenticateAPIKey(token);
    if (!principal) {
      const errorResponse: UnauthorizedResponse = {
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid API key",
        },
      };
      // The key itself is never recorded, not even truncated: a prefix is
      // enough to confirm a guess against the log if the log is ever read by
      // someone it should not be.
      auditApiKeyAuthFailure(event, "invalid_api_key", pathname);
      return json(errorResponse, { status: 401 });
    }

    // Everything below this line runs as an identified caller. The order of the
    // four steps that follow is the security-relevant part of this handler, and
    // it changed deliberately in A10:
    //
    //   1. establish the key's org context,
    //   2. reject a path that matches no route,
    //   3. check the key's scope,
    //   4. only then pre-resolve the entities named in the path.
    //
    // It used to pre-resolve first, and that is an existence oracle. A key with
    // no monitor scope could tell a real monitor tag from a fake one by whether
    // it got a 404 or a 200, and once P4 makes keys org-scoped the same lookup
    // would answer "does org B have a monitor called X" for a key belonging to
    // org A. Resolving *after* the scope check means a key that may not read
    // monitors gets an identical 403 either way.
    event.locals.apiKey = principal;

    // P4: enter the org this key belongs to, so every query below (and every
    // query in the route handler) is scoped to it. `principal.orgId` is already
    // carried for that purpose and is NULL on every key today, meaning the
    // single implicit org. This is the chokepoint the tenancy work fills in;
    // it sits here, above the pre-resolution, for the reason spelled out above.

    // Record the use before deciding whether the request is allowed. "Last used"
    // means "last presented a valid secret", which is the question being asked
    // when somebody is working out whether a key is still live or which key a
    // misbehaving integration holds. Throttled to one write a minute per key.
    await TouchAPIKey(principal, event.getClientAddress?.() ?? null);

    // API consumers must always get JSON; without this, an /api/ path with no
    // matching route falls through to SvelteKit's HTML error page
    if (event.route.id === null) {
      const errorResponse: NotFoundResponse = {
        error: {
          code: "NOT_FOUND",
          message: `No API route matches '${pathname}'`,
        },
      };
      return json(errorResponse, { status: 404 });
    }

    // The scope check. `requiredScopeForRoute` returns undefined for a route or
    // method it does not know, and that is a denial rather than a pass: an
    // unmapped route is one nobody has decided is safe. Keys holding `*` skip
    // the map entirely, which is what keeps every key minted before scoping
    // existed working exactly as it did.
    const required = requiredScopeForRoute(event.route.id, event.request.method);
    if (!required || !ApiKeyHasScope(principal, required)) {
      const errorResponse: ForbiddenResponse = {
        error: {
          code: "FORBIDDEN",
          message: required
            ? `This API key does not have the '${required}' scope`
            : "This API key is not permitted to use this endpoint",
        },
      };
      auditApiKeyScopeDenied(event, principal, required, pathname, event.request.method);
      return json(errorResponse, { status: 403 });
    }

    // Validate monitor tag exists for /api/(vX/)?monitors/:monitor_tag/* routes
    const monitorTag = extractMonitorTag(pathname);
    if (monitorTag) {
      // I3e: the URL segment is a *slug*, resolved within the org the key
      // established a moment ago. For the default org slug and tag are the same
      // string, so every existing API URL is unaffected.
      const resolvedTag = (await ResolvePublicMonitorTag(monitorTag)) ?? monitorTag;
      const monitor = await GetMonitorsParsed({ tag: resolvedTag }).then((monitors) => monitors[0]);
      if (!monitor) {
        const errorResponse: NotFoundResponse = {
          error: {
            code: "NOT_FOUND",
            message: `Monitor with tag '${monitorTag}' not found`,
          },
        };
        return json(errorResponse, { status: 404 });
      }
      // Store monitor in locals for use in endpoints
      event.locals.monitor = monitor;
    }

    // Validate incident_id exists for /api/(vX/)?incidents/:incident_id/* routes
    const incidentId = extractIncidentId(pathname);
    if (incidentId) {
      const incident = await db.getIncidentById(incidentId);
      if (!incident) {
        const errorResponse: NotFoundResponse = {
          error: {
            code: "NOT_FOUND",
            message: `Incident with id '${incidentId}' not found`,
          },
        };
        return json(errorResponse, { status: 404 });
      }
      // Store incident in locals for use in endpoints
      event.locals.incident = incident;
    }

    // Validate maintenance_id exists for /api/(vX/)?maintenances/:maintenance_id/* routes
    const maintenanceId = extractMaintenanceId(pathname);
    if (maintenanceId) {
      const maintenance = await db.getMaintenanceById(maintenanceId);
      if (!maintenance) {
        const errorResponse: NotFoundResponse = {
          error: {
            code: "NOT_FOUND",
            message: `Maintenance with id '${maintenanceId}' not found`,
          },
        };
        return json(errorResponse, { status: 404 });
      }
      // Store maintenance in locals for use in endpoints
      event.locals.maintenance = maintenance;
    }

    // Validate page_path exists for /api/(vX/)?pages/:page_path/* routes
    const pagePath = extractPagePath(pathname);
    if (pagePath) {
      // The home page has an empty page_path, unreachable as a URL segment;
      // the ~home token addresses it instead
      const lookupPath = pagePath === GC.HOME_PAGE_TOKEN ? "" : pagePath;
      const page = await db.getPageByPath(lookupPath);
      if (!page) {
        const errorResponse: NotFoundResponse = {
          error: {
            code: "NOT_FOUND",
            message: `Page with path '${pagePath}' not found`,
          },
        };
        return json(errorResponse, { status: 404 });
      }
      // Store page in locals for use in endpoints
      event.locals.page = page;
    }
  }

  const response = await resolve(event);
  response.headers.delete("Link");
  return response;
};

// `orgResolveHandle` runs before `apiAuthHandle` and after the cheap ones: it
// establishes the host-derived org for the whole request, and `apiAuthHandle`
// then overrides it with the API key's org. That precedence is load-bearing -
// see the invariant written out in orgResolve.ts.
//
// `sessionOrgHandle` sits between them and applies to `/manage` only, where the
// org comes from the signed-in session rather than the hostname. See
// sessionOrg.ts.
export const handle = sequence(
  requestIdHandle,
  manageRedirectHandle,
  csrfHandle,
  orgResolveHandle,
  sessionOrgHandle,
  apiAuthHandle,
  eventContextHandle,
);
