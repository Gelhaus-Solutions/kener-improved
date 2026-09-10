// G4. The absolute base URL to use for links in a response.
//
// **Why this exists.** Before custom domains there was exactly one answer, the
// `siteURL` site-data key, and it was baked into the sitemap, the RSS feed and
// the social preview tags. With several hostnames serving several pages that
// single answer is wrong for every host but one: a customer opening
// `status.acme.com` would get a feed whose links point at `status.example.org`,
// which is both a bad look and, for RSS readers keyed on link identity, broken.
//
// **It only ever trusts headers a proxy sets, and only for the host part.** The
// hostname comes from `Host`, which is the same value `orgResolve` already used
// to decide which tenant this request belongs to - so if it were forgeable the
// tenancy boundary would already be gone, and it is not: a reverse proxy sets it
// from the TLS SNI it terminated. The scheme comes from `X-Forwarded-Proto`
// where present, because behind a proxy the app itself always sees plain HTTP
// and would otherwise emit `http://` links for an HTTPS site.

/** Hosts that must never produce an absolute URL claiming to be the public site. */
function isUsableHost(host: string): boolean {
  if (!host) return false;
  // A missing or wildcard Host is not a site.
  if (host === "*" || host === "_") return false;
  return true;
}

function schemeFor(forwardedProto: string | null, fallbackUrl: string | null): string {
  // A proxy may send a comma-separated list when several are chained; the first
  // is the one the client actually spoke.
  const proto = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (proto === "http" || proto === "https") return proto;

  // Otherwise inherit whatever the configured site URL uses, so a deliberately
  // plain-HTTP install does not start emitting https links.
  if (fallbackUrl) {
    try {
      return new URL(fallbackUrl).protocol.replace(":", "");
    } catch {
      /* a malformed siteURL is handled below */
    }
  }
  return "https";
}

/**
 * The absolute base for this request, or the configured `siteURL`.
 *
 * Returns `null` only when there is neither a usable host nor a configured
 * `siteURL`, which is the case callers already treat as "cannot build links".
 */
export function publicBaseUrl(args: {
  requestHost: string | null | undefined;
  forwardedProto?: string | null;
  siteURL: string | null | undefined;
}): string | null {
  const host = (args.requestHost ?? "").trim();
  const siteURL = (args.siteURL ?? "").trim() || null;

  if (isUsableHost(host)) {
    const scheme = schemeFor(args.forwardedProto ?? null, siteURL);
    // The Host header carries the port when it is non-default, which is what a
    // link needs on a development instance and is absent in production.
    return `${scheme}://${host}`.replace(/\/+$/, "");
  }

  return siteURL ? siteURL.replace(/\/+$/, "") : null;
}

/** The two headers `publicBaseUrl` reads, pulled from a request in one place. */
export function publicBaseUrlFromRequest(request: Request, siteURL: string | null | undefined): string | null {
  return publicBaseUrl({
    requestHost: request.headers.get("host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    siteURL,
  });
}
