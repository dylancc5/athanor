/**
 * A small Bowyer–Watson Delaunay triangulation, plus the frontier-specific
 * wrapper that turns rank-0 Pareto points into a surface.
 *
 * No triangulation library is installed, and the frontier is tiny (tens of
 * points at most), so the naive O(n^2)-ish implementation is the right call —
 * robustness matters far more than speed here.
 *
 * Why project onto the plane perpendicular to (1,1,1): once every axis is
 * oriented so "bigger is better", two mutually non-dominated points can never
 * project onto the same spot of that plane. Triangulating there therefore gives
 * a sheet that cannot fold back on itself, which is exactly what a Pareto
 * frontier is.
 */

import { isFiniteNumber, type Vec3 } from "./math";

export interface P2 {
  x: number;
  y: number;
}

export type Tri = [number, number, number];

const EPS = 1e-9;

function area2(a: P2, b: P2, c: P2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** True when p lies strictly inside the circumcircle of (a,b,c). A degenerate
 *  (collinear) triangle has no circumcircle, so it swallows nothing. */
function inCircumcircle(p: P2, a: P2, b: P2, c: P2): boolean {
  const o = area2(a, b, c);
  if (Math.abs(o) < EPS) return false;
  const ax = a.x - p.x;
  const ay = a.y - p.y;
  const bx = b.x - p.x;
  const by = b.y - p.y;
  const cx = c.x - p.x;
  const cy = c.y - p.y;
  const det =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);
  return o > 0 ? det > EPS : det < -EPS;
}

/**
 * Triangulate 2D points. Returns triangles as index triples into `pts`.
 * Fewer than three points, or an all-collinear set, yields an empty list —
 * the caller falls back to a polyline.
 */
export function delaunay(pts: readonly P2[]): Tri[] {
  const n = pts.length;
  if (n < 3) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return [];
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const d = Math.max(maxX - minX, maxY - minY) || 1;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  // Super-triangle, generously large so no real point lands on its edges.
  const all: P2[] = [
    ...pts,
    { x: midX - 20 * d, y: midY - d },
    { x: midX, y: midY + 20 * d },
    { x: midX + 20 * d, y: midY - d },
  ];
  let tris: Tri[] = [[n, n + 1, n + 2]];

  for (let i = 0; i < n; i++) {
    const keep: Tri[] = [];
    const edges: [number, number][] = [];
    for (const t of tris) {
      if (inCircumcircle(all[i], all[t[0]], all[t[1]], all[t[2]])) {
        edges.push([t[0], t[1]], [t[1], t[2]], [t[2], t[0]]);
      } else {
        keep.push(t);
      }
    }
    tris = keep;
    // Edges shared by two removed triangles are interior; the rest form the
    // cavity boundary and get stitched to the new point.
    for (let e = 0; e < edges.length; e++) {
      let shared = false;
      for (let f = 0; f < edges.length; f++) {
        if (e === f) continue;
        if (
          (edges[e][0] === edges[f][0] && edges[e][1] === edges[f][1]) ||
          (edges[e][0] === edges[f][1] && edges[e][1] === edges[f][0])
        ) {
          shared = true;
          break;
        }
      }
      if (shared) continue;
      const [u, v] = edges[e];
      if (Math.abs(area2(all[u], all[v], all[i])) < EPS) continue;
      tris.push([u, v, i]);
    }
  }
  return tris.filter((t) => t[0] < n && t[1] < n && t[2] < n);
}

export interface FrontierMesh {
  /** What could actually be built from the points given. */
  kind: "surface" | "polyline" | "points" | "empty";
  /** Deduplicated world positions, in the order the caller should use. */
  positions: Vec3[];
  /** Index of the source point each position came from. */
  sourceIndex: number[];
  /** Triangles (kind === "surface") as indices into `positions`. */
  triangles: Tri[];
  /** Ordered index path (kind === "polyline"). */
  path: number[];
}

const EMPTY_MESH: FrontierMesh = {
  kind: "empty",
  positions: [],
  sourceIndex: [],
  triangles: [],
  path: [],
};

/** Orthonormal basis of the plane perpendicular to (1,1,1). */
const U: Vec3 = [1 / Math.SQRT2, -1 / Math.SQRT2, 0];
const V: Vec3 = [1 / Math.sqrt(6), 1 / Math.sqrt(6), -2 / Math.sqrt(6)];

/**
 * Build a surface through frontier points, degrading gracefully:
 * duplicates are merged, 1 point gives `points`, 2 points or a collinear set
 * gives a `polyline`, and anything else gives a triangulated `surface`.
 */
export function frontierMesh(points: readonly Vec3[]): FrontierMesh {
  if (!Array.isArray(points) || points.length === 0) return EMPTY_MESH;

  const positions: Vec3[] = [];
  const sourceIndex: number[] = [];
  const keys = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Array.isArray(p) || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1]) || !isFiniteNumber(p[2])) {
      continue;
    }
    // 1e-4 of a normalized unit cube: closer than a pixel at any sane zoom.
    const key = `${p[0].toFixed(4)}|${p[1].toFixed(4)}|${p[2].toFixed(4)}`;
    if (keys.has(key)) continue;
    keys.add(key);
    positions.push([p[0], p[1], p[2]]);
    sourceIndex.push(i);
  }

  if (positions.length === 0) return EMPTY_MESH;
  if (positions.length === 1) {
    return { kind: "points", positions, sourceIndex, triangles: [], path: [0] };
  }

  const flat = positions.map((p) => ({
    x: p[0] * U[0] + p[1] * U[1] + p[2] * U[2],
    y: p[0] * V[0] + p[1] * V[1] + p[2] * V[2],
  }));

  if (positions.length >= 3) {
    const triangles = delaunay(flat);
    if (triangles.length > 0) {
      return { kind: "surface", positions, sourceIndex, triangles, path: [] };
    }
  }

  // Collinear (or just two points): order along the dominant direction so the
  // fallback line does not zig-zag.
  const spanX = Math.max(...flat.map((p) => p.x)) - Math.min(...flat.map((p) => p.x));
  const spanY = Math.max(...flat.map((p) => p.y)) - Math.min(...flat.map((p) => p.y));
  const axis: keyof P2 = spanX >= spanY ? "x" : "y";
  const path = positions
    .map((_, i) => i)
    .sort((a, b) => flat[a][axis] - flat[b][axis] || a - b);
  return { kind: "polyline", positions, sourceIndex, triangles: [], path };
}
