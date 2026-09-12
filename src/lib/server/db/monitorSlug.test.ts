import { describe, it, expect } from "vitest";
import { slugFromTag, tagFromSlug } from "./monitorSlug.js";

/**
 * The tag/slug invariant, which was written down in four places and honoured in
 * two.
 *
 * The failure this guards is quiet by construction: on the default org the
 * prefix is empty, so a function that strips nothing and a function that strips
 * correctly are indistinguishable. Every case below that matters is a case only
 * a second org can reach.
 */

describe("slugFromTag", () => {
  it("is a no-op when the org has no prefix", () => {
    // The default org, and therefore every single-tenant install ever upgraded.
    // If this ever changes, every existing public URL, badge and embed moves.
    expect(slugFromTag("earth", "")).toBe("earth");
    expect(slugFromTag("earth", null)).toBe("earth");
    expect(slugFromTag("earth", undefined)).toBe("earth");
  });

  it("strips the org prefix and its separator", () => {
    expect(slugFromTag("postiz_earth", "postiz")).toBe("earth");
    expect(slugFromTag("acme_cloud-api", "acme")).toBe("cloud-api");
  });

  it("leaves a tag that does not carry the prefix alone", () => {
    // A tag can be anything the v4 API was given. The prefix is a convention the
    // product applies on the paths it owns, not a rule the column enforces, so a
    // blind slice would corrupt names it was never responsible for.
    expect(slugFromTag("bare-tag", "acme")).toBe("bare-tag");
    expect(slugFromTag("acmex_earth", "acme")).toBe("acmex_earth");
  });

  it("does not strip a tag down to nothing", () => {
    // An empty slug is not a URL segment, and every such monitor in an org would
    // collide on `monitors_org_id_slug_unique`. Keeping the tag is wrong but
    // usable; an empty slug is neither.
    expect(slugFromTag("acme_", "acme")).toBe("acme_");
  });

  it("strips only the first occurrence", () => {
    // A monitor genuinely called `acme_thing` in the org `acme` has the tag
    // `acme_acme_thing`, and its slug is `acme_thing`, not `thing`.
    expect(slugFromTag("acme_acme_thing", "acme")).toBe("acme_thing");
  });
});

describe("tagFromSlug", () => {
  it("is the inverse of slugFromTag", () => {
    for (const [slug, prefix] of [
      ["earth", ""],
      ["earth", "postiz"],
      ["cloud-api", "acme"],
      ["acme_thing", "acme"],
    ] as const) {
      expect(slugFromTag(tagFromSlug(slug, prefix), prefix)).toBe(slug);
    }
  });

  it("leaves the default org's tags byte-identical to its slugs", () => {
    expect(tagFromSlug("earth", "")).toBe("earth");
    expect(tagFromSlug("earth", null)).toBe("earth");
  });
});
