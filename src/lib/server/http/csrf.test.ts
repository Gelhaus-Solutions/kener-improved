import { describe, it, expect } from "vitest";
import { isForbiddenCrossSiteForm, isFormContentType, FORM_CONTENT_TYPES } from "./csrf.js";

/**
 * The origin check, in both directions.
 *
 * This is the only CSRF check the app runs - `svelte.config.js` sets
 * `csrf.checkOrigin: false` because SvelteKit's compares against `url.origin`,
 * which `adapter-node` pins to the `ORIGIN` environment variable and which
 * therefore names the wrong host on every tenant's custom domain.
 *
 * So these tests have to prove two things, and the second is the one that makes
 * the first safe: that a tenant on its own domain is let through, and that
 * nothing else is.
 */

const form = (overrides: Partial<Parameters<typeof isForbiddenCrossSiteForm>[0]> = {}) => ({
  method: "POST",
  contentType: "application/x-www-form-urlencoded",
  origin: "https://status.acme.com",
  host: "status.acme.com",
  ...overrides,
});

describe("a tenant posting to its own host", () => {
  it("is allowed on a custom domain", () => {
    // The bug this fixes. `ORIGIN` names the main domain, so SvelteKit's check
    // refused this and sign-in was impossible on any custom domain.
    expect(isForbiddenCrossSiteForm(form())).toBe(false);
  });

  it("is allowed when a proxy leaves a port on the Host header", () => {
    // A TLS-terminating proxy commonly forwards `Host: example.com:3000` while
    // the browser's Origin carries no port at all.
    expect(isForbiddenCrossSiteForm(form({ host: "status.acme.com:3000" }))).toBe(false);
  });

  it("is allowed in local development, where both carry the port", () => {
    expect(isForbiddenCrossSiteForm(form({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(false);
  });

  it("ignores case and a trailing dot", () => {
    // `example.com.` and `example.com` are the same host, and a fully-qualified
    // name legitimately ends in a dot.
    expect(isForbiddenCrossSiteForm(form({ origin: "https://STATUS.acme.com.", host: "status.acme.com" }))).toBe(false);
  });
});

describe("anything else", () => {
  it("refuses a genuine cross-origin post", () => {
    expect(isForbiddenCrossSiteForm(form({ origin: "https://evil.com" }))).toBe(true);
  });

  it("refuses a subdomain of the target", () => {
    // Sibling and child hosts are separate origins; a cookie scoped to the
    // parent domain would otherwise ride along from an attacker-held subdomain.
    expect(isForbiddenCrossSiteForm(form({ origin: "https://evil.status.acme.com" }))).toBe(true);
  });

  it("refuses a host that merely starts with the right string", () => {
    expect(isForbiddenCrossSiteForm(form({ origin: "https://status.acme.com.evil.com" }))).toBe(true);
  });

  it("refuses a missing Origin", () => {
    // SvelteKit refused this, so allowing it while its check is off would be a
    // real loosening rather than preserving what the app already did.
    expect(isForbiddenCrossSiteForm(form({ origin: null }))).toBe(true);
  });

  it("refuses the opaque null origin", () => {
    expect(isForbiddenCrossSiteForm(form({ origin: "null" }))).toBe(true);
  });

  it("refuses when there is no host to compare against", () => {
    expect(isForbiddenCrossSiteForm(form({ host: null }))).toBe(true);
  });

  it("refuses an unparseable origin rather than letting it through", () => {
    expect(isForbiddenCrossSiteForm(form({ origin: "not a host" }))).toBe(true);
  });
});

describe("scope", () => {
  it("covers every method a form can be submitted with", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isForbiddenCrossSiteForm(form({ method, origin: "https://evil.com" })), method).toBe(true);
    }
  });

  it("leaves GET and HEAD alone", () => {
    for (const method of ["GET", "HEAD"]) {
      expect(isForbiddenCrossSiteForm(form({ method, origin: "https://evil.com" })), method).toBe(false);
    }
  });

  it("covers every form content type, including SvelteKit's binary one", () => {
    // The fourth was missing from the fork's copy of this list, which was
    // harmless only while the framework's own check was also running.
    expect(FORM_CONTENT_TYPES).toContain("application/x-sveltekit-formdata");
    for (const contentType of FORM_CONTENT_TYPES) {
      expect(isForbiddenCrossSiteForm(form({ contentType, origin: "https://evil.com" })), contentType).toBe(true);
    }
  });

  it("reads the type out of a header carrying parameters", () => {
    expect(isFormContentType("multipart/form-data; boundary=----abc")).toBe(true);
    expect(isFormContentType("Application/X-WWW-Form-Urlencoded")).toBe(true);
  });

  it("leaves JSON alone", () => {
    // A form cannot produce `application/json`, so a cross-site POST cannot
    // forge one without a CORS preflight the browser will not grant. The v4 API
    // speaks JSON with a Bearer token and must not be gated on a browser header.
    expect(isForbiddenCrossSiteForm(form({ contentType: "application/json", origin: "https://evil.com" }))).toBe(false);
    expect(isForbiddenCrossSiteForm(form({ contentType: "application/json", origin: null }))).toBe(false);
  });
});
