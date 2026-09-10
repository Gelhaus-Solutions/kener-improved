import db from "$lib/server/db/db.js";
import { invalidateOrgDomainCache } from "$lib/server/http/orgResolve.js";
import { normalizeHostname } from "$lib/server/http/hostname.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

interface SavePageDomainPayload {
  id?: number;
  page_id?: number;
  hostname?: string;
  status?: string;
  is_primary?: string;
}

/**
 * G4. Adds a custom domain to a page, or updates one.
 *
 * **The hostname is normalised, not merely trimmed.** Operators paste
 * `https://status.acme.com/` from a browser bar, and a stored value with a
 * scheme or a trailing slash would never match the `Host` header and the domain
 * would simply never work, with nothing to indicate why.
 *
 * The uniqueness check is explicit rather than left to the UNIQUE constraint so
 * the operator gets "that hostname is already in use" instead of a driver error,
 * and because the constraint cannot see `org_domains` - a hostname claimed there
 * would otherwise be accepted here and then resolve ambiguously.
 */
export default {
  action: "savePageDomain",
  handler: async (data: LegacyPayload) => {
    const payload = data as SavePageDomainPayload;

    if (payload.id) {
      const existing = await db.getPageDomainById(Number(payload.id));
      // Scoped read: another org's id simply is not found.
      if (!existing) throw new Error("Domain not found");
      await db.updatePageDomain(Number(payload.id), {
        status: payload.status,
        is_primary: payload.is_primary,
        verified_at: payload.status === "ACTIVE" ? Math.floor(Date.now() / 1000) : undefined,
      });
      invalidateOrgDomainCache();
      return { id: Number(payload.id) };
    }

    const pageId = Number(payload.page_id);
    if (!Number.isFinite(pageId)) throw new Error("page_id is required");

    const hostname = normalizeHostname(payload.hostname ?? "");
    if (!hostname) throw new Error("A valid hostname is required");

    if (await db.hostnameExists(hostname)) throw new Error("That hostname is already in use");

    const id = await db.createPageDomain({
      page_id: pageId,
      hostname,
      status: payload.status ?? "PENDING",
      is_primary: payload.is_primary ?? "NO",
    });
    invalidateOrgDomainCache();
    return { id };
  },
} satisfies ActionDefinition<LegacyPayload>;
