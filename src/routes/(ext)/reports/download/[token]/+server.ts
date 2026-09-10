import { error, type RequestHandler } from "@sveltejs/kit";
import { Readable } from "node:stream";
import db from "$lib/server/db/db";
import { runWithOrg } from "$lib/server/db/orgContext";
import { GetNowTimestampUTC } from "$lib/server/tool";
import { readArtifactStream } from "$lib/server/reports/artifactStore";

/**
 * GET /reports/download/{token}
 *
 * The download link mailed by a scheduled report (F4).
 *
 * **Deliberately unauthenticated, and the token is the credential.** Recipients
 * are auditors and customers with no Kener account; requiring a session would
 * make the feature useless for the people it exists for. The token is 32 random
 * bytes, unique across the table, and dead after `expires_at`.
 *
 * It lives outside `/api/` on purpose: `hooks.server.ts` rejects everything
 * under that prefix without a bearer token, which is exactly right for the admin
 * API and exactly wrong here.
 *
 * **The token determines the org**, so the lookup is unscoped and then enters
 * the row's organisation before reading anything else - the same shape as
 * `AuthenticateAPIKey`, and for the same reason: scoping the lookup would mean
 * deciding the answer before asking the question.
 *
 * **An expired link says so.** Returning 404 for an expiry would send a customer
 * to ask whether the report was ever sent; 410 Gone with a clear message tells
 * them to request a fresh one.
 */
export const GET: RequestHandler = async ({ params }) => {
  const token = params.token ?? "";
  // Cheap shape check before touching the database, so a scanner hitting this
  // path with rubbish costs a string comparison rather than a query.
  if (token.length < 20 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw error(404, "No such report");
  }

  const artifact = await db.getArtifactByToken(token);
  if (!artifact) throw error(404, "No such report");

  if (artifact.expires_at <= GetNowTimestampUTC()) {
    throw error(410, "This report link has expired. Ask for a fresh copy.");
  }

  const stream = await runWithOrg(artifact.org_id, async () => await readArtifactStream(artifact.storage_key));
  if (!stream) {
    // The row outliving its file is expected: a restored volume, or a sweep
    // racing a download. It is a 404 rather than a 500 because nothing is broken.
    throw error(404, "This report is no longer available");
  }

  return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
    headers: {
      "content-type": artifact.content_type,
      // The filename is generated from the schedule name and is already
      // sanitised; quoting it keeps a space from truncating the header.
      "content-disposition": `attachment; filename="${artifact.filename.replace(/"/g, "")}"`,
      "content-length": String(artifact.size_bytes),
      // A link anyone holding the URL can open must never sit in a shared cache.
      "cache-control": "no-store, private",
      // The token is in the path, so a referrer header would leak the credential
      // to any host the reader navigates to next.
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
};
