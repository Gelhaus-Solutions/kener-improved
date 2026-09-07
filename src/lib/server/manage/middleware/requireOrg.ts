import type { ActionContext } from "../types.js";

/**
 * Asserts the caller belongs to the org this request targets, **and** establishes
 * the org context the rest of the request runs in.
 *
 * Those two things are one function on purpose. If establishing the context were
 * separate from checking membership, there would exist an ordering in which code
 * gets a usable org context without the check having run, and that ordering
 * eventually gets written. Keeping them fused means the context cannot be
 * obtained without being entitled to it.
 *
 * Position in the pipeline is equally deliberate: this runs **before** validation
 * and before the audit before-snapshot, because a snapshot query issued without
 * an org context reads across tenants.
 *
 * Today this is a no-op. Kener is single-tenant until P4 introduces orgs, so
 * there is nothing to assert and nothing to establish. The seam exists now so
 * that P4 fills in one function rather than threading a new step through a
 * pipeline that was not built to expect it.
 */
export async function requireOrg(_ctx: ActionContext): Promise<void> {
  // P4: resolve the target org, assert membership, and run the remainder of the
  // request inside the org's AsyncLocalStorage context.
  return;
}
