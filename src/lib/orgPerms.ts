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

  // SLO targets and error budgets (F1a). Their own pair rather than folding
  // into `settings.*`: an SLO is a commitment about a service, and the people
  // who may edit site settings are not automatically the people who may restate
  // what the business promised. Reading is separate because the attainment
  // dashboard is something a wider group wants to watch.
  { id: "slo.read", permission_name: "View SLO targets, attainment and error budgets" },
  { id: "slo.write", permission_name: "Create, update, and delete SLO targets" },

  // Reporting: exports, incident metrics and scheduled delivery (F2, F3, F4).
  // Its own pair rather than folding into `slo.*` or `monitors.read`: a report is
  // the document handed to a customer or an auditor, and the people who may pull
  // one are routinely not the people who may change what is monitored. `write`
  // is only about schedules - running an export on demand is a read.
  { id: "reports.read", permission_name: "Run uptime and incident reports, and view report schedules" },
  { id: "reports.write", permission_name: "Create, update, and delete scheduled report delivery" },

  // Organisations (P4)
  // Remote probe agents (B1c). Their own pair rather than folding into
  // `monitors.*`, and the token is the reason. A probe is sent monitor
  // `type_data` with its secrets already resolved, so whoever may mint a probe
  // token may receive the credentials of every monitor they then assign to it.
  // Granting that to everybody who may edit a monitor would be an escalation
  // nobody chose, and it would be invisible: the monitor screen would look
  // exactly as it does now.
  { id: "probes.read", permission_name: "View remote probe agents and their assignments" },
  { id: "probes.write", permission_name: "Create, assign, and delete remote probe agents" },

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

  // Retention (F6c). A fork-invented action mapped onto the upstream settings
  // permission rather than a new one: it reads the retention policy and reports
  // what it would delete, and anybody who may read site settings may see that.
  // It writes nothing - the policy itself is still saved through `storeSiteData`,
  // which already requires `settings.write`.
  getRetentionStatus: "settings.read",

  // Monitor categories. A category is a value on a monitor, not an entity of its
  // own, so these reuse the monitor permissions rather than minting a pair.
  // Anyone who may edit a monitor may decide which section it appears in, and a
  // separate permission would have to be granted to every existing org before it
  // did anything (KENER-138).
  getCategories: "monitors.read",
  setMonitorCategory: "monitors.write",
  renameCategory: "monitors.write",
  deleteCategory: "monitors.write",

  // Remote probes (B1c). Reading the fleet opens the screen; everything that
  // mints a token, moves an agent between regions, or decides which monitors a
  // probe is handed is a write.
  getProbeFleet: "probes.read",
  createProbeAgent: "probes.write",
  updateProbeAgent: "probes.write",
  rotateProbeAgentToken: "probes.write",
  deleteProbeAgent: "probes.write",
  // B1e. The region's rule and a monitor's exception to it replaced the
  // per-agent assign/unassign pair. Both are the same permission: they decide
  // where a check runs, which is what `probes.write` has always meant.
  setProbeRegionRule: "probes.write",
  setMonitorRegionAssignment: "probes.write",

  // The merge cascade (B1d). Reading what a monitor's sources resolve to is a
  // read of the probe configuration; every level that changes how observations
  // become a published status is a write.
  //
  // `setMergePolicy` writes `site_data` and could have taken `settings.write`,
  // and deliberately does not: it decides what the public page says when
  // vantage points disagree, which is an operational judgement about monitoring
  // rather than a site setting. Whoever may run the fleet may decide how its
  // answers combine, and nobody gains that by being allowed to edit the footer.
  getMonitorMergePolicy: "probes.read",
  setMergePolicy: "probes.write",
  setRegionDefaults: "probes.write",
  setMonitorMergePolicy: "probes.write",

  // SLO targets (F1a).
  getSlaTargets: "slo.read",
  getSlaOverview: "slo.read",
  saveSlaTarget: "slo.write",
  deleteSlaTarget: "slo.write",

  // Reporting (F2, F3, F4).
  getReportOptions: "reports.read",
  getIncidentReport: "reports.read",
  getReportSchedules: "reports.read",
  saveReportSchedule: "reports.write",
  deleteReportSchedule: "reports.write",
  runReportScheduleNow: "reports.write",

  // G4. Custom domains are a property of a page, so they reuse the page
  // permissions that already exist upstream rather than inventing a pair. That
  // also keeps the upstream `allPerms.ts` untouched.
  // "Why is this page not green": a read of the page's own derivation, so it is
  // the same permission as reading the page.
  explainPageStatus: "pages.read",
  getPageDomains: "pages.read",
  savePageDomain: "pages.write",
  deletePageDomain: "pages.write",
  setPrimaryPageDomain: "pages.write",

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

  // Incident backfill (C7). Validation writes nothing and is a read; the import
  // itself creates incidents and rewrites historical uptime, which is as much a
  // write as anything in this codebase.
  validateIncidentBackfill: "incidents.read",
  backfillIncidents: "incidents.write",

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

  // The instance console (KENER-31). `null` here is not "authenticated is
  // enough": these three carry `superadmin: true` on their definitions, and the
  // pipeline enforces that immediately after `authorize`. They are listed with a
  // null permission because **no per-org permission could be the right answer** -
  // a permission id would be seeded into every org's role editor, and the first
  // tenant administrator to tick it would own the instance. The gate is
  // `users.is_owner`, which no screen and no role can grant. See
  // `instanceController.ts`.
  getInstanceOrgs: null,
  getInstanceOrgDetail: null,
  setInstanceOrgStatus: null,

  // The instance `site_data` layer (I3g), on the same gate and for a sharper
  // version of the same reason: these are the defaults every tenant inherits,
  // and `mfaPolicy` and `oidcSettings` decide how people log in to all of them.
  getInstanceDefaults: null,
  setInstanceDefault: null,

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

  // Monitor categories. `monitors.read` opens the screen because a category is a
  // property of a monitor; every button on it is gated on `monitors.write` by
  // its own action.
  "/(manage)/manage/app/categories": "monitors.read",

  // Remote probe agents (B1c). `probes.read` opens the screen; every button on
  // it is separately gated on `probes.write` by its own action.
  "/(manage)/manage/app/probes": "probes.read",

  // SLO targets and their attainment (F1a). `slo.read` opens the screen; every
  // button on it is separately gated on `slo.write` by its own action, the same
  // shape the webhooks screen uses.
  "/(manage)/manage/app/slo": "slo.read",

  // Reports (F2). `reports.read` opens the screen; the export endpoint beneath
  // it re-checks the same permission for itself, because a `+server.ts` never
  // runs the layout that consults this map.
  "/(manage)/manage/app/reports": "reports.read",

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

  // The backfill importer (C7). Nested under incidents, safe for the same reason
  // the postmortem editor is: the sibling segment is `[incident_id]`, a numeric
  // id, so a static `import` cannot shadow a real incident.
  "/(manage)/manage/app/incidents/import": "incidents.read",
};

/**
 * Manage routes gated on the **instance** tier rather than on a permission
 * (KENER-31).
 *
 * Kept apart from `ORG_ROUTE_PERMISSION_MAP` rather than given a sentinel value
 * in it, because they are answers to different questions and a map whose values
 * mean two things is a map somebody eventually reads wrong. `(manage)`'s layout
 * consults this set first; a route in it never reaches the permission map at all.
 *
 * The nav entry for these routes is filtered by the same fact, so a tenant's
 * administrator does not see a link that would 403.
 */
export const SUPERADMIN_ROUTES: ReadonlySet<string> = new Set(["/(manage)/manage/app/instance"]);

/** Permission ids the fork owns. Used by the seeds to tell them from upstream's. */
export const orgPermissionIds: ReadonlySet<string> = new Set(orgPermissions.map((p) => p.id));
