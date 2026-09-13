import { describe, it, expect } from "vitest";
import { MAP_HEIGHT, MAP_WIDTH, placeRegions, project, type PlottableRegion } from "./projection.js";
import { coordinatesForCode, isPlottable, normaliseForLookup } from "./coordinates.js";

/**
 * B13. The arithmetic behind the map.
 *
 * **Every failure here produces a confidently wrong picture rather than an
 * error**, which is why the assertions are against known cities rather than
 * against the formula restated. A mirrored axis puts Sydney in Siberia and looks
 * entirely plausible to anyone not checking.
 */

const region = (over: Partial<PlottableRegion> = {}): PlottableRegion => ({
  id: 1,
  code: "eu-central",
  name: "EU Central",
  latitude: 50.11,
  longitude: 8.68,
  ...over,
});

describe("the equirectangular projection", () => {
  it("puts 0,0 in the middle of the canvas", () => {
    expect(project({ latitude: 0, longitude: 0 })).toEqual({ x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });
  });

  it("maps the corners to the corners", () => {
    expect(project({ latitude: 90, longitude: -180 })).toEqual({ x: 0, y: 0 });
    expect(project({ latitude: -90, longitude: 180 })).toEqual({ x: MAP_WIDTH, y: MAP_HEIGHT });
  });

  /**
   * THE MIRROR TEST. SVG's y axis points down and latitude points up, so the
   * inversion in `project` is the single most likely mistake in this file.
   * Getting it wrong flips the world vertically, and every pin still lands on
   * the canvas looking reasonable.
   */
  it("puts north above south and east right of west", () => {
    const stockholm = project({ latitude: 59.33, longitude: 18.07 });
    const capeTown = project({ latitude: -33.92, longitude: 18.42 });
    const tokyo = project({ latitude: 35.68, longitude: 139.69 });
    const oregon = project({ latitude: 45.84, longitude: -119.7 });

    expect(stockholm.y).toBeLessThan(capeTown.y);
    expect(oregon.x).toBeLessThan(tokyo.x);
  });

  it("keeps every known region inside the canvas", () => {
    for (const code of ["us-west-1", "ap-southeast-2", "eu-north-1", "sa-east-1", "af-south-1"]) {
      const coords = coordinatesForCode(code);
      expect(coords, code).not.toBeNull();
      const p = project(coords!);
      expect(p.x, code).toBeGreaterThanOrEqual(0);
      expect(p.x, code).toBeLessThanOrEqual(MAP_WIDTH);
      expect(p.y, code).toBeGreaterThanOrEqual(0);
      expect(p.y, code).toBeLessThanOrEqual(MAP_HEIGHT);
    }
  });
});

describe("placing pins", () => {
  // A region nobody gave coordinates must not be drawn at 0,0, which is in the
  // Gulf of Guinea. An absent pin is honest; a pin in the ocean is a confident
  // wrong answer.
  it("drops a region with no coordinates rather than defaulting it", () => {
    const placed = placeRegions([
      region({ id: 1 }),
      region({ id: 2, code: "nowhere", latitude: null, longitude: null }),
    ]);
    expect(placed).toHaveLength(1);
    expect(placed[0].region.id).toBe(1);
  });

  it("drops coordinates that are not on earth", () => {
    expect(placeRegions([region({ latitude: 91, longitude: 0 })])).toHaveLength(0);
    expect(placeRegions([region({ latitude: 0, longitude: 181 })])).toHaveLength(0);
    expect(placeRegions([region({ latitude: NaN, longitude: 0 })])).toHaveLength(0);
  });

  it("leaves a region alone when nothing is near it", () => {
    const placed = placeRegions([region({ id: 1 })]);
    expect(placed[0].nudged).toBe(false);
    expect(placed[0]).toMatchObject(project({ latitude: 50.11, longitude: 8.68 }));
  });

  /**
   * Frankfurt, Zurich and Milan are within a few degrees of each other. Without
   * nudging they render as one blob with two invisible pins underneath, which
   * reads as the map having lost regions rather than as them overlapping.
   */
  it("separates pins that would sit on top of each other", () => {
    const placed = placeRegions([
      region({ id: 1, code: "eu-central-1", latitude: 50.11, longitude: 8.68 }),
      region({ id: 2, code: "eu-central-2", latitude: 47.37, longitude: 8.54 }),
      region({ id: 3, code: "eu-south-1", latitude: 45.46, longitude: 9.19 }),
    ]);

    expect(placed).toHaveLength(3);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const dx = placed[i].x - placed[j].x;
        const dy = placed[i].y - placed[j].y;
        expect(Math.hypot(dx, dy), `${placed[i].region.code} vs ${placed[j].region.code}`).toBeGreaterThan(10);
      }
    }
    // At least one had to move, and the layout says which.
    expect(placed.some((p) => p.nudged)).toBe(true);
  });

  // The same input must produce the same picture, or the map rearranges itself
  // between renders for no reason a viewer can see.
  it("is deterministic and independent of input order", () => {
    const input = [
      region({ id: 3, code: "eu-south-1", latitude: 45.46, longitude: 9.19 }),
      region({ id: 1, code: "eu-central-1", latitude: 50.11, longitude: 8.68 }),
      region({ id: 2, code: "eu-central-2", latitude: 47.37, longitude: 8.54 }),
    ];
    const a = placeRegions(input);
    const b = placeRegions([...input].reverse());
    expect(a).toEqual(b);
  });

  it("keeps a nudged pin on the canvas", () => {
    const crowded = Array.from({ length: 12 }, (_, i) =>
      region({ id: i + 1, code: `edge-${i}`, latitude: 89.9, longitude: 179.9 }),
    );
    for (const p of placeRegions(crowded)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(MAP_WIDTH);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(MAP_HEIGHT);
    }
  });
});

describe("the built-in coordinate lookup", () => {
  it("finds the spellings an operator might reasonably use", () => {
    const expected = { latitude: 50.11, longitude: 8.68 };
    for (const spelling of ["eu-central-1", "EU_CENTRAL_1", "euCentral1", " eu-central-1 "]) {
      expect(coordinatesForCode(spelling), spelling).toEqual(expected);
    }
  });

  it("falls back from a numbered region to its bare form", () => {
    // ap-southeast-9 is not in the table; ap-southeast is.
    expect(coordinatesForCode("ap-southeast-9")).toEqual(coordinatesForCode("ap-southeast"));
  });

  // Stripping words rather than digits would make "us-east" and "us" the same
  // place, which is a wrong pin rather than a missing one.
  it("does not strip a word to find a match", () => {
    expect(coordinatesForCode("us")).toBeNull();
    expect(coordinatesForCode("eu")).toBeNull();
  });

  it("returns null for a code it does not know", () => {
    expect(coordinatesForCode("my-basement")).toBeNull();
    expect(coordinatesForCode("")).toBeNull();
  });

  it("normalises consistently", () => {
    expect(normaliseForLookup("EU_Central_1")).toBe("eu-central-1");
    expect(normaliseForLookup("  us east  ")).toBe("us-east");
  });

  it("rejects impossible coordinates", () => {
    expect(isPlottable(50, 8)).toBe(true);
    expect(isPlottable(0, 0)).toBe(true);
    expect(isPlottable(91, 0)).toBe(false);
    expect(isPlottable(0, -181)).toBe(false);
    expect(isPlottable(null, 0)).toBe(false);
    expect(isPlottable("50", "8")).toBe(false);
  });
});
