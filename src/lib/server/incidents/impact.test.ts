import { describe, it, expect } from "vitest";
import {
  COMPONENT_IMPACTS,
  alertIncidentComponentImpact,
  isComponentImpact,
  monitorImpactFor,
} from "./impact.js";
import GC from "../../global-constants.js";

/**
 * B7. What an alert-opened incident claims about the monitor it names.
 *
 * **This pins a live bug, not a hypothetical.** `createNewIncident` passed
 * `config.alert_value` straight to `AddIncidentMonitor` as the impact. That is
 * only ever a component impact for a STATUS alert; for LATENCY it is
 * milliseconds, for UPTIME a percentage, for CERT_EXPIRY days. Anything else is
 * rejected, so it THREW - and the throw lands before `notifyQuietly`, so
 * enabling "create an incident" on a latency or uptime alert produced no
 * incident AND no notification, while the alert row stayed committed and looked
 * active. Turning on incident creation silently turned off being paged.
 *
 * Every value this function can return must therefore be a real component
 * impact, which is the first test below and the one that would have caught it.
 */
describe("alertIncidentComponentImpact", () => {
  // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. The old code could
  // return "500" here, and nothing checked that the answer was in the vocabulary
  // the incident model accepts.
  it("always returns a real component impact, for every alert kind and value", () => {
    const cases: Array<[string, string]> = [
      [GC.STATUS, "DOWN"],
      [GC.STATUS, "DEGRADED"],
      [GC.STATUS, "UP"],
      [GC.LATENCY, "500"],
      [GC.LATENCY, "1000"],
      [GC.UPTIME, "99"],
      [GC.UPTIME, "95.5"],
      [GC.CERT_EXPIRY, "30"],
      [GC.CERT_EXPIRY, "7"],
      ["SOMETHING_ADDED_LATER", "42"],
    ];

    for (const [alertFor, value] of cases) {
      const impact = alertIncidentComponentImpact(alertFor, value);
      expect(isComponentImpact(impact), `${alertFor}/${value} produced "${impact}"`).toBe(true);
      expect(COMPONENT_IMPACTS).toContain(impact);
    }
  });

  // The one case where the threshold really is a status, so it is used as before
  // and this function changes nothing for it.
  it("keeps a STATUS alert's own status", () => {
    expect(alertIncidentComponentImpact(GC.STATUS, "DOWN")).toBe("MAJOR_OUTAGE");
    expect(alertIncidentComponentImpact(GC.STATUS, "DEGRADED")).toBe("PARTIAL_OUTAGE");
  });

  // The service answers, slowly. Nothing is down, and saying so would be the
  // same false claim the SLO path was making.
  it("calls a latency or uptime alert degraded, never an outage", () => {
    for (const alertFor of [GC.LATENCY, GC.UPTIME]) {
      const impact = alertIncidentComponentImpact(alertFor, "500");
      expect(impact).toBe("DEGRADED_PERFORMANCE");
      expect(impact).not.toBe("MAJOR_OUTAGE");
    }
  });

  /**
   * B7's explicit requirement: a certificate warning must NOT mark the monitor
   * down. The service is up; it will not be in three weeks.
   *
   * The load-bearing half is the projection, not the word: OPERATIONAL maps to a
   * null `monitor_impact`, which `impact.ts` documents as "write no overlay row"
   * rather than "assert health". So the incident communicates scope without
   * touching the bars, the uptime percentages or the page status.
   */
  it("never lets a certificate warning touch the monitor's timeline", () => {
    for (const days of ["30", "14", "7", "0"]) {
      const impact = alertIncidentComponentImpact(GC.CERT_EXPIRY, days);
      expect(impact).toBe("OPERATIONAL");
      expect(monitorImpactFor(impact)).toBeNull();
    }
  });

  it("gives an unknown future alert kind a cautious answer rather than throwing", () => {
    expect(() => alertIncidentComponentImpact("BRAND_NEW", "whatever")).not.toThrow();
    expect(isComponentImpact(alertIncidentComponentImpact("BRAND_NEW", "whatever"))).toBe(true);
  });
});
