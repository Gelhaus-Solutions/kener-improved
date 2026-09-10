import { describe, it, expect } from "vitest";
import { isPubliclyVisible } from "./publicMonitorResolver.js";
import GC from "../../global-constants.js";

// The single definition of "may an anonymous visitor see this monitor".
//
// It exists because the codebase had several spellings of the rule and only some
// of them agreed: the page route and the badges enforced it, every dashboard-api
// enforced nothing, and the maintenance page enforced half of it. KENER-126.
//
// These cases are the truth table. If one of them changes, every public surface
// changes with it, which is the entire point of there being one function.

const monitor = (status: string | null, is_hidden: string) => ({ status, is_hidden });

describe("isPubliclyVisible", () => {
  it("admits an active, unhidden monitor", () => {
    expect(isPubliclyVisible(monitor(GC.ACTIVE, GC.NO))).toBe(true);
  });

  it("refuses a hidden monitor even when it is active", () => {
    expect(isPubliclyVisible(monitor(GC.ACTIVE, GC.YES))).toBe(false);
  });

  it("refuses an inactive monitor even when it is not hidden", () => {
    // The half of the rule the maintenance page was missing.
    expect(isPubliclyVisible(monitor("INACTIVE", GC.NO))).toBe(false);
  });

  it("refuses a monitor with no status at all", () => {
    expect(isPubliclyVisible(monitor(null, GC.NO))).toBe(false);
  });

  it("matches the query the rest of the codebase issues, not a looser one", () => {
    // Every existing call site asks the database for `is_hidden = 'NO'`, not
    // `is_hidden != 'YES'`. The column is NOT NULL DEFAULT 'NO' so the two agree
    // in practice, and this pins the stricter reading so they cannot drift if
    // that ever stops being true.
    expect(isPubliclyVisible(monitor(GC.ACTIVE, "" as string))).toBe(false);
  });
});
