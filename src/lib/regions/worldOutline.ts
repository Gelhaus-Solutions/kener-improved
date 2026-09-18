import { project } from "./projection.js";
import { LAND_RINGS } from "./worldLand.js";

/**
 * B13. The bundled world outline.
 *
 * **No tile service, ever.** A status page that calls a map provider leaks every
 * viewer to a third party and goes blank exactly when that provider is the thing
 * having an outage. This is one generated constant compiled into the bundle.
 *
 * **Real coastlines, not an approximation.** The first version of this file held
 * a few hundred numbers typed by hand, and it looked like it. The geometry now
 * comes from Natural Earth's 1:110m land at build time, via
 * `scripts/generate-world-outline.mjs`; `world-atlas` and `topojson-client` are
 * devDependencies and nothing at runtime imports either.
 *
 * **Stored as coordinates and projected at render time, not as baked SVG path
 * data.** The outline and the pins then go through the SAME `project()`, so they
 * cannot drift apart: change the projection or the viewBox and both move
 * together. A pre-computed path would silently keep the old projection while the
 * pins moved to the new one, which puts every pin in the wrong place relative to
 * the coastline while both halves look individually fine.
 */

/** One world width in degrees of longitude. */
const WORLD = 360;

/**
 * The shifts a ring is drawn at.
 *
 * **This is how the antimeridian is handled, and it is the whole reason the
 * generated data may run past 180.** Natural Earth stores Afro-Eurasia as a
 * single ring crossing 180 at Chukotka; the generator unwraps it so longitude
 * stays continuous rather than jumping, which leaves the ring sitting outside
 * the visible window. Drawing it again a world to the east and letting the SVG
 * viewBox clip puts the far east of Russia on the left edge where it belongs,
 * with no polygon clipping arithmetic anywhere.
 *
 * Only the offsets that actually overlap the window are emitted, so the common
 * case - every ring that does not touch the antimeridian - still costs one path.
 */
const OFFSETS = [-WORLD, 0, WORLD];

function pathFor(ring: readonly number[], offset: number): string {
  let path = "";
  for (let i = 0; i < ring.length; i += 2) {
    const point = project({ latitude: ring[i + 1], longitude: ring[i] + offset });
    path += `${i === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    if (i + 2 < ring.length) path += " ";
  }
  return path + "Z";
}

/** Does this ring, shifted, put anything inside the map at all? */
function visible(ring: readonly number[], offset: number): boolean {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    if (ring[i] < min) min = ring[i];
    if (ring[i] > max) max = ring[i];
  }
  return min + offset <= 180 && max + offset >= -180;
}

let cachedOutline: string | null = null;

/**
 * The whole world as ONE SVG path, projected with the same function as the pins.
 *
 * **One path, filled `evenodd`, because some of these rings are lakes.** Natural
 * Earth's land includes interior rings for the Caspian, the Great Lakes and
 * friends. Drawn as separate filled shapes they are painted in the land colour
 * on top of land, which is invisible except for a stray outline sitting in the
 * middle of Asia. Even-odd filling makes an interior ring punch through to the
 * background, which is what a lake is.
 */
export function worldOutlinePath(): string {
  // Memoised: the geometry is a constant, the component renders on both the
  // public page and the admin screen, and five thousand points is not work to
  // repeat per mount.
  if (cachedOutline !== null) return cachedOutline;

  let path = "";
  for (const ring of LAND_RINGS) {
    for (const offset of OFFSETS) {
      if (!visible(ring, offset)) continue;
      path += pathFor(ring, offset);
    }
  }
  cachedOutline = path;
  return path;
}

/**
 * Latitude and longitude lines, every 30 degrees.
 *
 * Orientation that costs nothing: the equator and the prime meridian make the
 * projection's linearity legible rather than something the viewer has to take on
 * trust, and they give an unfamiliar coastline something to be measured against.
 */
export function graticulePaths(): string[] {
  const lines: string[] = [];
  for (let lon = -180; lon <= 180; lon += 30) {
    const top = project({ latitude: 90, longitude: lon });
    const bottom = project({ latitude: -90, longitude: lon });
    lines.push(`M ${top.x.toFixed(1)} ${top.y.toFixed(1)} L ${bottom.x.toFixed(1)} ${bottom.y.toFixed(1)}`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const left = project({ latitude: lat, longitude: -180 });
    const right = project({ latitude: lat, longitude: 180 });
    lines.push(`M ${left.x.toFixed(1)} ${left.y.toFixed(1)} L ${right.x.toFixed(1)} ${right.y.toFixed(1)}`);
  }
  return lines;
}
