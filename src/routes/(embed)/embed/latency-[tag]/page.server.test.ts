import { describe, expect, it, vi } from "vitest";

// Fork: the loader resolves the monitor (KENER-126) and renders its bar on the
// server, so both are stood in for; this file is about the query parameters.
vi.mock("$lib/server/controllers/publicMonitorResolver", () => ({
  ResolveVisiblePublicMonitor: vi.fn(async () => ({ tag: "kener" })),
}));
vi.mock("$lib/server/api-server/monitor-bar/shared", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildMonitorBarResponse: vi.fn(async () => ({})),
}));

import { load } from "./+page.server";

const run = (query: string) =>
  load({ params: { tag: "kener" }, url: new URL(`http://localhost/embed/latency-kener${query}`) } as Parameters<
    typeof load
  >[0]);

describe("embed latency load", () => {
  it.each([
    ["", 90, 128],
    ["?days=abc&height=abc", 90, 128],
    ["?days=7&height=300", 7, 300],
    ["?days=0&height=10", 1, 50],
  ])("%s gives days=%i and height=%i", async (query, days, height) => {
    expect(await run(query)).toMatchObject({ days, height });
  });
});
