/**
 * Payload validation and normalization.
 *
 * Every component in this directory funnels its props through one of these
 * functions and renders `null` when it returns null. Keeping the logic here
 * (plain TS, no JSX, no three.js) means the "malformed payload is rejected"
 * behaviour is directly unit-testable without a renderer.
 */

import { isValidCell } from "../../../lib/structure-parse";
import { normalizeElement } from "../elements";
import type { Cell, Frame, StructureData, TrajectoryData } from "./types";

function isNumberArray3(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    typeof v[2] === "number" &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2])
  );
}

/** Keep a cell only when it is a usable 3x3 matrix; otherwise treat as molecule. */
function normalizeCell(cell: unknown): Cell {
  return isValidCell(cell) ? (cell as number[][]) : null;
}

/**
 * A frame is accepted only when every atom has finite coordinates. A single
 * NaN from a diverged calculation would otherwise poison the bounding sphere
 * and blank the whole scene.
 */
function normalizeFrame(frame: unknown, natoms: number): Frame | null {
  if (!Array.isArray(frame) || frame.length < natoms) return null;
  const out: Frame = new Array(natoms);
  for (let i = 0; i < natoms; i++) {
    const p = frame[i];
    if (!isNumberArray3(p)) return null;
    out[i] = [p[0], p[1], p[2]];
  }
  return out;
}

function normalizeSymbols(symbols: unknown): string[] | null {
  if (!Array.isArray(symbols) || symbols.length === 0) return null;
  const out: string[] = new Array(symbols.length);
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    if (typeof s !== "string") return null;
    out[i] = normalizeElement(s) || s;
  }
  return out;
}

/**
 * Normalize a static structure. Truncated coordinate lists are tolerated by
 * clipping to the shorter of symbols/positions — a live stream can hand us a
 * half-written frame — but anything structurally broken returns null.
 */
export function normalizeStructure(data: unknown): StructureData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const symbols = normalizeSymbols(d.symbols);
  if (!symbols) return null;
  if (!Array.isArray(d.positions)) return null;

  const natoms = Math.min(symbols.length, d.positions.length);
  if (natoms === 0) return null;
  const positions = normalizeFrame(d.positions, natoms);
  if (!positions) return null;

  const cell = normalizeCell(d.cell);
  return {
    symbols: symbols.slice(0, natoms),
    cell,
    pbc: cell != null && d.pbc !== false,
    positions,
  };
}

/**
 * Normalize a `relaxation_trajectory` or `neb_path` payload.
 *
 * Frames that fail validation are dropped rather than failing the whole
 * payload, so a trajectory whose last image diverged still plays.
 */
export function normalizeTrajectory(data: unknown): TrajectoryData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const symbols = normalizeSymbols(d.symbols);
  if (!symbols) return null;
  if (!Array.isArray(d.frames) || d.frames.length === 0) return null;

  // Atom count is what the *best* frame can supply, capped by the symbol
  // list. Taking the minimum over all frames instead would let one truncated
  // frame silently throw away 90 atoms from every other frame.
  let widest = 0;
  for (const f of d.frames) {
    if (Array.isArray(f)) widest = Math.max(widest, f.length);
  }
  const natoms = Math.min(symbols.length, widest);
  if (natoms === 0) return null;

  const frames: Frame[] = [];
  const keptIndices: number[] = [];
  for (let k = 0; k < d.frames.length; k++) {
    const f = normalizeFrame(d.frames[k], natoms);
    if (f) {
      frames.push(f);
      keptIndices.push(k);
    }
  }
  if (frames.length === 0) return null;

  // Energies are realigned to the frames that survived, and a non-finite
  // entry becomes NaN so the readout can show "--" for that frame instead of
  // the whole payload being rejected.
  let energies: number[] | undefined;
  if (Array.isArray(d.energies)) {
    const raw = d.energies as unknown[];
    const picked = keptIndices.map((k) => {
      const v = raw[k];
      return typeof v === "number" && Number.isFinite(v) ? v : NaN;
    });
    if (picked.filter((v) => Number.isFinite(v)).length >= 2) energies = picked;
  }

  const rawMobile = d.mobile_index ?? d.mobileIndex;
  const mobileIndex =
    typeof rawMobile === "number" && Number.isInteger(rawMobile) && rawMobile >= 0 && rawMobile < natoms
      ? rawMobile
      : undefined;

  const cell = normalizeCell(d.cell);
  return {
    symbols: symbols.slice(0, natoms),
    cell,
    pbc: cell != null && d.pbc !== false,
    frames,
    energies,
    mobileIndex,
  };
}

