/**
 * Fork-owned permissions.
 *
 * `src/lib/allPerms.ts` is kept **byte-identical to upstream, forever**. It is
 * the file upstream edits whenever it adds an admin action, so it is the one
 * file whose upstream changes we most want to merge cleanly. Editing it would
 * make every sync conflict there, and the cost would be paid on exactly the
 * changes we most want for free.
 *
 * So fork permissions live here instead, and consumers merge the two. There are
 * exactly four consumers, all of them merging rather than choosing:
 *
 *   - `seeds/permissions.ts`        `[...permissions, ...orgPermissions]`
 *   - `seeds/roles.ts`              grants org permissions to `admin`
 *   - `manage/middleware/authorize` `{...ACTION_PERMISSION_MAP, ...ORG_ACTION_PERMISSION_MAP}`
 *   - `(manage)/+layout.server.ts`  and its `.svelte` counterpart, for routes
 *
 * Most of these are placeholders for phases that have not landed. Seeding them
 * early is deliberate: it lets an operator build roles that grant them before
 * the feature ships, rather than having to revisit every role afterwards.
 */

export const orgPermissions: Array<{ id: string; permission_name: string }> = [
  // Audit log (P1)
  { id: "audit.read", permission_name: "View the audit log" },

  // Sessions (P3)
  { id: "sessions.admin", permission_name: "View and revoke other users' sessions" },

  // Event bus and outbound webhooks (P2)
  { id: "webhooks.read", permission_name: "View outbound webhooks and their delivery log" },
  { id: "webhooks.write", permission_name: "Create, update, and delete outbound webhooks" },

  // Organisations (P4)
  { id: "orgs.read", permission_name: "View organisation settings" },
  { id: "orgs.write", permission_name: "Create and update organisations" },
  { id: "orgs.members.read", permission_name: "View organisation members" },
  { id: "orgs.members.write", permission_name: "Add, update, and remove organisation members" },
];

/**
 * Action to permission, for fork-invented admin actions.
 *
 * Entries land here as the phases above add actions, and never in
 * `allPerms.ts`. `getAuditLog` is the first: it is a fork-invented action, so
 * upstream's map does not and should not know about it.
 */
export const ORG_ACTION_PERMISSION_MAP: Record<string, string | null> = {
  getAuditLog: "audit.read",

  // Outbound webhooks (E10). The delivery log is a read; everything that can
  // change where events are sent, or cause a send, is a write.
  getWebhookEndpoints: "webhooks.read",
  getWebhookDeliveries: "webhooks.read",
  createWebhookEndpoint: "webhooks.write",
  updateWebhookEndpoint: "webhooks.write",
  deleteWebhookEndpoint: "webhooks.write",
  rotateWebhookEndpointSecret: "webhooks.write",
  // A test causes an outbound request to a URL the caller chose, so it is a
  // write even though it changes nothing in the database.
  testWebhookEndpoint: "webhooks.write",
  retryWebhookDelivery: "webhooks.write",
};

/**
 * Route to permission, for fork-invented manage routes.
 *
 * The audit log UI is the first entry, gated on `audit.read`.
 */
export const ORG_ROUTE_PERMISSION_MAP: Record<string, string | null> = {
  "/(manage)/manage/app/audit": "audit.read",
};

/** Permission ids the fork owns. Used by the seeds to tell them from upstream's. */
export const orgPermissionIds: ReadonlySet<string> = new Set(orgPermissions.map((p) => p.id));
