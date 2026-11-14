/**
 * 3D convex hull, for coordination polyhedra.
 *
 * No hull library is available. Coordination shells are tiny (4-12 vertices),
 * so this uses the brute-force "every triple is a face if every other point
 * lies on one side of its plane" test: O(n^4) but with n <= 12 that is at most
 * a few thousand predicate evaluations, and unlike an incremental hull it has
 * no degenerate-input failure modes.
 *
 * Coplanar points (a square-planar or octahedral shell has four coplanar
 * neighbours) are handled by fan-triangulating each support plane rather than
 * emitting one triangle per coplanar triple, which would produce overlapping
 * z-fighting faces.
 */

export type Vec3 = [number, number, number];

const EPS = 1e-6;

function sub(a: number[], b: number[]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/**
 * Faces of the convex hull as index triples, wound counter-clockwise when
 * viewed from outside. Returns an empty array for degenerate input (fewer
 * than four points, or all points coplanar — there is no volume to shade).
 */
export function convexHullFaces(points: readonly number[][]): [number, number, number][] {
  const n = points.length;
  if (n < 4) return [];

  // Centroid, used both to orient faces and to reject coplanar-only input.
  const c: Vec3 = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0] / n;
    c[1] += p[1] / n;
    c[2] += p[2] / n;
  }

  // Scale-aware tolerance: coordinate units are angstroms, typical shell
  // radius 2-3 A.
  let scale = 0;
  for (const p of points) scale = Math.max(scale, length(sub(p, c)));
  if (scale < EPS) return [];
  const tol = Math.max(1e-4, scale * 1e-3);

  // Collect support planes. Each is a set of points lying on it, with all
  // remaining points strictly on the inner side.
  const planes: { normal: Vec3; onPlane: number[] }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const u = sub(points[j], points[i]);
        const v = sub(points[k], points[i]);
        let normal = cross(u, v);
        const len = length(normal);
        if (len < tol * tol) continue; // collinear triple
        normal = [normal[0] / len, normal[1] / len, normal[2] / len];
        const offset = dot(normal, points[i] as Vec3);

        let above = 0;
        let below = 0;
        const onPlane: number[] = [];
        for (let m = 0; m < n; m++) {
          const d = dot(normal, points[m] as Vec3) - offset;
          if (d > tol) above++;
          else if (d < -tol) below++;
          else onPlane.push(m);
        }
        if (above > 0 && below > 0) continue; // not a support plane

        // Orient the normal away from the centroid.
        const outward: Vec3 = above > 0 ? [-normal[0], -normal[1], -normal[2]] : normal;
        if (above === 0 && below === 0) continue; // every point coplanar: no volume

        // De-duplicate planes by their sorted on-plane point set.
        const key = onPlane.slice().sort((a, b) => a - b).join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        planes.push({ normal: outward, onPlane });
      }
    }
  }

  const faces: [number, number, number][] = [];
  for (const plane of planes) {
    const ring = orderRing(points, plane.onPlane, plane.normal);
    if (ring.length < 3) continue;
    // `orderRing` returns a triangle's indices untouched, and the angular sort
    // it does for a polygon is only counter-clockwise up to the sign of the
    // basis — so the winding has to be checked against the outward normal and
    // flipped when it disagrees. Without this, back-face culling and lighting
    // are inverted on some facets.
    const u = sub(points[ring[1]], points[ring[0]]);
    const v = sub(points[ring[2]], points[ring[0]]);
    if (dot(cross(u, v), plane.normal) < 0) ring.reverse();

    for (let t = 1; t + 1 < ring.length; t++) {
      faces.push([ring[0], ring[t], ring[t + 1]]);
    }
  }
  return faces;
}

/**
 * Sort coplanar point indices into a ring by angle around their own centroid,
 * wound counter-clockwise as seen from outside (i.e. looking down `normal`).
 */
function orderRing(points: readonly number[][], idx: number[], normal: Vec3): number[] {
  if (idx.length <= 3) return idx.slice();
  const c: Vec3 = [0, 0, 0];
  for (const i of idx) {
    c[0] += points[i][0] / idx.length;
    c[1] += points[i][1] / idx.length;
    c[2] += points[i][2] / idx.length;
  }
  // Build an in-plane basis.
  let ref = sub(points[idx[0]], c);
  const refLen = length(ref);
  if (refLen < EPS) return idx.slice();
  ref = [ref[0] / refLen, ref[1] / refLen, ref[2] / refLen];
  const bi = cross(normal, ref);

  return idx
    .map((i) => {
      const d = sub(points[i], c);
      return { i, angle: Math.atan2(dot(d, bi), dot(d, ref)) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((e) => e.i);
}
