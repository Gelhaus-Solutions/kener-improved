/**
 * Instance role, and the standby's settings, from the environment.
 *
 * A primary is today's Kener. A standby serves the public page from data it
 * pulls from a primary and does nothing else: no checks, no schedulers, no
 * notifications, no writes. See docs/v4/setup/standby.
 */

export type InstanceRole = "primary" | "standby";

export const DEFAULT_STALE_SECONDS = 300;

/**
 * Unset or empty is primary, so an install that sets nothing is unchanged.
 * Anything else that is not a role throws: a typo read as primary would run a
 * second set of checks and send every notification twice.
 */
export function ParseInstanceRole(raw: string | undefined): InstanceRole {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "primary") return "primary";
  if (value === "standby") return "standby";
  throw new Error(`KENER_ROLE must be "primary" or "standby", not "${raw}"`);
}

export function GetInstanceRole(): InstanceRole {
  return ParseInstanceRole(process.env.KENER_ROLE);
}

export function IsStandby(): boolean {
  return GetInstanceRole() === "standby";
}

/** The shared token. On a primary it turns the export on; on a standby it is presented. */
export function StandbyToken(): string | null {
  const token = (process.env.KENER_STANDBY_TOKEN ?? "").trim();
  return token.length > 0 ? token : null;
}

/** The primary's public base URL, base path included, without a trailing slash. */
export function StandbyPrimaryUrl(): string | null {
  const url = (process.env.KENER_STANDBY_PRIMARY_URL ?? "").trim().replace(/\/+$/, "");
  return url.length > 0 ? url : null;
}

/** How old the last good pull may be before the standby stops claiming any current status. */
export function ParseStaleSeconds(raw: string | undefined): number {
  const value = Number((raw ?? "").trim());
  return (raw ?? "").trim() !== "" && Number.isInteger(value) && value > 0 ? value : DEFAULT_STALE_SECONDS;
}

export function StandbyStaleSeconds(): number {
  return ParseStaleSeconds(process.env.KENER_STANDBY_STALE_SECONDS);
}
