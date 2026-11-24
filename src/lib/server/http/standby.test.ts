import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { IsRefusedOnStandby, standbyHandle, STANDBY_REFUSAL_MESSAGE } from "./standby.js";

const saved = process.env.KENER_ROLE;
afterEach(() => {
  if (saved === undefined) delete process.env.KENER_ROLE;
  else process.env.KENER_ROLE = saved;
});

describe("IsRefusedOnStandby", () => {
  it("closes the admin, sign-in and ext routes for every method", () => {
    expect(IsRefusedOnStandby("GET", "/(manage)/manage/app/monitors")).toBe(true);
    expect(IsRefusedOnStandby("POST", "/(manage)/manage/api")).toBe(true);
    expect(IsRefusedOnStandby("GET", "/(account)/account/signin")).toBe(true);
    expect(IsRefusedOnStandby("POST", "/(account)/account/signin")).toBe(true);
    // A heartbeat ping writes even as a GET.
    expect(IsRefusedOnStandby("GET", "/(ext)/ext/heartbeat/[tag]/[secret]")).toBe(true);
    expect(IsRefusedOnStandby("POST", "/(ext)/ext/alerts/[token]")).toBe(true);
  });

  it("refuses every write to the API", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(IsRefusedOnStandby(method, "/(api)/api/v4/incidents")).toBe(true);
    }
  });

  it("refuses a subscription but lets the public page's POST reads through", () => {
    expect(IsRefusedOnStandby("POST", "/(kener)/dashboard-apis/[action]", "subscription")).toBe(true);
    expect(IsRefusedOnStandby("POST", "/(kener)/dashboard-apis/[action]", "monitor-day-status")).toBe(false);
    expect(IsRefusedOnStandby("POST", "/(kener)/dashboard-apis/[action]", "events-by-month")).toBe(false);
  });

  it("serves the public page and refuses a write that matches no route", () => {
    expect(IsRefusedOnStandby("GET", "/(kener)")).toBe(false);
    expect(IsRefusedOnStandby("GET", "/(kener)/monitors/[monitor_tag]")).toBe(false);
    expect(IsRefusedOnStandby("GET", "/(kener)/dashboard-apis/[action]", "monitor-bars")).toBe(false);
    expect(IsRefusedOnStandby("HEAD", null)).toBe(false);
    expect(IsRefusedOnStandby("POST", null)).toBe(true);
  });
});

function event(method: string, routeId: string | null, params: Record<string, string> = {}, accept = "*/*") {
  return {
    request: new Request("http://localhost/x", { method, headers: { accept } }),
    route: { id: routeId },
    params,
  } as unknown as RequestEvent;
}

describe("standbyHandle", () => {
  it("passes everything through untouched on a primary", async () => {
    delete process.env.KENER_ROLE;
    const resolve = vi.fn(async () => new Response("ok"));
    const response = await standbyHandle({ event: event("POST", "/(manage)/manage/api"), resolve });
    expect(resolve).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("x-kener-role")).toBeNull();
  });

  it("answers a write on a standby with 503 and says why, without resolving it", async () => {
    process.env.KENER_ROLE = "standby";
    const resolve = vi.fn(async () => new Response("ok"));
    const response = await standbyHandle({ event: event("POST", "/(api)/api/v4/incidents"), resolve });
    expect(resolve).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "STANDBY", message: STANDBY_REFUSAL_MESSAGE } });
    expect(response.headers.get("x-kener-role")).toBe("standby");
  });

  it("tells a browser opening the admin in plain text", async () => {
    process.env.KENER_ROLE = "standby";
    const resolve = vi.fn(async () => new Response("ok"));
    const response = await standbyHandle({ event: event("GET", "/(manage)/manage/app", {}, "text/html"), resolve });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(STANDBY_REFUSAL_MESSAGE);
  });

  it("serves the public page on a standby", async () => {
    process.env.KENER_ROLE = "standby";
    const resolve = vi.fn(async () => new Response("page"));
    const response = await standbyHandle({ event: event("GET", "/(kener)"), resolve });
    expect(resolve).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kener-role")).toBe("standby");
  });
});