export interface VoidGridData {
  cell: number[][];
  shape: [number, number, number];
  values: number[] | Float32Array;
}

/** Normalize a `void_grid` payload. The flat value array must match `shape`. */
export function normalizeVoidGrid(data: unknown): VoidGridData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const cell = normalizeCell(d.cell);
  if (!cell) return null;

  const shape = d.shape;
  if (!Array.isArray(shape) || shape.length !== 3) return null;
  const [nx, ny, nz] = shape.map((v) => (typeof v === "number" ? Math.floor(v) : NaN));
  if (!(nx >= 2) || !(ny >= 2) || !(nz >= 2)) return null;
  // A grid this big would lock the tab up; refuse rather than hang.
  if (nx * ny * nz > 4_000_000) return null;

  const values = d.values;
  const isTyped = values instanceof Float32Array || values instanceof Float64Array;
  if (!Array.isArray(values) && !isTyped) return null;
  const arr = values as number[] | Float32Array;
  if (arr.length < nx * ny * nz) return null;

  return { cell, shape: [nx, ny, nz], values: arr };
}

export interface GuestData {
  symbols: string[];
  positions: Frame;
  energy_ev?: number;
}

/** Normalize an `adsorption_sites` guest list. Bad guests are dropped. */
export function normalizeGuests(guests: unknown): GuestData[] {
  if (!Array.isArray(guests)) return [];
  const out: GuestData[] = [];
  for (const g of guests) {
    if (!g || typeof g !== "object") continue;
    const gg = g as Record<string, unknown>;
    const symbols = normalizeSymbols(gg.symbols);
    if (!symbols) continue;
    if (!Array.isArray(gg.positions)) continue;
    const natoms = Math.min(symbols.length, gg.positions.length);
    if (natoms === 0) continue;
    const positions = normalizeFrame(gg.positions, natoms);
    if (!positions) continue;
    const energy = gg.energy_ev;
    out.push({
      symbols: symbols.slice(0, natoms),
      positions,
      energy_ev: typeof energy === "number" && Number.isFinite(energy) ? energy : undefined,
    });
  }
  return out;
}

/** Indices that exist in a structure of `natoms` atoms, de-duplicated. */
export function normalizeIndices(indices: unknown, natoms: number): number[] {
  if (!Array.isArray(indices)) return [];
  const seen = new Set<number>();
  for (const v of indices) {
    if (typeof v !== "number" || !Number.isInteger(v)) continue;
    if (v < 0 || v >= natoms) continue;
    seen.add(v);
  }
  return [...seen];
}

/** Clamp a supercell request to something a browser can actually draw. */
export function normalizeSupercell(
  supercell: unknown,
  natoms: number,
  maxAtoms = 4000,
): [number, number, number] {
  let nx = 1;
  let ny = 1;
  let nz = 1;
  if (Array.isArray(supercell) && supercell.length === 3) {
    const vals = supercell.map((v) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1,
    );
    [nx, ny, nz] = vals as [number, number, number];
  }
  while (nx * ny * nz * natoms > maxAtoms) {
    // Shrink the largest factor until it fits.
    const largest = Math.max(nx, ny, nz);
    if (largest <= 1) break;
    if (nz === largest) nz--;
    else if (ny === largest) ny--;
    else nx--;
  }
  return [nx, ny, nz];
}
