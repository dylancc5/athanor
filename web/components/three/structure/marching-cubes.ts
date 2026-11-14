/**
 * Isosurface extraction from a scalar grid, written from scratch (no library
 * is available in this project).
 *
 * Uses **marching tetrahedra** rather than classic marching cubes: each grid
 * cell is split into six tetrahedra and each tetrahedron has only three
 * topological cases. That avoids transcribing a 256-entry triangle table —
 * the single largest source of silent, hard-to-spot bugs in a hand-written
 * marching cubes — and is topologically unambiguous (no need for the
 * asymptotic-decider patches that plain marching cubes requires). It emits
 * roughly twice the triangles, which for the grid sizes here (<= 64^3) is
 * irrelevant.
 *
 * Vertices are welded on a per-edge key, so the mesh is closed and vertex
 * normals average across adjacent faces for a smooth surface.
 *
 * The grid is interpreted in **fractional** cell coordinates and transformed
 * by the lattice matrix at the end, so the surface sits correctly inside a
 * non-orthogonal cell. Sampling wraps periodically (grid point `nx` is grid
 * point `0`) so the surface closes across cell boundaries, while the geometry
 * still uses the un-wrapped fractional coordinate `(ix+1)/nx` so nothing folds
 * back on itself.
 */

export interface IsosurfaceResult {
  /** Flat xyz triples in Cartesian angstroms. */
  positions: Float32Array;
  /** Smooth (area-weighted) vertex normals. */
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

type Grid = {
  values: number[] | Float32Array;
  nx: number;
  ny: number;
  nz: number;
};

/** Row-major flat index with periodic wrap. */
function sample(g: Grid, ix: number, iy: number, iz: number): number {
  const x = ix % g.nx;
  const y = iy % g.ny;
  const z = iz % g.nz;
  const v = g.values[(x * g.ny + y) * g.nz + z];
  return Number.isFinite(v) ? v : 0;
}

/**
 * The six tetrahedra that tile a unit cube, as corner indices into the
 * cube's eight corners. Corner c is numbered with bits (x, y, z) =
 * (c & 1, (c >> 1) & 1, (c >> 2) & 1).
 *
 * This is the standard Kuhn/diagonal decomposition: every tetrahedron shares
 * the cube's main diagonal 0-7, which guarantees that adjacent cubes agree on
 * their shared faces and the surface has no cracks.
 */
const TETRA: readonly (readonly [number, number, number, number])[] = [
  [0, 5, 1, 7],
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
];

/** Offsets of the eight cube corners in (dx, dy, dz). */
const CORNER: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

/**
 * Extract the `isoLevel` isosurface of a scalar field defined on a periodic
 * grid over the unit cell.
 *
 * @param values flat, row-major over `[nx, ny, nz]`
 * @param cell   3x3 row-major lattice matrix (rows are a, b, c)
 */
export function marchingTetrahedra(
  values: number[] | Float32Array,
  shape: [number, number, number],
  cell: number[][],
  isoLevel: number,
): IsosurfaceResult | null {
  const [nx, ny, nz] = shape;
  if (!(nx >= 2 && ny >= 2 && nz >= 2)) return null;
  if (values.length < nx * ny * nz) return null;

  const g: Grid = { values, nx, ny, nz };

  const posList: number[] = [];
  const idxList: number[] = [];
  const vertexCache = new Map<number, number>();

  // Cube corner grid indices, reused each cell.
  const ci = new Int32Array(8);
  const cj = new Int32Array(8);
  const ck = new Int32Array(8);
  const cv = new Float64Array(8);

  // Ids run over the *extended* (nx+1)^3 point lattice, because grid point
  // `nx` is a distinct geometric point from `0` even though it samples the
  // same value. The weld key must therefore be based on this count, not on
  // nx*ny*nz, or small grids collide.
  const extCount = (nx + 1) * (ny + 1) * (nz + 1);

  /**
   * Interpolate along the edge between two grid points and return a welded
   * vertex index. The cache key is built from the two (unwrapped) grid point
   * ids so the two cells sharing an edge produce the same vertex.
   */
  const edgeVertex = (ai: number, bi: number): number => {
    // Unwrapped point ids (ix may equal nx, which is a distinct geometric
    // point from 0 even though it samples the same value).
    const lo = Math.min(ai, bi);
    const hi = Math.max(ai, bi);
    const key = lo * extCount + hi;
    const cached = vertexCache.get(key);
    if (cached !== undefined) return cached;

    // Decode grid coordinates from the extended (nx+1) x (ny+1) x (nz+1) id.
    const ey = ny + 1;
    const ez = nz + 1;
    const decode = (id: number) => {
      const z = id % ez;
      const y = Math.floor(id / ez) % ey;
      const x = Math.floor(id / (ez * ey));
      return [x, y, z] as const;
    };
    const [ax, ay, az] = decode(lo);
    const [bx, by, bz] = decode(hi);
    const va = sample(g, ax, ay, az);
    const vb = sample(g, bx, by, bz);

    let t = 0.5;
    const denom = vb - va;
    if (Math.abs(denom) > 1e-12) t = (isoLevel - va) / denom;
    if (!Number.isFinite(t)) t = 0.5;
    t = t < 0 ? 0 : t > 1 ? 1 : t;

    // Fractional coordinates, then Cartesian through the lattice.
    const fx = (ax + (bx - ax) * t) / nx;
    const fy = (ay + (by - ay) * t) / ny;
    const fz = (az + (bz - az) * t) / nz;
    const x = fx * cell[0][0] + fy * cell[1][0] + fz * cell[2][0];
    const y = fx * cell[0][1] + fy * cell[1][1] + fz * cell[2][1];
    const z = fx * cell[0][2] + fy * cell[1][2] + fz * cell[2][2];

    const index = posList.length / 3;
    posList.push(x, y, z);
    vertexCache.set(key, index);
    return index;
  };

  const encode = (x: number, y: number, z: number) =>
    (x * (ny + 1) + y) * (nz + 1) + z;

  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        for (let c = 0; c < 8; c++) {
          ci[c] = ix + CORNER[c][0];
          cj[c] = iy + CORNER[c][1];
          ck[c] = iz + CORNER[c][2];
          cv[c] = sample(g, ci[c], cj[c], ck[c]);
        }

        for (const tet of TETRA) {
          // Classify the four tetrahedron corners.
          let code = 0;
          for (let v = 0; v < 4; v++) if (cv[tet[v]] >= isoLevel) code |= 1 << v;
          if (code === 0 || code === 15) continue;

          const id = (v: number) => encode(ci[tet[v]], cj[tet[v]], ck[tet[v]]);

          // Three cases up to symmetry: one corner in, two in, three in.
          // Winding is chosen so the normal points towards the "inside"
          // (values >= isoLevel), which for a void grid is the pore.
          switch (code) {
            case 1:
            case 14: {
              const a = edgeVertex(id(0), id(1));
              const b = edgeVertex(id(0), id(2));
              const c2 = edgeVertex(id(0), id(3));
              if (code === 1) idxList.push(a, b, c2);
              else idxList.push(a, c2, b);
              break;
            }
            case 2:
            case 13: {
              const a = edgeVertex(id(1), id(0));
              const b = edgeVertex(id(1), id(3));
              const c2 = edgeVertex(id(1), id(2));
              if (code === 2) idxList.push(a, b, c2);
              else idxList.push(a, c2, b);
              break;
            }
            case 4:
            case 11: {
              const a = edgeVertex(id(2), id(0));
              const b = edgeVertex(id(2), id(1));
              const c2 = edgeVertex(id(2), id(3));
              if (code === 4) idxList.push(a, b, c2);
              else idxList.push(a, c2, b);
              break;
            }
            case 8:
            case 7: {
              const a = edgeVertex(id(3), id(0));
              const b = edgeVertex(id(3), id(2));
              const c2 = edgeVertex(id(3), id(1));
              if (code === 8) idxList.push(a, b, c2);
              else idxList.push(a, c2, b);
              break;
            }
            // Two corners in, two out: a quad across four edges.
            case 3:
            case 12: {
              const a = edgeVertex(id(0), id(2));
              const b = edgeVertex(id(0), id(3));
              const c2 = edgeVertex(id(1), id(3));
              const d = edgeVertex(id(1), id(2));
              if (code === 3) idxList.push(a, b, c2, a, c2, d);
              else idxList.push(a, c2, b, a, d, c2);
              break;
            }
            case 5:
            case 10: {
              const a = edgeVertex(id(0), id(1));
              const b = edgeVertex(id(0), id(3));
              const c2 = edgeVertex(id(2), id(3));
              const d = edgeVertex(id(2), id(1));
              // Reversed relative to the other two quad cases: the edge pairs
              // for this corner split traverse the quad in the opposite sense,
              // so using the same order here winds these triangles backwards.
              // (Caught by the "consistently wound" test, which saw ~1000
              // edges that were never traversed in both directions.)
              if (code === 5) idxList.push(a, c2, b, a, d, c2);
              else idxList.push(a, b, c2, a, c2, d);
              break;
            }
            case 9:
            case 6: {
              const a = edgeVertex(id(0), id(1));
              const b = edgeVertex(id(0), id(2));
              const c2 = edgeVertex(id(3), id(2));
              const d = edgeVertex(id(3), id(1));
              if (code === 9) idxList.push(a, b, c2, a, c2, d);
              else idxList.push(a, c2, b, a, d, c2);
              break;
            }
          }
        }
      }
    }
  }

  if (idxList.length === 0 || posList.length === 0) return null;

  const positions = new Float32Array(posList);
  const indices = new Uint32Array(idxList);
  const normals = computeSmoothNormals(positions, indices);

  return {
    positions,
    normals,
    indices,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/** Area-weighted vertex normals (cross products are not normalized first). */
export function computeSmoothNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 1e-12) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    } else {
      normals[i] = 0;
      normals[i + 1] = 1;
      normals[i + 2] = 0;
    }
  }
  return normals;
}
