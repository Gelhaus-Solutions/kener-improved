import { describe, it, expect } from "vitest";
import { LAND_RINGS } from "./worldLand.js";
import { worldOutlinePath, graticulePaths } from "./worldOutline.js";
import { MAP_WIDTH, project } from "./projection.js";

/**
 * B13. Is the bundled map actually the world?
 *
 * **The version this replaced was typed by hand and was wrong**, and nothing
 * caught it because "the SVG rendered" was the only property anyone checked. A
 * map that draws smoothly and puts Frankfurt in the sea is worse than no map, so
 * these tests ask the only question that matters: is this point land or water.
 */

/**
 * Even-odd point-in-polygon across every ring, at every world offset.
 *
 * The same rule the renderer uses: rings may sit outside [-180, 180] because the
 * generator unwraps antimeridian crossings, so a point is tested against each
 * ring shifted by a whole world in both directions.
 */
function isLand(longitude: number, latitude: number): boolean {
  let inside = false;
  for (const ring of LAND_RINGS) {
    for (const offset of [-360, 0, 360]) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const xi = ring[i] + offset;
        const yi = ring[i + 1];
        const xj = ring[j] + offset;
        const yj = ring[j + 1];
        if (yi > latitude !== yj > latitude && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
}

describe("the bundled outline is the actual world", () => {
  // Well inland, so a coarse 110m coastline cannot put them in the sea.
  const LAND: Array<[string, number, number]> = [
    ["Frankfurt", 8.68, 50.11],
    ["Kansas", -98.0, 38.5],
    ["Sahara", 10.0, 23.0],
    ["Siberia", 90.0, 62.0],
    ["central Australia", 133.0, -24.0],
    ["Amazon basin", -62.0, -5.0],
    ["central India", 78.0, 22.0],
    ["Antarctica", 0.0, -80.0],
  ];

  // Deep ocean, far from any coast.
  const WATER: Array<[string, number, number]> = [
    ["mid Pacific", -140.0, 0.0],
    ["mid Atlantic", -30.0, 0.0],
    ["southern Indian Ocean", 80.0, -40.0],
    ["north Pacific", 180.0, 40.0],
    ["Southern Ocean", -120.0, -60.0],
    ["north Atlantic", -40.0, 45.0],
  ];

  for (const [name, lon, lat] of LAND) {
    it(`puts ${name} on land`, () => {
      expect(isLand(lon, lat)).toBe(true);
    });
  }

  for (const [name, lon, lat] of WATER) {
    it(`puts ${name} in the sea`, () => {
      expect(isLand(lon, lat)).toBe(false);
    });
  }
});

describe("the antimeridian does not draw a streak", () => {
  /**
   * The failure this pins: Natural Earth stores Afro-Eurasia as one ring that
   * crosses 180 at Chukotka. Left wrapped, the segment after the crossing runs
   * the full width of the map through the Pacific, Africa and the Atlantic. The
   * generator unwraps it instead, so no segment in the DATA may be a near-world
   * jump either.
   */
  it("has no segment spanning more than a third of the world", () => {
    const offenders: string[] = [];
    for (const ring of LAND_RINGS) {
      for (let i = 2; i < ring.length; i += 2) {
        const jump = Math.abs(ring[i] - ring[i - 2]);
        if (jump > 120) offenders.push(`${ring[i - 2]} -> ${ring[i]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps Antarctica, which legitimately circles the globe", () => {
    // A naive "reject anything spanning the world" fix would delete it.
    const circumpolar = LAND_RINGS.filter((ring) => {
      let min = Infinity;
      let max = -Infinity;
      let southern = true;
      for (let i = 0; i < ring.length; i += 2) {
        min = Math.min(min, ring[i]);
        max = Math.max(max, ring[i]);
        if (ring[i + 1] > -50) southern = false;
      }
      return southern && max - min > 300;
    });
    expect(circumpolar.length).toBe(1);
  });
});

describe("what the renderer is handed", () => {
  it("is one path, so even-odd filling can punch lakes through", () => {
    const path = worldOutlinePath();
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    // Many subpaths, one string.
    expect(path.split("M").length).toBeGreaterThan(100);
  });

  it("draws nothing far outside the canvas", () => {
    // Rings living beyond the antimeridian are drawn shifted; if the shift were
    // wrong they would sit entirely off-canvas and the map would lose a
    // continent while still rendering perfectly.
    //
    // One world width either side is the real bound, and the edges are reached
    // exactly: a ring touching +180 gets a copy shifted a whole world left, so
    // its leftmost point sits at precisely -MAP_WIDTH. Anything BEYOND that
    // would be a shift applied twice.
    const xs = [...worldOutlinePath().matchAll(/[ML](-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-MAP_WIDTH);
    expect(Math.max(...xs)).toBeLessThanOrEqual(MAP_WIDTH * 2);
  });

  /**
   * **Point-in-polygon on the RENDERED path, not on the source data.**
   *
   * The land/water tests above walk `LAND_RINGS` with their own offset loop, so
   * they pass even if the renderer emits nothing at all for a continent. That is
   * not hypothetical: dropping the shifted copies leaves Afro-Eurasia sitting
   * entirely outside the canvas, because the generator unwraps it to the far
   * side of the antimeridian. Europe would simply be missing and every other
   * test here would stay green.
   */
  function drawnAt(longitude: number, latitude: number): boolean {
    const { x, y } = project({ latitude, longitude });
    let inside = false;
    for (const subpath of worldOutlinePath().split("M").slice(1)) {
      const nums = subpath.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      for (let i = 0, j = nums.length - 2; i < nums.length; j = i, i += 2) {
        const xi = nums[i];
        const yi = nums[i + 1];
        const xj = nums[j];
        const yj = nums[j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  it.each([
    ["Europe", 8.68, 50.11],
    ["Asia", 90.0, 62.0],
    ["Africa", 10.0, 23.0],
    ["North America", -98.0, 38.5],
    ["South America", -62.0, -5.0],
    ["Australia", 133.0, -24.0],
  ])("actually draws %s inside the canvas", (_name, lon, lat) => {
    expect(drawnAt(lon, lat)).toBe(true);
  });

  it("does not paint the open ocean", () => {
    expect(drawnAt(-140.0, 0.0)).toBe(false);
    expect(drawnAt(-30.0, 0.0)).toBe(false);
  });

  it("returns the same string twice, because the geometry is a constant", () => {
    expect(worldOutlinePath()).toBe(worldOutlinePath());
  });

  it("still draws a graticule", () => {
    expect(graticulePaths().length).toBeGreaterThan(10);
  });
});
