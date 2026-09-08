import { describe, it, expect } from "vitest";
import { nextAttemptAt, ladderSeconds, MAX_DELIVERY_ATTEMPTS } from "./retry.js";
import { ulid } from "./ulid.js";
import { dispatchJobId } from "./relay.js";

describe("delivery retry ladder", () => {
  it("gives one more attempt than it has rungs", () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(ladderSeconds().length + 1);
  });

  it("schedules every rung and then gives up", () => {
    for (let attempts = 1; attempts < MAX_DELIVERY_ATTEMPTS; attempts++) {
      expect(nextAttemptAt(attempts, 0)).not.toBeNull();
    }
    expect(nextAttemptAt(MAX_DELIVERY_ATTEMPTS, 0)).toBeNull();
    // Past the end stays past the end, so a delivery whose attempts were bumped
    // by hand cannot walk back onto the ladder.
    expect(nextAttemptAt(MAX_DELIVERY_ATTEMPTS + 5, 0)).toBeNull();
  });

  it("backs off further on every rung", () => {
    const gaps = Array.from({ length: MAX_DELIVERY_ATTEMPTS - 1 }, (_, i) => nextAttemptAt(i + 1, 0)!);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
  });

  it("jitters forwards only, so a rung is never shortened", () => {
    const ladder = ladderSeconds();
    for (let attempts = 1; attempts < MAX_DELIVERY_ATTEMPTS; attempts++) {
      const base = ladder[attempts - 1];
      for (let i = 0; i < 200; i++) {
        const at = nextAttemptAt(attempts, 1000)!;
        expect(at).toBeGreaterThanOrEqual(1000 + base);
        expect(at).toBeLessThanOrEqual(1000 + Math.ceil(base * 1.2));
      }
    }
  });
});

describe("ulid", () => {
  it("produces 26 sortable characters", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("stays unique and ordered across a tight burst", () => {
    const ids = Array.from({ length: 2000 }, () => ulid());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("sorts by time across milliseconds", () => {
    expect(ulid(1_000_000) < ulid(1_000_001)).toBe(true);
  });
});

describe("dispatchJobId", () => {
  // BullMQ rejects a custom job id containing a colon, and a target id is caller
  // data that may well contain one. This is the guard on that.
  it("never contains a colon, whatever the target is", () => {
    const id = dispatchJobId("01ABC", "webhooks", "url", "https://example.com:8443/hook?a=b:c");
    expect(id).not.toContain(":");
  });

  it("is stable for the same delivery and attempt", () => {
    const args = ["01ABC", "webhooks", "url", "https://example.com/hook", 0] as const;
    expect(dispatchJobId(...args)).toBe(dispatchJobId(...args));
  });

  it("separates targets that would otherwise concatenate the same", () => {
    expect(dispatchJobId("01ABC", "c", "ab", "c")).not.toBe(dispatchJobId("01ABC", "c", "a", "bc"));
  });

  it("changes per attempt, so a retry is not swallowed as a duplicate job", () => {
    expect(dispatchJobId("01ABC", "c", "t", "1", 0)).not.toBe(dispatchJobId("01ABC", "c", "t", "1", 1));
  });
});
