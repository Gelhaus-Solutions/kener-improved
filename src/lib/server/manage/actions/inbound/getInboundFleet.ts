import db from "$lib/server/db/db.js";
import { COMPONENT_IMPACTS, INCIDENT_SEVERITIES } from "$lib/server/incidents/impact.js";
import { INBOUND_PROVIDERS, TEMPLATED_PROVIDERS } from "$lib/server/inbound/types.js";
import { parseMappingRules } from "$lib/server/inbound/mapping.js";
import type { ActionDefinition } from "../../types.js";

/**
 * H1. Everything the inbound alerts screen draws, in one call.
 *
 * `token_hash` and `signing_secret_encrypted` are deliberately not returned.
 * They are the two fields on this table that are credentials, the screen has no
 * use for either, and an admin action that hands them to a browser would undo
 * the reason they are hashed and sealed in the first place.
 */
export default {
  action: "getInboundFleet",
  handler: async () => {
    const [endpoints, alerts, monitors] = await Promise.all([
      db.getInboundEndpoints(),
      db.getRecentInboundAlerts(100),
      db.getMonitors({ status: "ACTIVE" }),
    ]);

    return {
      endpoints: endpoints.map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        provider: endpoint.provider,
        token_hint: endpoint.token_hint,
        status: endpoint.status,
        default_monitor_tag: endpoint.default_monitor_tag,
        mapping_rules: parseMappingRules(endpoint.mapping_rules),
        default_impact: endpoint.default_impact,
        default_severity: endpoint.default_severity,
        auto_resolve: endpoint.auto_resolve === true || endpoint.auto_resolve === 1,
        last_request_at: endpoint.last_request_at,
        last_success_at: endpoint.last_success_at,
        last_failure_at: endpoint.last_failure_at,
        last_error: endpoint.last_error,
      })),
      alerts: alerts.map((alert) => ({
        id: alert.id,
        endpoint_id: alert.endpoint_id,
        fingerprint: alert.fingerprint,
        status: alert.status,
        monitor_tag: alert.monitor_tag,
        incident_id: alert.incident_id,
        severity: alert.severity,
        title: alert.title,
        last_seen_at: alert.last_seen_at,
        notification_count: alert.notification_count,
      })),
      monitors: monitors.map((monitor: { tag: string; name: string }) => ({ tag: monitor.tag, name: monitor.name })),
      providers: INBOUND_PROVIDERS,
      templated_providers: TEMPLATED_PROVIDERS,
      impacts: COMPONENT_IMPACTS,
      severities: INCIDENT_SEVERITIES,
    };
  },
} satisfies ActionDefinition<Record<string, never>>;
