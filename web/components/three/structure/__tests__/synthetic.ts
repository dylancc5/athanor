/**
 * Synthetic `void_grid` and `adsorption_sites` payloads.
 *
 * The backend does not yet emit either artifact kind — `contracts.py` declares
 * them but no scorer produces one, and there is no fixture for them. These
 * generators build payloads of exactly the declared shape from a *real*
 * structure, so `VoidSurface` and `AdsorptionSites` can be developed, tested
 * and screenshotted against believable geometry.
 *
 * This is test and scratch-page scaffolding, not product code: nothing under
 * `structure/` imports it.
 */

import { applyMat3, invert3, isValidCell } from "../../../../lib/structure-parse";
import { vdwRadius } from "../../elements";
import type { StructureData } from "../types";

export interface SyntheticVoidGrid {
  cell: number[][];
  shape: [number, number, number];
  values: number[];
  void_fraction: number;
  pore_diameter_A: number;
}

/**
 * A pore-space grid: at each grid point, how far a probe centre can sit from
 * the nearest atom's van der Waals surface, normalized to 0..1 over the cell.
 *
 * 1 is the most open point in the structure, 0 is inside an atom. Distances
 * are computed to the nearest periodic image, so the field is periodic and the
 * isosurface closes across cell boundaries.
 */
export function syntheticVoidGrid(
  structure: StructureData,
  shape: [number, number, number] = [32, 32, 32],
  /**
   * Elements to treat as absent when measuring clearance. For a solid
   * electrolyte, ignoring the mobile cation turns the field into the
   * *conduction channel network* the cation can move through, which is the
   * physically interesting surface — measuring clearance to the lithiums
   * themselves just carves tiny disconnected interstitial pockets.
   */
  ignore: readonly string[] = [],
): SyntheticVoidGrid | null {
  if (!isValidCell(structure.cell)) return null;
  const cell = structure.cell as number[][];
  const inv = invert3(cell);
  if (!inv) return null;

  const [nx, ny, nz] = shape;
  const raw = new Float64Array(nx * ny * nz);

  // Fractional coordinates of every atom, plus its vdW radius.
  const skip = new Set(ignore);
  const atoms = structure.positions
    .map((p, i) => ({ f: applyMat3(p, inv), r: vdwRadius(structure.symbols[i]), s: structure.symbols[i] }))
    .filter((a) => !skip.has(a.s));
  if (atoms.length === 0) return null;

  let maxClearance = 0;
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const gf = [ix / nx, iy / ny, iz / nz];
        let clearance = Infinity;
        for (const atom of atoms) {
          // Minimum image in fractional space, then to Cartesian.
          const df = [
            gf[0] - atom.f[0],
            gf[1] - atom.f[1],
            gf[2] - atom.f[2],
          ].map((v) => v - Math.round(v));
          const d = applyMat3(df, cell);
          const dist = Math.hypot(d[0], d[1], d[2]) - atom.r;
          if (dist < clearance) clearance = dist;
        }
        const v = Math.max(0, clearance);
        raw[(ix * ny + iy) * nz + iz] = v;
        if (v > maxClearance) maxClearance = v;
      }
    }
  }

  const scale = maxClearance > 1e-9 ? 1 / maxClearance : 1;
  const values = new Array<number>(raw.length);
  let openCount = 0;
  for (let i = 0; i < raw.length; i++) {
    values[i] = raw[i] * scale;
    if (values[i] > 0.5) openCount++;
  }

  return {
    cell,
    shape,
    values,
    void_fraction: openCount / values.length,
    pore_diameter_A: maxClearance * 2,
  };
}

export interface SyntheticAdsorption {
  symbols: string[];
  cell: number[][];
  positions: number[][];
  guests: { symbols: string[]; positions: number[][]; energy_ev: number }[];
}

/**
 * Place water guests at the most open points of the structure.
 *
 * Sites are picked greedily from the void grid with a minimum separation so
 * two guests never overlap. Binding energies are a plausible spread, not a
 * calculation — this payload exists to exercise the renderer.
 */
export function syntheticAdsorptionSites(
  structure: StructureData,
  nGuests = 3,
  shape: [number, number, number] = [24, 24, 24],
): SyntheticAdsorption | null {
  const grid = syntheticVoidGrid(structure, shape);
  if (!grid) return null;
  const cell = grid.cell;
  const [nx, ny, nz] = grid.shape;

  const candidates: { pos: number[]; score: number }[] = [];
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const score = grid.values[(ix * ny + iy) * nz + iz];
        if (score < 0.75) continue;
        candidates.push({
          pos: applyMat3([ix / nx, iy / ny, iz / nz], cell),
          score,
        });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const chosen: number[][] = [];
  const minSeparation = 3.6;
  for (const c of candidates) {
    if (chosen.length >= nGuests) break;
    const tooClose = chosen.some(
      (p) => Math.hypot(p[0] - c.pos[0], p[1] - c.pos[1], p[2] - c.pos[2]) < minSeparation,
    );
    if (!tooClose) chosen.push(c.pos);
  }

  // A water molecule, roughly at its equilibrium geometry, with each copy
  // given a different orientation so the view does not look stamped.
  const water = (center: number[], phase: number) => {
    const d = 0.958;
    const half = (104.5 / 2) * (Math.PI / 180);
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    const rot = (v: number[]) => [
      v[0] * c - v[1] * s + center[0],
      v[0] * s + v[1] * c + center[1],
      v[2] + center[2],
    ];
    return [
      [...center],
      rot([d * Math.sin(half), d * Math.cos(half), 0]),
      rot([-d * Math.sin(half), d * Math.cos(half), 0]),
    ];
  };

  const guests = chosen.map((center, i) => ({
    symbols: ["O", "H", "H"],
    positions: water(center, i * 1.1),
    energy_ev: -0.52 - i * 0.17,
  }));

  return {
    symbols: structure.symbols,
    cell,
    positions: structure.positions,
    guests,
  };
}
