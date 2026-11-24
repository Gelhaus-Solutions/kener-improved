import type { Handle } from "@sveltejs/kit";
import { IsStandby } from "../standby/config.js";

/**
 * A standby serves the public page and refuses everything else.
 *
 * Closed whole: the admin (manage), sign-in (account: a standby holds no users,
 * and its empty user table would offer anyone "Create Admin Account"), and ext
 * (heartbeat pings and inbound alerts write, by GET too). Elsewhere only safe
 * methods pass, plus the dashboard reads the public page sends as POST.
 *
 * Matched on the route id, not the path: SvelteKit routes on the decoded path,
 * and the id carries no base path.
 */
const CLOSED_GROUPS = ["/(manage)/", "/(account)/", "/(ext)/"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DASHBOARD_ROUTE = "/(kener)/dashboard-apis/[action]";
const DASHBOARD_READS_BY_POST = new Set([
  "monitor-day-status",
  "monitor-day-latency",
  "monitor-day-incidents",
  "monitor-day-maintenances",
  "events-by-month",
]);

export const STANDBY_REFUSAL_MESSAGE =
  "This Kener instance is a read-only standby. Sign in and make changes on the primary.";

export function IsRefusedOnStandby(method: string, routeId: string | null, action?: string): boolean {
  if (routeId && CLOSED_GROUPS.some((group) => routeId.startsWith(group))) return true;
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  return !(routeId === DASHBOARD_ROUTE && action !== undefined && DASHBOARD_READS_BY_POST.has(action));
}

export function StandbyRefusal(request: Request): Response {
  const wantsHtml = request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml) {
    return new Response(STANDBY_REFUSAL_MESSAGE, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(JSON.stringify({ error: { code: "STANDBY", message: STANDBY_REFUSAL_MESSAGE } }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const standbyHandle: Handle = async ({ event, resolve }) => {
  if (!IsStandby()) return resolve(event);
  const response = IsRefusedOnStandby(event.request.method, event.route.id, event.params.action)
    ? StandbyRefusal(event.request)
    : await resolve(event);
  response.headers.set("X-Kener-Role", "standby");
  return response;
};
