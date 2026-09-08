import { describe, it, expect } from "vitest";
import { API_KEY_SCOPES, WILDCARD_SCOPE, isKnownScope, parseScopes, scopeSatisfies, describeScopes } from "./apiScopes";
import { permissions } from "./allPerms";
import { orgPermissions } from "./orgPerms";

describe("apiScopes", () => {
  describe("the vocabulary", () => {
    it("is exactly the permission catalogue, with nothing invented", () => {
      // The whole design rests on scope ids being permission ids. If this ever
      // drifts, a key's scopes and a role's permissions stop meaning the same
      // thing while still looking identical, which is the worst kind of bug to
      // find by hand.
      expect(API_KEY_SCOPES.map((p) => p.id).sort()).toEqual(
        [...permissions, ...orgPermissions].map((p) => p.id).sort(),
      );
    });

    it("accepts the wildcard and every catalogued permission", () => {
      expect(isKnownScope(WILDCARD_SCOPE)).toBe(true);
      expect(isKnownScope("monitors.read")).toBe(true);
      expect(isKnownScope("audit.read")).toBe(true);
    });

    it("rejects anything else", () => {
      expect(isKnownScope("monitors.*")).toBe(false);
      expect(isKnownScope("monitors")).toBe(false);
      expect(isKnownScope("")).toBe(false);
    });
  });

  describe("scopeSatisfies", () => {
    it("lets the wildcard through for anything", () => {
      expect(scopeSatisfies([WILDCARD_SCOPE], "monitors.write")).toBe(true);
      expect(scopeSatisfies([WILDCARD_SCOPE], "settings.write")).toBe(true);
    });

    it("matches an exact scope", () => {
      expect(scopeSatisfies(["monitors.read"], "monitors.read")).toBe(true);
    });

    it("does not treat write as implying read", () => {
      // Deliberate: `RequirePermission` is plain set membership, and a hierarchy
      // here that does not exist there would make a key and a session disagree
      // about the same permission list.
      expect(scopeSatisfies(["monitors.write"], "monitors.read")).toBe(false);
    });

    it("does not match by prefix", () => {
      expect(scopeSatisfies(["monitors"], "monitors.read")).toBe(false);
      expect(scopeSatisfies(["monitors.read"], "monitors.read.extra")).toBe(false);
    });

    it("denies an empty scope list", () => {
      expect(scopeSatisfies([], "monitors.read")).toBe(false);
    });
  });

  describe("parseScopes", () => {
    it("reads the stored JSON array", () => {
      expect(parseScopes('["monitors.read","incidents.read"]')).toEqual(["monitors.read", "incidents.read"]);
      expect(parseScopes('["*"]')).toEqual([WILDCARD_SCOPE]);
    });

    it("accepts an array a json column already decoded", () => {
      // Postgres with a json column, or a driver that parses for us.
      expect(parseScopes(["monitors.read"])).toEqual(["monitors.read"]);
    });

    it("fails closed on anything malformed", () => {
      // Every one of these must authorize nothing. A corrupt row becoming a
      // wildcard would be a skeleton key.
      for (const bad of ["", "   ", "not json", "{}", '"*"', "null", null, undefined, 42, {}]) {
        expect(parseScopes(bad), `${JSON.stringify(bad)} should parse to no scopes`).toEqual([]);
      }
    });

    it("drops non-string entries rather than keeping them", () => {
      expect(parseScopes('["monitors.read", 5, null, "incidents.read"]')).toEqual(["monitors.read", "incidents.read"]);
    });
  });

  describe("describeScopes", () => {
    it("names the three cases an operator sees", () => {
      expect(describeScopes([WILDCARD_SCOPE])).toBe("Full access");
      expect(describeScopes([])).toBe("No access");
      expect(describeScopes(["monitors.read"])).toBe("monitors.read");
      expect(describeScopes(["monitors.read", "incidents.read"])).toBe("2 scopes");
    });
  });
});
