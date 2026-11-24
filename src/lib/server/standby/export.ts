import crypto from "node:crypto";
import db from "../db/db.js";
import { GetNowTimestampUTC } from "../tool.js";
import { IsStandby, StandbyToken } from "./config.js";
import { DecodeCursor, type StandbyExportPage } from "./tables.js";
import type { StandbyExportRequest } from "../db/repositories/standby.js";

/** Constant time whatever the lengths: both sides are hashed first. */
export function TokenMatches(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = crypto.createHash("sha256").update(presented, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

export function BearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1] : null;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function unauthorized(message: string): Response {
  return jsonResponse(401, { error: { code: "UNAUTHORIZED", message } }, { "www-authenticate": "Bearer" });
}

function badRequest(message: string): Response {
  return jsonResponse(400, { error: { code: "BAD_REQUEST", message } });
}

/**
 * GET /ext/standby/export: what a standby needs to serve the public page.
 *
 * Read-only, behind `KENER_STANDBY_TOKEN`. Without the variable, and on a
 * standby, the route does not exist.
 */
export async function HandleStandbyExport(
  request: Request,
  url: URL,
  build: (req: StandbyExportRequest) => Promise<StandbyExportPage> = (req) => db.exportStandbyPage(req),
): Promise<Response> {
  const token = StandbyToken();
  if (!token || IsStandby()) return new Response("Not Found", { status: 404 });

  const presented = BearerToken(request.headers.get("authorization"));
  if (!presented) return unauthorized("Missing bearer token");
  if (!TokenMatches(presented, token)) return unauthorized("Invalid token");

  const sinceRaw = url.searchParams.get("since") ?? "0";
  if (!/^\d{1,10}$/.test(sinceRaw)) return badRequest("since must be UTC seconds");
  const afterRaw = url.searchParams.get("after");
  const after = afterRaw === null ? null : DecodeCursor(afterRaw);
  if (afterRaw !== null && after === null) return badRequest("after is not a cursor this instance issued");
  const images = url.searchParams.get("images");
  if (images !== null && !/^[0-9a-f]{0,64}$/.test(images)) return badRequest("images must be a fingerprint");

  const page = await build({
    since: Number(sinceRaw),
    after,
    imagesFingerprint: images || null,
    nowSeconds: GetNowTimestampUTC(),
  });
  return jsonResponse(200, page);
}
