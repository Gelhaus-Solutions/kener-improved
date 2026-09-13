import { project } from "./projection.js";

/**
 * B13. A bundled world outline, as coarse lat/lon polygons.
 *
 * **No tile service, ever.** A status page that calls a map provider leaks every
 * viewer to a third party and goes blank exactly when that provider is the thing
 * having an outage. This is a few hundred numbers compiled into the bundle.
 *
 * **Stored as coordinates and projected at render time, not as baked SVG path
 * data.** The outline and the pins then go through the SAME `project()`, so they
 * cannot drift apart: change the projection or the viewBox and both move
 * together. A pre-computed path would silently keep the old projection while the
 * pins moved to the new one, which puts every pin in the wrong place relative to
 * the coastline while both halves look individually fine.
 *
 * Deliberately coarse. This is a backdrop for pins at world scale, not an atlas:
 * at 1000px wide, one pixel is about 0.36 degrees, so detail below roughly a
 * degree cannot be seen at all. Small islands are omitted rather than drawn as
 * single-pixel specks that read as rendering noise.
 */

type LonLat = [number, number];

/** Coarse continental outlines, [longitude, latitude], closed implicitly. */
const LANDMASSES: LonLat[][] = [
  // North America
  [
    [-168, 65], [-160, 71], [-140, 70], [-125, 70], [-110, 68], [-95, 70], [-85, 70], [-80, 63],
    [-65, 60], [-55, 52], [-60, 46], [-67, 45], [-70, 42], [-75, 35], [-81, 31], [-80, 25],
    [-84, 30], [-90, 29], [-97, 26], [-97, 20], [-105, 20], [-110, 23], [-115, 30], [-124, 40],
    [-124, 48], [-135, 57], [-150, 59], [-165, 62],
  ],
  // Greenland
  [[-45, 60], [-20, 70], [-20, 80], [-35, 84], [-58, 82], [-55, 70], [-50, 62]],
  // South America
  [
    [-81, 0], [-78, -5], [-75, -14], [-70, -18], [-70, -30], [-73, -42], [-75, -52], [-68, -55],
    [-63, -50], [-58, -38], [-53, -33], [-48, -25], [-40, -20], [-35, -8], [-44, -2], [-50, 0],
    [-52, 5], [-60, 8], [-70, 12], [-77, 8],
  ],
  // Africa and Arabia
  [
    [-17, 21], [-16, 14], [-10, 5], [0, 5], [9, 4], [9, -1], [13, -6], [12, -17], [15, -23],
    [18, -34], [26, -34], [32, -26], [35, -21], [40, -15], [41, -2], [44, 2], [51, 12],
    [43, 12], [43, 15], [39, 18], [34, 28], [43, 30], [50, 30], [57, 25], [52, 18],
    [45, 13], [43, 12], [35, 24], [33, 31], [25, 32], [15, 32], [10, 37], [0, 35], [-6, 36],
    [-10, 31], [-13, 27],
  ],
  // Europe and Asia
  [
    [-10, 43], [-2, 43], [3, 43], [5, 51], [-4, 50], [-2, 58], [8, 58], [12, 55], [20, 55],
    [22, 60], [30, 62], [30, 70], [45, 70], [60, 72], [75, 73], [90, 75], [105, 77], [130, 73],
    [145, 72], [160, 70], [170, 67], [180, 65], [180, 60], [160, 60], [155, 55], [142, 48],
    [135, 43], [130, 40], [127, 35], [122, 30], [117, 24], [110, 20], [105, 10], [100, 5],
    [95, 15], [90, 22], [80, 15], [77, 8], [73, 18], [68, 24], [62, 25], [57, 25], [50, 30],
    [43, 30], [34, 28], [36, 36], [30, 41], [26, 40], [22, 37], [15, 40], [12, 45], [18, 42],
    [20, 40], [13, 38], [8, 44], [3, 42],
  ],
  // Australia
  [
    [113, -22], [114, -32], [118, -35], [129, -32], [138, -35], [141, -38], [147, -38],
    [150, -37], [153, -28], [146, -19], [142, -11], [136, -12], [130, -12], [126, -14],
    [122, -17],
  ],
  // New Zealand, as two strokes rather than an outline: at this scale the
  // islands are a few pixels wide and a closed polygon reads as a blob.
  [[173, -35], [178, -38], [177, -41], [172, -41]],
  [[167, -45], [171, -44], [174, -41], [170, -46]],
  // Madagascar
  [[43, -12], [50, -15], [50, -25], [45, -25], [43, -20]],
  // Japan
  [[130, 31], [135, 34], [140, 36], [142, 40], [145, 44], [141, 45], [138, 37], [131, 33]],
  // British Isles
  [[-5, 50], [1, 51], [-1, 58], [-5, 58], [-6, 54]],
  [[-10, 52], [-6, 52], [-6, 55], [-10, 55]],
];

/** The outline as SVG path data, projected with the same function as the pins. */
export function worldOutlinePaths(): string[] {
  return LANDMASSES.map((polygon) => {
    const points = polygon.map(([lon, lat]) => project({ latitude: lat, longitude: lon }));
    const [first, ...rest] = points;
    return `M ${first.x.toFixed(1)} ${first.y.toFixed(1)} ` + rest.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + " Z";
  });
}

/**
 * Latitude and longitude lines, every 30 degrees.
 *
 * Cheap orientation for a coarse map: without them an unfamiliar landmass shape
 * is hard to place, and the equator and prime meridian make the projection's
 * linearity legible rather than something the viewer has to take on trust.
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
