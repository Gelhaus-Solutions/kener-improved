export function IsValidURL(url: string): boolean {
  const regex = /^(https?:\/\/)?((localhost|[\da-z.-]+\.[a-z]{2,10})(:[0-9]{1,5})?)?(\/[\w .-]*)*\/?$/i;
  return regex.test(url);
}

export function IsValidGHObject(data: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    return false;
  }

  if (typeof parsed !== "object") return false;

  if (!!parsed.apiURL && (typeof parsed.apiURL !== "string" || !IsValidURL(parsed.apiURL))) return false;

  if (!!parsed.owner && typeof parsed.owner !== "string") return false;
  if (!!parsed.repo && typeof parsed.repo !== "string") return false;
  if (!!parsed.incidentSince && isNaN(parsed.incidentSince as number)) return false;
  return true;
}

export function IsValidObject(data: unknown): boolean {
  return typeof data === "object";
}
export function IsValidJSONString(data: string): boolean {
  try {
    JSON.parse(data);
  } catch (error) {
    return false;
  }
  return true;
}

//IsValidJSONArray
export function IsValidJSONArray(data: string): boolean {
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed);
  } catch (error) {
    return false;
  }
}

export function IsValidNav(nav: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(nav);
  } catch (error) {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  if (parsed.length === 0) return true;
  for (const item of parsed) {
    if (!!!item.name || !!!item.url) return false;
  }
  return true;
}

export function IsValidHero(hero: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(hero);
  } catch (error) {
    return false;
  }

  if (typeof parsed !== "object") return false;
  if (!!parsed.title && typeof parsed.title !== "string") return false;
  if (!!parsed.title && typeof parsed.subtitle !== "string") return false;
  return true;
}

export function IsValidFooterHTML(html: unknown): boolean {
  return typeof html === "string";
}

export function IsValidI18n(i18n: string): boolean {
  try {
    JSON.parse(i18n);
  } catch (error) {
    return false;
  }

  return true;
}

export function IsValidAnalytics(analytics: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(analytics);
  } catch (error) {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  for (const item of parsed) {
    if (typeof item.id !== "string") return false;
    if (typeof item.type !== "string") return false;
  }
  return true;
}

export function IsValidColors(colors: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(colors);
  } catch (error) {
    return false;
  }
  if (typeof parsed !== "object") return false;
  const requiredColorKeys = ["UP", "DOWN", "DEGRADED", "MAINTENANCE"];
  for (const key of requiredColorKeys) {
    if (typeof parsed[key] !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(parsed[key] as string)) return false;
  }
  // Optional color keys
  const optionalColorKeys = ["ACCENT", "ACCENT_FOREGROUND"];
  for (const key of optionalColorKeys) {
    if (parsed[key] !== undefined) {
      if (typeof parsed[key] !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(parsed[key] as string)) return false;
    }
  }
  return true;
}

/**
 * The event bus consumer mode map: `{ "<consumer>": "off|legacy|shadow|live" }`.
 *
 * Rejected at the write rather than tolerated and dropped at the read. The read
 * path in `events/consumerModes.ts` deliberately ignores a mode it does not
 * recognise and falls back to the consumer's declared default, which is the
 * right behaviour there - guessing would mean either starting to send from a
 * typo or silently stopping a channel that was working. But that also means a
 * bad value written here would take effect as "no change", with nothing to say
 * so. Failing the write is what turns that into a visible error.
 */
export function IsValidConsumerModes(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;

  const modes = new Set(["off", "legacy", "shadow", "live"]);
  for (const [name, mode] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof name !== "string" || name.length === 0) return false;
    if (typeof mode !== "string" || !modes.has(mode)) return false;
  }
  return true;
}

/**
 * The MFA policy: who is expected to hold a Kener-managed second factor.
 *
 * A plain string rather than JSON, so it is validated against the closed set
 * directly. Registered for the same reason `IsValidConsumerModes` is: the read
 * path falls back to `local_only` on anything it does not recognise, so a bad
 * write would otherwise take effect as "no change" with nothing to say so.
 */
export function IsValidMfaPolicy(value: string): boolean {
  return value === "none" || value === "local_only" || value === "all";
}
