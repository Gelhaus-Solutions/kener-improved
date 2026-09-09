import { json, type RequestHandler } from "@sveltejs/kit";
import {
  GetPostmortemByIncident,
  SavePostmortem,
  DeletePostmortem,
  isTimelineSource,
} from "$lib/server/incidents/postmortem.js";
import { serializePostmortem, apiError } from "$lib/server/api/v5/incidents.js";
import type { PostmortemInput } from "$lib/server/types/postmortem.js";

/**
 * The incident's postmortem (C1).
 *
 * PUT rather than POST plus PATCH, because the UNIQUE on `incident_id` means
 * there is exactly one and its address is known before it exists. A client that
 * had to know whether it was creating or editing would get it wrong the first
 * time two of them ran at once.
 *
 * **This route never publishes.** Publishing is `POST .../postmortem/publish`,
 * so nothing can make a document public as a side effect of writing to it.
 */
export const GET: RequestHandler = async ({ params }) => {
  const postmortem = await GetPostmortemByIncident(Number(params.incident_id));
  if (!postmortem) return json(apiError("NOT_FOUND", "This incident has no postmortem"), { status: 404 });
  return json({ postmortem: serializePostmortem(postmortem) });
};

interface PutBody extends Omit<PostmortemInput, "notify_subscribers"> {
  notify_subscribers?: boolean;
}

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  let body: PutBody;
  try {
    body = await request.json();
  } catch {
    return json(apiError("BAD_REQUEST", "Invalid JSON body"), { status: 400 });
  }

  if (body.timeline_source !== undefined && !isTimelineSource(body.timeline_source)) {
    return json(apiError("BAD_REQUEST", "timeline_source must be COMMENTS or CUSTOM"), { status: 400 });
  }

  // An API key has no user behind it, so authorship is recorded as 0 rather than
  // as a fabricated user id. A postmortem written by an integration genuinely has
  // no human author, and inventing one would put a name on a document nobody
  // wrote.
  const authorId = locals.user?.id ?? 0;

  try {
    const saved = await SavePostmortem(
      Number(params.incident_id),
      {
        ...body,
        notify_subscribers: body.notify_subscribers === undefined ? undefined : body.notify_subscribers ? "YES" : "NO",
      },
      authorId,
    );
    return json({ postmortem: serializePostmortem(saved) });
  } catch (e) {
    return json(apiError("BAD_REQUEST", e instanceof Error ? e.message : "Could not save the postmortem"), {
      status: 400,
    });
  }
};

export const DELETE: RequestHandler = async ({ params }) => {
  const result = await DeletePostmortem(Number(params.incident_id));
  if (!result.success) return json(apiError("NOT_FOUND", "This incident has no postmortem"), { status: 404 });
  return new Response(null, { status: 204 });
};
