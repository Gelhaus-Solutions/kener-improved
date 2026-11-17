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
  load({ params: { tag: "kener" }, url: new URL(`http://localhost/embed/monitor-kener${query}`) } as Parameters<
    typeof load
  >[0]);

describe("embed monitor load", () => {
  it.each([
    ["", 90],
    ["?days=abc", 90],
    ["?days=30", 30],
    ["?days=0", 1],
    ["?days=500", 90],
  ])("%s gives days=%i", async (query, days) => {
    expect(await run(query)).toMatchObject({ days });
  });
});
