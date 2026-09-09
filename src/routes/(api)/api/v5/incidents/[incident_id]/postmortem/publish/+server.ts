import { json, type RequestHandler } from "@sveltejs/kit";
import { PublishPostmortem, UnpublishPostmortem } from "$lib/server/incidents/postmortem.js";
import { serializePostmortem, apiError } from "$lib/server/api/v5/incidents.js";

/**
 * Publish and withdraw, as their own endpoint.
 *
 * Separated from the PUT that writes the document so that publication is always
 * a deliberate act with its own request, its own scope check and its own event.
 * A flag on the write would mean an integration could make a draft public by
 * sending one field it did not mean to send.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  try {
    const published = await PublishPostmortem(Number(params.incident_id), locals.user?.id ?? 0);
    return json({ postmortem: serializePostmortem(published) });
  } catch (e) {
    return json(apiError("BAD_REQUEST", e instanceof Error ? e.message : "Could not publish"), { status: 400 });
  }
};

/**
 * Withdraws it. `?archive=true` marks it withdrawn rather than returning it to a
 * draft; the publication date survives either way, because an unpublish does not
 * un-happen.
 */
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
  try {
    const result = await UnpublishPostmortem(
      Number(params.incident_id),
      locals.user?.id ?? 0,
      url.searchParams.get("archive") === "true",
    );
    return json({ postmortem: serializePostmortem(result) });
  } catch (e) {
    return json(apiError("BAD_REQUEST", e instanceof Error ? e.message : "Could not withdraw"), { status: 400 });
  }
};
