import { json, type RequestHandler } from "@sveltejs/kit";
import { RegisterHeartbeat } from "$lib/server/controllers/monitorsController";
import { parseHeartbeatReport } from "$lib/server/services/heartbeatReport";

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST") return {};
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A job that posts its logs as plain text still counts as a heartbeat.
    return {};
  }
}

const handler: RequestHandler = async ({ params, request, url }) => {
  const { tag, secret } = params;

  if (!tag || !secret) {
    return json({ error: "Tag and secret are required" }, { status: 400 });
  }

  try {
    // B11. A job may report its own outcome alongside the ping.
    const report = parseHeartbeatReport(await readJsonBody(request), url.searchParams);
    const status = await RegisterHeartbeat(tag, secret, report);
    return json({ status });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
};

export const GET = handler;
export const POST = handler;
