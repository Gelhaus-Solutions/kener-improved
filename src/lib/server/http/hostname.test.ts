import { describe, it, expect } from "vitest";
import { normalizeHostname } from "./hostname";

// G4. These are the values operators actually paste. Each one that survives
// un-normalised produces a domain that never matches a `Host` header, resolves
// to nothing, and gives no indication why - which is the worst kind of bug to
// ship into a configuration screen.

describe("normalizeHostname", () => {
  it("passes a plain hostname through", () => {
    expect(normalizeHostname("status.example.com")).toBe("status.example.com");
  });

  it("lowercases, because Host headers are compared lowercased", () => {
    expect(normalizeHostname("Status.Example.COM")).toBe("status.example.com");
  });

  it("strips a scheme and a trailing slash, which is what a browser bar gives you", () => {
    expect(normalizeHostname("https://status.example.com/")).toBe("status.example.com");
    expect(normalizeHostname("http://status.example.com")).toBe("status.example.com");
  });

  it("strips a path", () => {
    expect(normalizeHostname("https://status.example.com/incidents")).toBe("status.example.com");
    expect(normalizeHostname("status.example.com/incidents")).toBe("status.example.com");
  });

  it("strips a port", () => {
    // The stored value never carries one; `orgResolve` strips it from the
    // header side too, and the two have to agree.
    expect(normalizeHostname("status.example.com:8443")).toBe("status.example.com");
    expect(normalizeHostname("https://status.example.com:8443/x")).toBe("status.example.com");
  });

  it("strips credentials embedded in a pasted URL", () => {
    expect(normalizeHostname("https://user:pass@status.example.com/")).toBe("status.example.com");
  });

  it("drops a trailing dot, which is the same host", () => {
    expect(normalizeHostname("status.example.com.")).toBe("status.example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHostname("  status.example.com  ")).toBe("status.example.com");
  });

  it("keeps an internal single-label host", () => {
    // Legitimate on a private network, and rejecting it would be wrong.
    expect(normalizeHostname("status")).toBe("status");
  });

  it("keeps an internationalised domain", () => {
    expect(normalizeHostname("stätus.example.com")).toBe("stätus.example.com");
  });

  it("rejects empty and whitespace-only input", () => {
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname("   ")).toBeNull();
  });

  it("rejects a wildcard, which is not a host this can bind", () => {
    expect(normalizeHostname("*.example.com")).toBeNull();
    expect(normalizeHostname("*")).toBeNull();
  });

  it("rejects anything with whitespace inside it", () => {
    expect(normalizeHostname("status example com")).toBeNull();
  });

  it("rejects an unparseable URL rather than storing a fragment of it", () => {
    expect(normalizeHostname("https://")).toBeNull();
  });

  it("rejects an absurdly long value", () => {
    expect(normalizeHostname("a".repeat(256))).toBeNull();
  });

  it("normalises an IPv6 literal without eating its colons", () => {
    // The port-stripping split on ":" would destroy this, which is why it is
    // guarded on the bracket.
    expect(normalizeHostname("[2001:db8::1]")).toBe("[2001:db8::1]");
  });
});
