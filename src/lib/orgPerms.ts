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

  // Sessions (P3). Reading and revoking your *own* sessions needs no permission
  // at all: a user must always be able to see whether somebody else is using
  // their account. This one is only for acting on somebody else's.
  { id: "sessions.admin", permission_name: "View and revoke other users' sessions" },

  // Event bus and outbound webhooks (P2)
  { id: "webhooks.read", permission_name: "View outbound webhooks and their delivery log" },
  { id: "webhooks.write", permission_name: "Create, update, and delete outbound webhooks" },

  // Event bus consumers (H8c). Separate from `webhooks.*` on purpose: reading
  // the delivery log is an everyday operational act, while changing what a
  // consumer is allowed to do decides whether customer notifications are sent at
  // all. Those do not belong to the same person by default.
  { id: "eventbus.read", permission_name: "View event bus consumers and the shadow diff" },
  { id: "eventbus.write", permission_name: "Change what event bus consumers are allowed to do" },

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

  // Incidents (C2c). A fork-invented action on an upstream resource, so it maps
  // to the upstream permission rather than inventing one: acknowledging is
  // acting on an incident, and anybody who may comment on one may take it.
  acknowledgeIncident: "incidents.write",
  getIncidentMetrics: "incidents.read",

  // Postmortems (C1). Deliberately mapped onto the *incident* permissions rather
  // than a new pair. A postmortem is the incident's published account of itself,
  // and inventing `postmortems.write` would mean every existing role that can
  // communicate about incidents silently could not write the postmortem - a
  // permission nobody had been told to grant, discovered during an outage.
  //
  // Publishing is arguably the stronger act and could carry its own grant. It
  // does not, for now, because splitting it would need somebody to decide who
  // holds it, and a split nobody configures is a split that only ever denies.
  getPostmortem: "incidents.read",
  savePostmortem: "incidents.write",
  publishPostmortem: "incidents.write",
  unpublishPostmortem: "incidents.write",
  deletePostmortem: "incidents.write",

  // Incident templates (C4). Same call as postmortems: a template is incident
  // communication written in advance, so it reuses the incident permissions.
  // `applyIncidentTemplate` is a *read* - it renders a preview and writes
  // nothing - and mapping it to `incidents.write` would mean somebody who may
  // look at incidents but not open one could not see what a template would
  // produce, which is the wrong side of the line.
  getIncidentTemplates: "incidents.read",
  applyIncidentTemplate: "incidents.read",
  saveIncidentTemplate: "incidents.write",
  deleteIncidentTemplate: "incidents.write",
  noteIncidentTemplateUsed: "incidents.write",

  // Component dependencies (C3). Reading the graph is part of reading monitors;
  // editing it is monitor configuration, so both reuse the upstream monitor
  // permissions rather than inventing a pair nobody would think to grant.
  getMonitorDependencies: "monitors.read",
  getDependencyGraph: "monitors.read",

  // Outbound webhooks (E10). The delivery log is a read; everything that can
  // change where events are sent, or cause a send, is a write.
  getWebhookEndpoints: "webhooks.read",
  createWebhookEndpoint: "webhooks.write",
  updateWebhookEndpoint: "webhooks.write",
  deleteWebhookEndpoint: "webhooks.write",
  rotateWebhookEndpointSecret: "webhooks.write",
  // A test causes an outbound request to a URL the caller chose, so it is a
  // write even though it changes nothing in the database.
  testWebhookEndpoint: "webhooks.write",

  // The delivery log (E9). Not webhook-specific: one screen covers every
  // outbound channel, because they all write to event_deliveries.
  getEventDeliveries: "webhooks.read",
  retryEventDelivery: "webhooks.write",
  retryDeliveriesForTarget: "webhooks.write",

  // Organisations (I3f). Reading the org and its domains is `orgs.read`;
  // anything that changes how it is reached, or who may act in it, is a write.
  //
  // `switchOrg` is deliberately `null`: membership is the check, and it is made
  // against `org_members` rather than against a role. A permission would have to
  // be granted per org, so gating on one would let a user be a member of an org
  // they could not switch into.
  switchOrg: null,
  getOrganisation: "orgs.read",
  updateOrganisation: "orgs.write",
  createOrganisation: "orgs.write",
  addOrgDomain: "orgs.write",
  removeOrgDomain: "orgs.write",
  getOrgMembers: "orgs.members.read",
  addOrgMember: "orgs.members.write",
  setOrgMemberOwner: "orgs.members.write",
  removeOrgMember: "orgs.members.write",

  // Event bus consumers (H8c). The diff is a read of what would have been sent;
  // the mode is the switch that decides whether anything is sent at all.
  getEventConsumers: "eventbus.read",
  getShadowDiff: "eventbus.read",
  setEventConsumerMode: "eventbus.write",

  // Sessions (A9). `null` means authenticated-is-enough: these two are scoped to
  // the caller's own sessions by construction, taking the user id from the
  // resolved session rather than from the payload.
  getMySessions: null,
  revokeMySession: null,
  // Acting on somebody else's sessions is the one that needs a permission.
  revokeUserSessions: "sessions.admin",

  // API keys (A10). Both are fork-invented actions, so upstream's map does not
  // know them. Rotation and revocation are `api_keys.write` rather than
  // `api_keys.delete`: neither destroys the record, and cutting a rotation's
  // grace window short must not require the strongest permission in the group.
  rotateApiKey: "api_keys.write",
  revokeApiKey: "api_keys.write",

  // MFA (A2). All self-scoped, all taking the user id from the session. The
  // sensitive ones are guarded by the current password rather than by a
  // permission: this is about proving who is at the keyboard, not what role they
  // hold, and an admin must not be able to enrol a factor on somebody else.
  getMfaStatus: null,
  beginMfaEnrolment: null,
  confirmMfaEnrolment: null,
  disableMfa: null,
  regenerateRecoveryCodes: null,

  // A2b. Unlike the five above these are *not* self-scoped: they read and change
  // what the whole instance requires, so both carry a real permission. Coverage
  // is a property of the user list, and the policy is a site setting.
  getMfaCoverage: "users.read",
  setMfaPolicy: "settings.write",
};

