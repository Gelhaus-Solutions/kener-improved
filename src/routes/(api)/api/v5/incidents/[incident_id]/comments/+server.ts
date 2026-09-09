import { json, type RequestHandler } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import { AddIncidentComment } from "$lib/server/controllers/controller.js";
import { apiError } from "$lib/server/api/v5/incidents.js";
import GC from "$lib/global-constants";

const VALID_STATES: string[] = [GC.INVESTIGATING, GC.IDENTIFIED, GC.MONITORING, GC.RESOLVED];

export const GET: RequestHandler = async ({ params }) => {
  const comments = await db.getIncidentComments(Number(params.incident_id));
  return json({
    comments: comments.map((c) => ({
      id: c.id,
      comment: c.comment,
      state: c.state,
      commented_at: c.commented_at,
      status: c.status,
    })),
  });
};

interface PostBody {
  comment?: string;
  state?: string;
  commented_at?: number;
}

export const POST: RequestHandler = async ({ params, request }) => {
  let body: PostBody;
  try {
    body = await request.json();
  } catch {
    return json(apiError("BAD_REQUEST", "Invalid JSON body"), { status: 400 });
  }

  if (!body.comment || typeof body.comment !== "string" || body.comment.trim() === "") {
    return json(apiError("BAD_REQUEST", "comment is required"), { status: 400 });
  }
  if (body.state && !VALID_STATES.includes(body.state)) {
    return json(apiError("BAD_REQUEST", `state must be one of: ${VALID_STATES.join(", ")}`), { status: 400 });
  }

  const commentedAt = Number.isFinite(body.commented_at)
    ? Number(body.commented_at)
    : Math.floor(Date.now() / 1000);

  // `AddIncidentComment` is the single choke point: it inserts the comment,
  // emits `incident.comment_added`, moves the incident's state and stamps the
  // C2c lifecycle from `commented_at`. v4's equivalent does the first and none
  // of the rest.
  const created = await AddIncidentComment(
    Number(params.incident_id),
    body.comment.trim(),
    body.state ?? "",
    commentedAt,
  );

  return json(
    {
      comment: {
        id: created.id,
        comment: created.comment,
        state: created.state,
        commented_at: created.commented_at,
        status: created.status,
      },
    },
    { status: 201 },
  );
};
