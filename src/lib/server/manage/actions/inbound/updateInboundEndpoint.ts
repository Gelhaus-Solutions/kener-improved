import db from "$lib/server/db/db.js";
import { seal, secretHint } from "$lib/server/crypto/secretBox.js";
import {
  validateEndpointPatch,
  type EndpointFields,
  type ValidatedEndpointPatch,
} from "$lib/server/inbound/validate.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload extends EndpointFields {
  id?: number;
  name?: string;
  status?: string;
  /**
   * The shared secret the sender signs its body with, in the clear.
   *
   * Sealed here and never returned. An empty string clears it, which turns
   * signature checking off for this endpoint; absent leaves it alone, so saving
   * the form without retyping the secret does not silently remove it.
   */
  signing_secret?: string | null;
}

/**
 * H1. Edits a receiver.
 *
 * The provider is deliberately not editable. It decides how every payload is
 * read, and changing it on an endpoint that already has alert history would
 * reinterpret nothing retroactively while silently changing what the next
 * request means. Making a new endpoint is one click and leaves the old history
 * attached to the reading that produced it.
 */
export default {
  action: "updateInboundEndpoint",
  audit: { targetType: "inbound_endpoint" },
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new ActionError(400, "id is required");

    const endpoint = await db.getInboundEndpointById(id);
    if (!endpoint) throw new ActionError(404, "That endpoint does not exist");

    const patch: ValidatedEndpointPatch & {
      name?: string;
      status?: string;
      signing_secret_encrypted?: string | null;
      signing_secret_hint?: string | null;
    } = await validateEndpointPatch(data);

    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new ActionError(400, "A name is required");
      patch.name = name;
    }

    if (data.signing_secret !== undefined) {
      const secret = data.signing_secret === null ? "" : String(data.signing_secret).trim();
      if (secret === "") {
        patch.signing_secret_encrypted = null;
        patch.signing_secret_hint = null;
      } else {
        // Sealed rather than hashed, the opposite of the token: verifying a
        // signature means recomputing it, which means reading the secret back.
        patch.signing_secret_encrypted = seal(secret, "inbound_signing_secret");
        patch.signing_secret_hint = secretHint(secret);
      }
    }

    if (data.status !== undefined) {
      const status = String(data.status).toUpperCase();
      if (status !== "ACTIVE" && status !== "DISABLED") {
        throw new ActionError(400, "Status must be ACTIVE or DISABLED");
      }
      patch.status = status;
    }

    if (Object.keys(patch).length === 0) return { success: true, changed: 0 };
    const changed = await db.updateInboundEndpoint(id, patch);
    return { success: true, changed };
  },
} satisfies ActionDefinition<Payload>;
