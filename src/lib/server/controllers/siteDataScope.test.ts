import { describe, it, expect } from "vitest";
import {
  INSTANCE_ORG_ID,
  INSTANCE_SCOPED_KEYS,
  isInstanceScoped,
  writeOrgFor,
  overlaySiteData,
  overlaySiteDataKey,
} from "./siteDataScope.js";
import type { SiteData } from "../types/db.js";

const ORG = 7;
const OTHER_ORG = 9;

function row(orgId: number, key: string, value: string): SiteData {
  return {
    id: 0,
    org_id: orgId,
    key,
    value,
    data_type: "string",
    created_at: 0 as unknown as SiteData["created_at"],
    updated_at: 0 as unknown as SiteData["updated_at"],
  };
}

function valueOf(rows: SiteData[], key: string): string | undefined {
  return rows.find((r) => r.key === key)?.value;
}

describe("the overlay", () => {
  it("returns the instance value for a key the org does not override", () => {
    const rows = [row(INSTANCE_ORG_ID, "siteName", "Kener")];
    expect(valueOf(overlaySiteData(rows, ORG), "siteName")).toBe("Kener");
  });

  it("prefers the org's own value over the instance default", () => {
    const rows = [row(INSTANCE_ORG_ID, "siteName", "Kener"), row(ORG, "siteName", "Acme Status")];
    expect(valueOf(overlaySiteData(rows, ORG), "siteName")).toBe("Acme Status");
  });

  it("ignores another org's row entirely", () => {
    // The query names only two orgs, so this should be unreachable. Asserted
    // anyway: a cross-tenant read is the failure this whole layer risks, and
    // "unreachable" is a claim worth pinning rather than assuming.
    const rows = [row(INSTANCE_ORG_ID, "siteName", "Kener"), row(OTHER_ORG, "siteName", "Somebody Else")];
    expect(valueOf(overlaySiteData(rows, ORG), "siteName")).toBe("Kener");
  });

  it("leaves a key present in neither layer absent", () => {
    expect(valueOf(overlaySiteData([], ORG), "siteName")).toBeUndefined();
  });

  it("gives an org with no rows at all the full instance layer", () => {
    // This is what a newly created org looks like: it provisions no site data
    // and inherits everything.
    const rows = [
      row(INSTANCE_ORG_ID, "siteName", "Kener"),
      row(INSTANCE_ORG_ID, "theme", "system"),
      row(INSTANCE_ORG_ID, "barStyle", "PARTIAL"),
    ];
    const merged = overlaySiteData(rows, ORG);
    expect(merged).toHaveLength(3);
    expect(valueOf(merged, "barStyle")).toBe("PARTIAL");
  });

  it("keeps one org's override out of another org's view", () => {
    const rows = [row(INSTANCE_ORG_ID, "siteName", "Kener"), row(ORG, "siteName", "Acme Status")];
    expect(valueOf(overlaySiteData(rows, ORG), "siteName")).toBe("Acme Status");
    expect(valueOf(overlaySiteData(rows, OTHER_ORG), "siteName")).toBe("Kener");
  });
});

describe("instance-scoped keys", () => {
  it("names the five the instance owns", () => {
    expect([...INSTANCE_SCOPED_KEYS].sort()).toEqual(
      ["auditRetentionDays", "dataRetentionPolicy", "eventBusConsumers", "mfaPolicy", "oidcSettings"].sort(),
    );
  });

  it("reads from the instance layer even when an org row exists", () => {
    // The migration clears these and the write path cannot create one, so such a
    // row should not exist. Ignoring it is what makes that a guarantee rather
    // than an assumption: a hand-written row must not let a tenant pick its own
    // identity provider for the whole instance.
    const rows = [row(INSTANCE_ORG_ID, "mfaPolicy", "all"), row(ORG, "mfaPolicy", "none")];
    expect(valueOf(overlaySiteData(rows, ORG), "mfaPolicy")).toBe("all");
    expect(overlaySiteDataKey(rows, "mfaPolicy", ORG)?.value).toBe("all");
  });

  it("is absent when the instance layer has no row, rather than falling back to the org", () => {
    const rows = [row(ORG, "mfaPolicy", "none")];
    expect(overlaySiteDataKey(rows, "mfaPolicy", ORG)).toBeUndefined();
  });

  it("routes a write to the instance layer whatever org is acting", () => {
    expect(writeOrgFor("oidcSettings", ORG)).toBe(INSTANCE_ORG_ID);
    expect(writeOrgFor("dataRetentionPolicy", OTHER_ORG)).toBe(INSTANCE_ORG_ID);
  });

  it("routes every other write to the caller's own org", () => {
    expect(writeOrgFor("siteName", ORG)).toBe(ORG);
    expect(writeOrgFor("colors", OTHER_ORG)).toBe(OTHER_ORG);
  });

  it("treats branding as the tenant's, which is the whole point of the split", () => {
    for (const key of ["siteName", "logo", "colors", "hero", "footerHTML", "i18n", "nav"]) {
      expect(isInstanceScoped(key)).toBe(false);
    }
  });
});

describe("overlaySiteDataKey", () => {
  it("prefers the org's row for an ordinary key", () => {
    const rows = [row(INSTANCE_ORG_ID, "siteName", "Kener"), row(ORG, "siteName", "Acme")];
    expect(overlaySiteDataKey(rows, "siteName", ORG)?.value).toBe("Acme");
  });

  it("falls back to the instance row", () => {
    expect(overlaySiteDataKey([row(INSTANCE_ORG_ID, "siteName", "Kener")], "siteName", ORG)?.value).toBe("Kener");
  });

  it("returns undefined for a key in neither layer", () => {
    expect(overlaySiteDataKey([], "siteName", ORG)).toBeUndefined();
  });

  it("does not confuse one key's rows for another's", () => {
    const rows = [row(INSTANCE_ORG_ID, "siteName", "Kener"), row(ORG, "theme", "dark")];
    expect(overlaySiteDataKey(rows, "theme", ORG)?.value).toBe("dark");
    expect(overlaySiteDataKey(rows, "siteName", ORG)?.value).toBe("Kener");
  });
});
