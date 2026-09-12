import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveTypeDataSecrets } from "./secrets.js";

const VAR = "KENER_PROBE_SECRETS_TEST";
const OTHER = "KENER_PROBE_SECRETS_TEST_TWO";

beforeEach(() => {
  process.env[VAR] = "s3cret";
  process.env[OTHER] = "second";
});

afterEach(() => {
  delete process.env[VAR];
  delete process.env[OTHER];
});

describe("resolveTypeDataSecrets", () => {
  it("substitutes into nested strings, arrays and object keys", () => {
    const resolved = resolveTypeDataSecrets({
      url: `https://example.com/?k=$${VAR}`,
      headers: [{ key: `X-$${OTHER}`, value: `Bearer $${VAR}` }],
      nested: { deep: [`$${VAR}`] },
    });

    expect(resolved).toEqual({
      url: "https://example.com/?k=s3cret",
      headers: [{ key: "X-second", value: "Bearer s3cret" }],
      nested: { deep: ["s3cret"] },
    });
  });

  it("leaves a token with no matching environment variable exactly as it is", () => {
    // An unset secret is a configuration mistake. Substituting an empty string
    // would turn a visible failure into a request to a subtly wrong URL.
    const resolved = resolveTypeDataSecrets({ url: "https://example.com/$KENER_DEFINITELY_UNSET" });
    expect(resolved).toEqual({ url: "https://example.com/$KENER_DEFINITELY_UNSET" });
  });

  it("returns the input untouched when nothing needs substituting", () => {
    const input = { url: "https://example.com", timeout: 5000 };
    // Identity, not equality: the early return is what keeps the common case -
    // every monitor that uses no secrets at all - from walking the structure
    // twice on every single check.
    expect(resolveTypeDataSecrets(input)).toBe(input);
  });

  it("preserves non-string values rather than stringifying them", () => {
    const resolved = resolveTypeDataSecrets({
      url: `https://example.com/$${VAR}`,
      timeout: 5000,
      follow: true,
      nothing: null,
    });
    expect(resolved).toEqual({
      url: "https://example.com/s3cret",
      timeout: 5000,
      follow: true,
      nothing: null,
    });
  });

  it("inserts a value containing replacement metacharacters literally", () => {
    // `$&` and `$1` are expanded by String.replace unless the replacer is a
    // function. A secret holding one would otherwise be silently corrupted, and
    // the check would fail for a reason nothing in the result explains.
    process.env[VAR] = "a$&b$1c";
    const resolved = resolveTypeDataSecrets({ url: `x/$${VAR}/y` });
    expect(resolved).toEqual({ url: "x/a$&b$1c/y" });
  });

  it("does not let a short secret name corrupt a longer one that starts with it", () => {
    // `$KENER_..._TEST` is a prefix of `$KENER_..._TEST_TWO`. Substituted in the
    // wrong order, the longer token is rewritten from the inside and the value
    // that reaches the probe is a mangled credential rather than a missing one,
    // which is far harder to diagnose. The order `process.env` enumerates in is
    // not something to rely on, so this is pinned by sorting.
    const resolved = resolveTypeDataSecrets({ a: `$${OTHER}`, b: `$${VAR}` });
    expect(resolved).toEqual({ a: "second", b: "s3cret" });
  });

  it("handles a type_data that is not an object", () => {
    expect(resolveTypeDataSecrets(null)).toBe(null);
    expect(resolveTypeDataSecrets(`$${VAR}`)).toBe("s3cret");
  });
});
