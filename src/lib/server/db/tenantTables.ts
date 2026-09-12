/**
 * The tables `BaseRepository.table()` scopes to the current organisation.
 *
 * Authoritative. A table in here gets `where org_id = ?` applied automatically
 * and throws without a context; a table not in here is queried as-is. Both
 * mistakes are possible, so the two lists below say what each omission means.
 *
 * Kept as a plain set rather than derived from the schema at runtime: a startup
 * introspection would make the security boundary depend on whatever the database
 * happens to look like, and a column added by a half-applied migration would
 * silently change what is enforced.
 */

/**
 * Tables where a row belongs to exactly one org.
 *
 * Every one of these carries `org_id`. Adding a tenant table to the schema and
 * forgetting it here is the dangerous direction: queries against it are then
 * unscoped and cross-tenant, with nothing to notice.
 */
export const TENANT_TABLES: ReadonlySet<string> = new Set([
  // Owner tables
  "monitors",
  "pages",
  "incidents",
  "maintenances",
  "triggers",
  "api_keys",
  "images",
  "general_email_templates",
  "site_data",
  "subscriber_users",
  "roles",
  "monitor_alerts_config",
  "invitations",
  "oidc_group_role_mappings",

  // Junctions, which carry a denormalized org_id (see phase 1's migration)
  "pages_monitors",
  "incident_monitors",
  "incident_comments",
  "maintenance_monitors",
  "maintenances_events",
  "monitor_alerts_config_triggers",
  "monitor_alerts_config_monitors",
  "monitor_alerts_v2",
  "subscriber_methods",
  "user_subscriptions_v2",
  "users_roles",
  "roles_permissions",

  // Fork-added, org-aware from the day they were built
  //
  // `regions` is the one row-level exception in this whole set: id 0, the merged
  // verdict, carries a null `org_id` because it belongs to the instance rather
  // than to a tenant. A scoped read therefore never returns it, which is
  // correct - region 0 is a constant (`db/regions.ts`), not something to look up.
  "regions",
  "subscriber_subscriptions",
  "component_dependencies",
  // G4. Per-page custom domains. A tenant table, unlike `org_domains`, which is
  // how the org is *found* and therefore cannot be scoped by one: by the time
  // anything reads `page_domains` for management the org is already established.
  // The public resolution path reads it under `runAcrossOrgs`, deliberately and
  // in one place - see `http/orgResolve.ts`.
  "page_domains",
  "monitor_rollup_settings",
  "monitor_rollup_5m",
  "monitor_rollup_15m",
  "monitor_rollup_1h",
  "monitor_rollup_1d",
  "rollup_state",
  "rollup_dirty",
  "incident_postmortems",
  "incident_templates",
  "audit_log",
  "event_outbox",
  "event_deliveries",
  "webhook_endpoints",
  "sla_targets",
  "sla_evaluations",
  "report_schedules",
  "report_artifacts",

  // B1b. Remote probes. `probe_agents` holds one org's agents; the assignment
  // side table says which monitors are checked from each region.
  "probe_agents",
  "monitor_probe_assignments",

  // B1e. What a region checks by default, and the per-monitor include/exclude
  // that the resolved assignments above are computed from.
  "probe_region_rules",
  "monitor_region_overrides",

  // B1d. The merge cascade's two override levels. Both exist only for a monitor
  // that overrides something, so they are small and usually empty.
  "monitor_merge_policies",
  "monitor_source_policies",

  // The big one. Scoped like the rest even though `monitor_tag` is globally
  // unique, because "it is safe by accident" is not a property to rely on.
  "monitoring_data",
]);

/**
 * Tables that are deliberately instance-wide, and why.
 *
 * Documented rather than merely absent, so that the next person adding a table
 * has to make the same decision explicitly instead of defaulting into it. This
 * list is not consulted at runtime; it exists to be read.
 *
 *   users            - a person is one identity across every org they belong to,
 *                      which is what makes `users.email` globally unique and what
 *                      lets the org switcher exist at all. Membership, and
 *                      therefore access, lives in `org_members`.
 *   sessions         - belongs to a user, and carries `active_org_id` to say
 *                      which org that user is currently acting in. Scoping the
 *                      session table by org would make it impossible to find the
 *                      session that decides the org.
 *   permissions      - the vocabulary of what can be done. Shared by every org;
 *                      `roles_permissions` is where the per-org grants live.
 *   orgs             - the tenants themselves.
 *   org_members      - resolved to *find* the org, so it cannot be scoped by it.
 *   org_domains      - same: the hostname is what discriminates the tenant.
 *   user_mfa*        - a second factor belongs to the person, not the tenant.
 *   knex_migrations* - schema bookkeeping.
 */
export const INSTANCE_TABLES: ReadonlySet<string> = new Set([
  "users",
  "sessions",
  "permissions",
  "orgs",
  "org_members",
  "org_domains",
  "knex_migrations",
  "knex_migrations_lock",
]);

/** Whether queries against `table` are automatically scoped to the current org. */
export function isTenantTable(table: string): boolean {
  return TENANT_TABLES.has(table);
}
