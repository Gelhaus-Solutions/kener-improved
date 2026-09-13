import { isPlottable, type Coordinates } from "./coordinates.js";

/**
 * B13. Turning coordinates into pixels, and keeping overlapping pins apart.
 *
 * **Equirectangular, deliberately.** Longitude and latitude map linearly onto x
 * and y, which is four lines of arithmetic that cannot be subtly wrong. Mercator
 * looks more familiar and needs a real transform with a latitude cutoff, and
 * nothing here depends on shape fidelity: the map exists to say "this region,
 * roughly there, is red". A projection error would put a pin in the wrong
 * country while looking entirely plausible, which is the failure this choice
 * avoids rather than merely simplifies.
 */

/** The SVG viewBox the bundled world outline is drawn in. */
export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 500;

export interface Point {
  x: number;
  y: number;
}

/**
 * Longitude and latitude to a point in the map's viewBox.
 *
 * x runs west to east from -180, y runs NORTH to SOUTH from +90, because SVG's
 * y axis points down and latitude points up. Getting that inversion wrong
 * mirrors the world vertically and is the single most likely mistake here, so
 * `projectionMirrorsNothing` in the tests pins both axes against known cities.
 */
export function project({ latitude, longitude }: Coordinates): Point {
  return {
    x: ((longitude + 180) / 360) * MAP_WIDTH,
    y: ((90 - latitude) / 180) * MAP_HEIGHT,
  };
}

/** A region as the map needs it, before layout. */
export interface PlottableRegion {
  id: number;
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

/** A region that has been given a place on the canvas. */
export interface PlacedRegion<T extends PlottableRegion = PlottableRegion> {
  region: T;
  x: number;
  y: number;
  /** True when this pin was moved to stop it sitting under another. */
  nudged: boolean;
}

/**
 * How close two pins may be, in viewBox units, before one is moved.
 *
 * Roughly two pin radii. Frankfurt, Zurich and Milan are within a few degrees of
 * each other and would otherwise render as one blob with two invisible pins
 * underneath, which reads as "the map lost my regions".
 */
const MIN_SEPARATION = 14;

/**
 * Places every plottable region, nudging pins that would overlap.
 *
 * **Regions with no coordinates are dropped rather than defaulted.** A region
 * that has not been given a location must not appear at 0,0 in the Gulf of
 * Guinea; the caller lists it in the accompanying table instead, which is where
 * an unplaceable region is still honestly visible.
 *
 * The nudge is deterministic: candidates are tried on a fixed spiral in a fixed
 * order, so the same input always produces the same layout and the map does not
 * rearrange itself between renders for no reason.
 */
export function placeRegions<T extends PlottableRegion>(regions: T[]): PlacedRegion<T>[] {
  const placed: PlacedRegion<T>[] = [];

  // Sorted by id so the output order, and therefore which pin gets nudged, does
  // not depend on the order the caller happened to query in.
  const ordered = [...regions].sort((a, b) => a.id - b.id);

  for (const region of ordered) {
    if (!isPlottable(region.latitude, region.longitude)) continue;

    const home = project({ latitude: region.latitude as number, longitude: region.longitude as number });
    const spot = findFreeSpot(home, placed);
    placed.push({ region, x: spot.x, y: spot.y, nudged: spot.x !== home.x || spot.y !== home.y });
  }

  return placed;
}

/** Squared distance, because comparing squares avoids a pointless square root. */
function tooClose(a: Point, b: Point): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy < MIN_SEPARATION * MIN_SEPARATION;
}

/**
 * The first free spot at or near `home`.
 *
 * Tries the true location first, so a region alone in its metro is never moved.
 * Only when that is taken does it walk outwards on a fixed spiral. Falls back to
 * the true location after a bounded search: a pin slightly overlapping is much
 * better than a pin thrown somewhere arbitrary, or than an infinite loop.
 */
function findFreeSpot(home: Point, placed: Array<Point>): Point {
  if (!placed.some((p) => tooClose(home, p))) return home;

  const rings = 4;
  const perRing = 8;
  for (let ring = 1; ring <= rings; ring++) {
    const radius = MIN_SEPARATION * ring;
    for (let step = 0; step < perRing; step++) {
      const angle = (step / perRing) * Math.PI * 2;
      const candidate = {
        x: clamp(home.x + Math.cos(angle) * radius, 0, MAP_WIDTH),
        y: clamp(home.y + Math.sin(angle) * radius, 0, MAP_HEIGHT),
      };
      if (!placed.some((p) => tooClose(candidate, p))) return candidate;
    }
  }

  return home;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
