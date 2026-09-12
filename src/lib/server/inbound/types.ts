/**
 * H1. The one shape every inbound alert is reduced to.
 *
 * **Everything downstream reads this and never a provider's payload.** The
 * receiver, the mapping rules, the incident it opens and the screen that
 * explains what happened all speak this language, so adding a provider is a
 * parser and nothing else. The moment one of them needs to know whether the
 * alert came from Alertmanager or Sentry, a provider has leaked past the parser
 * and the next one will have to leak the same way.
 */

export const INBOUND_PROVIDERS = [
  "ALERTMANAGER",
  "GRAFANA",
  "SENTRY",
  "CLOUDWATCH",
  "UPTIME_KUMA",
  "GENERIC",
] as const;

export type InboundProvider = (typeof INBOUND_PROVIDERS)[number];

/**
 * Providers whose payload shape Kener does not control, and does not pretend to.
 *
 * Datadog, Zabbix and Checkmk all send a payload the *operator* composes in
 * their own templating language: there is no fixed schema to parse, and a
 * "native Datadog receiver" would really be a parser for one person's template
 * that breaks the moment somebody edits it. So they use `GENERIC` and paste a
 * documented template, which is both honest and more robust than guessing.
 */
export const TEMPLATED_PROVIDERS = ["Datadog", "Zabbix", "Checkmk"] as const;

/** Whether an alert is currently a problem, or has cleared. */
export type AlertStatus = "FIRING" | "RESOLVED";

/** One alert, as Kener understands it. */
export interface NormalisedAlert {
  /**
   * The sender's identity for this alert, stable across re-notifications.
   *
   * This is the idempotency key, and the difference between one incident and an
   * incident per notification. A provider that supplies its own (Alertmanager)
   * has it used verbatim; one that does not gets a derived hash of whatever
   * fields identify the alert, so the guarantee is the same everywhere.
   */
  fingerprint: string;
  status: AlertStatus;
  /** The provider's own severity word, kept raw. Mapped to Kener's later. */
  severity: string | null;
  title: string;
  description: string | null;
  /** Whatever the provider called its dimensions. Mapping rules match on these. */
  labels: Record<string, string>;
  /** When the sender says the alert began, in UTC seconds. Null if it did not say. */
  startsAt: number | null;
}

/**
 * What a parser returns.
 *
 * A list because several providers batch: one Alertmanager notification
 * routinely carries every alert in a group, and treating that as one alert would
 * collapse distinct problems into a single incident.
 */
export type ParsedPayload = NormalisedAlert[];
