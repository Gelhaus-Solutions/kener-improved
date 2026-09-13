import GC from "$lib/global-constants";

type AlertTextKind = "label" | "help" | "description";

interface AlertTextInput {
  kind: AlertTextKind;
  alert_for: string;
  alert_value?: string | number;
  failure_threshold?: number;
  success_threshold?: number;
}

export function getAlertText({
  kind,
  alert_for,
  alert_value,
  failure_threshold,
  success_threshold,
}: AlertTextInput): string {
  if (kind === "label") {
    switch (alert_for) {
      case GC.STATUS:
        return "Status Value";
      case GC.LATENCY:
        return "Latency Threshold (ms)";
      case GC.UPTIME:
        return "Uptime Threshold (%)";
      case GC.CERT_EXPIRY:
        return "Warn When Days Remaining Is At Or Below";
      default:
        return "Value";
    }
  }

  if (kind === "help") {
    switch (alert_for) {
      case GC.STATUS:
        return "Alert when monitor status equals this value";
      case GC.LATENCY:
        return "Alert when latency exceeds this value (in milliseconds)";
      case GC.UPTIME:
        return "Alert when uptime falls below this percentage";
      case GC.CERT_EXPIRY:
        // Names the two things it also covers, because an operator reading only
        // "expiry" would not expect it to fire on an untrusted chain, and a
        // surprise page at 3am is the thing this feature exists to prevent.
        return "Checked once a day. Also alerts on an expired certificate and on one that fails chain validation.";
      default:
        return "";
    }
  }

  const thresholdValue = failure_threshold ?? 0;
  const resolveThreshold = success_threshold ?? 0;
  const value = alert_value ?? "";

  if (alert_for === GC.STATUS) {
    return `Alert when ${thresholdValue} consecutive checks result in ${value}. Resolve after ${resolveThreshold} successful check(s).`;
  }

  if (alert_for === GC.LATENCY) {
    return `Alert when latency exceeds ${value}ms for ${thresholdValue} consecutive checks. Resolve after ${resolveThreshold} check(s) below threshold.`;
  }

  if (alert_for === GC.UPTIME) {
    return `Alert when uptime falls below ${value}% for ${thresholdValue} checks. Resolve after ${resolveThreshold} check(s) above threshold.`;
  }

  if (alert_for === GC.CERT_EXPIRY) {
    // Deliberately says what it will NOT do. B7's requirement is that a
    // certificate warning never marks the monitor down, and an operator
    // enabling their first one needs to know that before they enable it, not
    // after it has or has not happened.
    return `Alert when the certificate expires within ${value} day(s), has already expired, or is not trusted. Checked daily. This never marks the monitor down: the service is up, it just will not be later.`;
  }

  return "";
}
