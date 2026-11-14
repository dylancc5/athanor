/**
 * Core structural types. Frozen by `components/three/CONTRACT.md`.
 *
 * Positions are angstroms. `cell` is a 3x3 row-major lattice matrix whose rows
 * are the lattice vectors a, b, c. Lattice vectors map straight to world axes
 * (a -> x, b -> y, c -> z) and up is +Y.
 */

/** One frame of Cartesian coordinates: `[[x, y, z], ...]` per atom. */
export type Frame = number[][];

/** `[[ax,ay,az],[bx,by,bz],[cx,cy,cz]]`, or null for an isolated molecule. */
export type Cell = number[][] | null;

export interface StructureData {
  symbols: string[];
  cell: Cell;
  pbc: boolean;
  positions: Frame;
}

/**
 * An inferred bond. `shift` is the lattice translation (in integer cell units)
 * applied to atom `j` to reach the bonded image, so a bond that wraps across
 * the cell boundary is drawn to where the neighbour actually is rather than
 * streaking across the box.
 */
export interface Bond {
  i: number;
  j: number;
  shift: [number, number, number];
  /** Centre-to-centre distance in angstroms, for the bonded image. */
  distance: number;
}

/** Conventional cell parameters: lengths in angstroms, angles in degrees. */
export interface CellParameters {
  a: number;
  b: number;
  c: number;
  alpha: number;
  beta: number;
  gamma: number;
}

/** A sphere that encloses the content, for camera framing. */
export interface BoundingSphere {
  center: [number, number, number];
  radius: number;
}

/** Normalized payload for a relaxation trajectory or an NEB path. */
export interface TrajectoryData {
  symbols: string[];
  cell: Cell;
  pbc: boolean;
  frames: Frame[];
  energies?: number[];
  mobileIndex?: number;
}

export type Vec3 = [number, number, number];
