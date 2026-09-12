/**
 * What a published SLO looks like once it has left the server.
 *
 * Shared by client and server: `services/sloPublic.ts` produces it and four
 * components render it. It lives here rather than in the server tree so a
 * component can import the type without pulling a server module into the
 * browser bundle, and so there is one definition rather than one per component.
 *
 * The fields that are null under the COMPACT preset are nullable here rather
 * than a second interface: a component that renders both presets would
 * otherwise need a union and a narrowing for what is, to it, simply a field
 * that may be absent.
 */
export interface PublicSlo {
  name: string;
  /** Attainment over the window, as a percentage. */
  uptimePercent: number;
  objectivePercent: number;
  /**
   * Whether attainment has fallen below the objective.
   *
   * Computed on the server so every surface agrees on what a breach is,
   * including the badge, which shows no numbers to compare.
   */
  breached: boolean;
  /** FULL preset only. */
  budgetRemainingPercent: number | null;
  /** FULL preset only. A locale-neutral token, e.g. "30d (UTC)". */
  window: string | null;
}
