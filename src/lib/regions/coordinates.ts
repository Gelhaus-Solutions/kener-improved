/**
 * B13. Where the well-known region codes are, so an operator does not have to
 * look them up.
 *
 * **Never a geocoding service.** A status page that calls out to a third party
 * to place a pin leaks the operator's region names to that party, and fails at
 * exactly the moment the third party is the thing having an outage. This is a
 * static table; an unknown code returns null and the operator types the numbers.
 *
 * The coordinates are the METRO the region is named after, not a data centre:
 * cloud providers do not publish exact facility locations, the map is
 * equirectangular at world scale where a few kilometres is well under a pixel,
 * and implying more precision than we have would be its own small lie.
 *
 * Matching is on a normalised code, so `eu-central-1`, `EU_CENTRAL_1` and
 * `euCentral1` all find the same entry.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Metro coordinates, keyed by normalised region code. */
const KNOWN: Record<string, Coordinates & { label: string }> = {
  // AWS-style
  "us-east-1": { latitude: 39.04, longitude: -77.49, label: "N. Virginia" },
  "us-east-2": { latitude: 39.96, longitude: -82.99, label: "Ohio" },
  "us-west-1": { latitude: 37.35, longitude: -121.96, label: "N. California" },
  "us-west-2": { latitude: 45.84, longitude: -119.7, label: "Oregon" },
  "eu-west-1": { latitude: 53.35, longitude: -6.26, label: "Ireland" },
  "eu-west-2": { latitude: 51.51, longitude: -0.13, label: "London" },
  "eu-west-3": { latitude: 48.86, longitude: 2.35, label: "Paris" },
  "eu-central-1": { latitude: 50.11, longitude: 8.68, label: "Frankfurt" },
  "eu-central-2": { latitude: 47.37, longitude: 8.54, label: "Zurich" },
  "eu-north-1": { latitude: 59.33, longitude: 18.07, label: "Stockholm" },
  "eu-south-1": { latitude: 45.46, longitude: 9.19, label: "Milan" },
  "ap-south-1": { latitude: 19.08, longitude: 72.88, label: "Mumbai" },
  "ap-southeast-1": { latitude: 1.35, longitude: 103.82, label: "Singapore" },
  "ap-southeast-2": { latitude: -33.87, longitude: 151.21, label: "Sydney" },
  "ap-northeast-1": { latitude: 35.68, longitude: 139.69, label: "Tokyo" },
  "ap-northeast-2": { latitude: 37.57, longitude: 126.98, label: "Seoul" },
  "ap-east-1": { latitude: 22.32, longitude: 114.17, label: "Hong Kong" },
  "sa-east-1": { latitude: -23.55, longitude: -46.63, label: "Sao Paulo" },
  "ca-central-1": { latitude: 45.5, longitude: -73.57, label: "Montreal" },
  "af-south-1": { latitude: -33.92, longitude: 18.42, label: "Cape Town" },
  "me-south-1": { latitude: 26.07, longitude: 50.56, label: "Bahrain" },

  // Bare compass forms, which is what a hand-made region is usually called.
  "us-east": { latitude: 39.04, longitude: -77.49, label: "US East" },
  "us-west": { latitude: 45.84, longitude: -119.7, label: "US West" },
  "us-central": { latitude: 41.26, longitude: -95.94, label: "US Central" },
  "eu-west": { latitude: 53.35, longitude: -6.26, label: "EU West" },
  "eu-central": { latitude: 50.11, longitude: 8.68, label: "EU Central" },
  "eu-north": { latitude: 59.33, longitude: 18.07, label: "EU North" },
  "ap-south": { latitude: 19.08, longitude: 72.88, label: "AP South" },
  "ap-southeast": { latitude: 1.35, longitude: 103.82, label: "AP Southeast" },
  "ap-northeast": { latitude: 35.68, longitude: 139.69, label: "AP Northeast" },
  "sa-east": { latitude: -23.55, longitude: -46.63, label: "SA East" },

  // Common city codes.
  london: { latitude: 51.51, longitude: -0.13, label: "London" },
  frankfurt: { latitude: 50.11, longitude: 8.68, label: "Frankfurt" },
  amsterdam: { latitude: 52.37, longitude: 4.9, label: "Amsterdam" },
  paris: { latitude: 48.86, longitude: 2.35, label: "Paris" },
  berlin: { latitude: 52.52, longitude: 13.4, label: "Berlin" },
  singapore: { latitude: 1.35, longitude: 103.82, label: "Singapore" },
  tokyo: { latitude: 35.68, longitude: 139.69, label: "Tokyo" },
  sydney: { latitude: -33.87, longitude: 151.21, label: "Sydney" },
  mumbai: { latitude: 19.08, longitude: 72.88, label: "Mumbai" },
  toronto: { latitude: 43.65, longitude: -79.38, label: "Toronto" },
  "new-york": { latitude: 40.71, longitude: -74.01, label: "New York" },
  "sao-paulo": { latitude: -23.55, longitude: -46.63, label: "Sao Paulo" },
};

/**
 * Normalises a region code for lookup.
 *
 * Lowercases, and turns underscores, spaces and camelCase boundaries into
 * hyphens, so the spellings an operator might reasonably use land on one key.
 */
export function normaliseForLookup(code: string): string {
  return (
    code
      .trim()
      // camelCase boundary: euCentral -> eu-Central
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      // A trailing number written without a separator. `euCentral1` normalises
      // to `eu-central1` without this, which matches no key and does not reach
      // the numeric-suffix fallback either, because that fallback looks for
      // `-<digits>`. Guarded to a letter followed by a digit, so an already
      // hyphenated `eu-central-1` is untouched rather than double-hyphenated.
      .replace(/([a-z])(\d)/g, "$1-$2")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

/**
 * Coordinates for a region code, or null when it is not one we know.
 *
 * Falls back from `eu-central-1` to `eu-central`, which is what lets one table
 * serve provider-numbered and bare codes without listing both for every region.
 * Only a NUMERIC suffix is stripped, and only one level: stripping words would
 * make `us-east` and `us` the same place.
 */
export function coordinatesForCode(code: string): Coordinates | null {
  const key = normaliseForLookup(code);
  const exact = KNOWN[key];
  if (exact) return { latitude: exact.latitude, longitude: exact.longitude };

  const withoutNumber = key.replace(/-\d+$/, "");
  if (withoutNumber !== key) {
    const base = KNOWN[withoutNumber];
    if (base) return { latitude: base.latitude, longitude: base.longitude };
  }

  return null;
}

/** Every code the lookup knows, for a picker or a docs table. */
export function knownRegionCodes(): Array<{ code: string; label: string } & Coordinates> {
  return Object.entries(KNOWN).map(([code, v]) => ({
    code,
    label: v.label,
    latitude: v.latitude,
    longitude: v.longitude,
  }));
}

/** Whether a pair of numbers is a plottable point on earth. */
export function isPlottable(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}
