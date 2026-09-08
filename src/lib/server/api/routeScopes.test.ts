import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ROUTE_SCOPE_MAP, requiredScopeForRoute } from "./routeScopes.js";
import { API_KEY_SCOPES } from "../../apiScopes.js";

const API_ROUTES_DIR = path.resolve(process.cwd(), "src/routes/(api)/api");

/** Every `+server.ts` under `(api)`, as the route id SvelteKit would give it. */
function discoverApiRoutes(): Array<{ routeId: string; methods: string[] }> {
  const found: Array<{ routeId: string; methods: string[] }> = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== "+server.ts") continue;

      const relative = path.relative(API_ROUTES_DIR, dir).split(path.sep).filter(Boolean);
      const routeId = ["/(api)/api", ...relative].join("/");
      const source = fs.readFileSync(full, "utf8");
      const methods = [...source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
      found.push({ routeId, methods });
    }
  }

  walk(API_ROUTES_DIR);
  return found;
}

describe("routeScopes", () => {
  const routes = discoverApiRoutes();

  it("finds the API routes it is supposed to be guarding", () => {
    // A guard on the guard. If the discovery above silently found nothing - a
    // moved directory, a renamed group - every assertion below would pass
    // vacuously and this file would be worthless.
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes)("maps every method of $routeId", ({ routeId, methods }) => {
    // This is the test that earns its keep on an upstream sync. A new v4 route,
    // or a new method on an existing one, arrives with no entry here, and a
    // scoped key would silently 403 against it. Failing here is how that gets
    // noticed at the point it is introduced rather than in a support ticket.
    for (const method of methods) {
      expect(requiredScopeForRoute(routeId, method), `${method} ${routeId} has no scope mapping`).toBeDefined();
    }
  });

  it("maps no route that does not exist", () => {
    const real = new Set(routes.map((r) => r.routeId));
    for (const routeId of Object.keys(ROUTE_SCOPE_MAP)) {
      expect(real.has(routeId), `${routeId} is mapped but no such route exists`).toBe(true);
    }
  });

  it("only requires permissions that are real", () => {
    const known = new Set(API_KEY_SCOPES.map((p) => p.id));
    for (const [routeId, methods] of Object.entries(ROUTE_SCOPE_MAP)) {
      for (const [method, permission] of Object.entries(methods)) {
        expect(known.has(permission as string), `${method} ${routeId} requires unknown ${permission}`).toBe(true);
      }
    }
  });

  it("fails closed on an unmapped route and an unmapped method", () => {
    expect(requiredScopeForRoute("/(api)/api/v4/does-not-exist", "GET")).toBeUndefined();
    // The route exists and GET is mapped, but it has no DELETE.
    expect(requiredScopeForRoute("/(api)/api/v4/site", "DELETE")).toBeUndefined();
  });

  it("fails closed when SvelteKit matched no route at all", () => {
    expect(requiredScopeForRoute(null, "GET")).toBeUndefined();
  });

  it("answers HEAD with the GET mapping", () => {
    // SvelteKit serves HEAD from the GET handler, so resolving it separately
    // would make every HEAD request a 403 for a correctly scoped key.
    expect(requiredScopeForRoute("/(api)/api/v4/monitors", "HEAD")).toBe("monitors.read");
  });

  it("is case-insensitive about the method", () => {
    expect(requiredScopeForRoute("/(api)/api/v4/monitors", "get")).toBe("monitors.read");
  });

  it("separates reads from writes on the same route", () => {
    expect(requiredScopeForRoute("/(api)/api/v4/monitors/[monitor_tag]", "GET")).toBe("monitors.read");
    expect(requiredScopeForRoute("/(api)/api/v4/monitors/[monitor_tag]", "DELETE")).toBe("monitors.write");
    expect(requiredScopeForRoute("/(api)/api/v4/site/[config_key]", "GET")).toBe("settings.read");
    expect(requiredScopeForRoute("/(api)/api/v4/site/[config_key]", "PATCH")).toBe("settings.write");
  });
});