/**
 * Route to permission, for fork-invented manage routes.
 *
 * The audit log UI is the first entry, gated on `audit.read`.
 */
export const ORG_ROUTE_PERMISSION_MAP: Record<string, string | null> = {
  "/(manage)/manage/app/audit": "audit.read",
  // Reading the list is enough to reach the screen; every button on it is
  // separately gated on webhooks.write by its action.
  "/(manage)/manage/app/webhooks": "webhooks.read",
  "/(manage)/manage/app/webhooks/deliveries": "webhooks.read",
  // Same shape: the screen opens on read, and the mode control on it is gated
  // on eventbus.write by its own action.
  "/(manage)/manage/app/webhooks/event-consumers": "eventbus.read",

  // I3f moved four upstream screens under a parent so they could share one
  // sidebar entry and one tab bar. Their new route ids are declared here rather
  // than in `allPerms.ts`, which stays byte-identical to upstream; upstream's
  // entries for the old paths are left in place and are simply never matched.
  "/(manage)/manage/app/site-configurations/analytics-providers": "settings.read",
  "/(manage)/manage/app/site-configurations/captcha-providers": "settings.read",
  "/(manage)/manage/app/share/badges": "settings.read",
  "/(manage)/manage/app/share/embed": "settings.read",

  // Organisations (I3f). `orgs.read` opens the screen; the member list and every
  // button on it are separately gated by their own actions.
  "/(manage)/manage/app/organisations": "orgs.read",

  // The dependency graph view (C3). Read-only; every edit happens on the
  // monitor's own page and is gated by its action. Deliberately NOT under
  // `/monitors/`, where a static segment would shadow a monitor whose tag
  // happened to be "dependencies".
  "/(manage)/manage/app/dependencies": "monitors.read",

  // The postmortem editor (C1). Nested under the incident it belongs to, which
  // is safe here in a way it would not be under `/monitors/`: the segment before
  // it is `[incident_id]`, a numeric id, so a static `postmortem` sibling cannot
  // shadow anything. Opening it needs only `incidents.read`; every button on it
  // is gated on `incidents.write` by its own action.
  "/(manage)/manage/app/incidents/[incident_id]/postmortem": "incidents.read",

  // The incident template manager (C4). A sibling of `/incidents/` rather than a
  // child, because `/manage/app/templates` is already the email template editor
  // and moving an unrelated existing screen to free the name would be a bigger
  // change than the feature.
  "/(manage)/manage/app/incident-templates": "incidents.read",
};

/** Permission ids the fork owns. Used by the seeds to tell them from upstream's. */
export const orgPermissionIds: ReadonlySet<string> = new Set(orgPermissions.map((p) => p.id));
