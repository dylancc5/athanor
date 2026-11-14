/**
 * Structure parsing and geometry: CIF/XYZ text -> scene data, lattice maths,
 * periodic bond inference, supercell expansion, camera framing.
 *
 * No chemistry library is available in this project, so everything here is
 * written from scratch. Pure functions, no three.js import — this module is
 * safe to use from tests and from the server.
 *
 * Conventions (see `components/three/CONTRACT.md`):
 *  - positions are Cartesian angstroms,
 *  - `cell` rows are the lattice vectors a, b, c,
 *  - lattice vectors map straight to world axes (a -> x, b -> y, c -> z).
 */

import { covalentRadius, normalizeElement } from "../components/three/elements";
import type {
  Bond,
  BoundingSphere,
  Cell,
  CellParameters,
  Frame,
  StructureData,
  Vec3,
} from "../components/three/structure/types";

export type {
  Bond,
  BoundingSphere,
  Cell,
  CellParameters,
  Frame,
  StructureData,
  Vec3,
} from "../components/three/structure/types";

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Small linear algebra on 3x3 row-major matrices
// ---------------------------------------------------------------------------

export type Mat3 = number[][];

export function isFiniteVec3(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2])
  );
}

/** True when `m` is a usable 3x3 matrix of finite numbers with nonzero volume. */
export function isValidCell(m: unknown): m is Mat3 {
  if (!Array.isArray(m) || m.length !== 3) return false;
  for (const row of m) if (!isFiniteVec3(row)) return false;
  return Math.abs(determinant3(m as Mat3)) > 1e-8;
}

export function determinant3(m: Mat3): number {
  const [a, b, c] = m;
  return (
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0])
  );
}

/** Inverse of a 3x3 matrix, or null when singular. */
export function invert3(m: Mat3): Mat3 | null {
  const det = determinant3(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const [a, b, c] = m;
  const inv = [
    [b[1] * c[2] - b[2] * c[1], a[2] * c[1] - a[1] * c[2], a[1] * b[2] - a[2] * b[1]],
    [b[2] * c[0] - b[0] * c[2], a[0] * c[2] - a[2] * c[0], a[2] * b[0] - a[0] * b[2]],
    [b[0] * c[1] - b[1] * c[0], a[1] * c[0] - a[0] * c[1], a[0] * b[1] - a[1] * b[0]],
  ];
  return inv.map((row) => row.map((v) => v / det));
}

/** Row-vector times matrix: `v . M`, i.e. sum_k v[k] * M[k]. */
export function applyMat3(v: number[], m: Mat3): Vec3 {
  return [
    v[0] * m[0][0] + v[1] * m[1][0] + v[2] * m[2][0],
    v[0] * m[0][1] + v[1] * m[1][1] + v[2] * m[2][1],
    v[0] * m[0][2] + v[1] * m[1][2] + v[2] * m[2][2],
  ];
}

export function cross3(a: number[], b: number[]): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function norm3(v: number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

// ---------------------------------------------------------------------------
// Cell parameters <-> lattice matrix
// ---------------------------------------------------------------------------

/**
 * Standard crystallographic convention: a along +x, b in the xy plane,
 * c completing a right-handed set.
 *
 * Note this produces the *canonical* orientation. Artifact payloads carry
 * their own already-oriented matrix (which may differ from this by a rigid
 * rotation) — use theirs as given, don't rebuild it from parameters.
 */
export function cellParamsToMatrix(p: CellParameters): Mat3 | null {
  const { a, b, c } = p;
  if (!(a > 0) || !(b > 0) || !(c > 0)) return null;
  const al = p.alpha * DEG;
  const be = p.beta * DEG;
  const ga = p.gamma * DEG;
  const cosAl = Math.cos(al);
  const cosBe = Math.cos(be);
  const cosGa = Math.cos(ga);
  const sinGa = Math.sin(ga);
  if (Math.abs(sinGa) < 1e-12) return null;

  const cx = c * cosBe;
  const cy = (c * (cosAl - cosBe * cosGa)) / sinGa;
  const cz2 = c * c - cx * cx - cy * cy;
  if (cz2 <= 0) return null; // inconsistent angles

  return [
    [a, 0, 0],
    [b * cosGa, b * sinGa, 0],
    [cx, cy, Math.sqrt(cz2)],
  ];
}

/** Recover conventional cell parameters from a lattice matrix. */
export function matrixToCellParams(m: Mat3): CellParameters {
  const [va, vb, vc] = m;
  const a = norm3(va);
  const b = norm3(vb);
  const c = norm3(vc);
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ang = (u: number[], v: number[], lu: number, lv: number) => {
    if (lu < 1e-12 || lv < 1e-12) return 90;
    const t = Math.max(-1, Math.min(1, dot(u, v) / (lu * lv)));
    return (Math.acos(t) * 180) / Math.PI;
  };
  return {
    a,
    b,
    c,
    alpha: ang(vb, vc, b, c),
    beta: ang(va, vc, a, c),
    gamma: ang(va, vb, a, b),
  };
}

/** Fractional -> Cartesian. */
export function fractionalToCartesian(frac: number[], cell: Mat3): Vec3 {
  return applyMat3(frac, cell);
}

/** Cartesian -> fractional. Returns null when the cell is singular. */
export function cartesianToFractional(cart: number[], cell: Mat3): Vec3 | null {
  const inv = invert3(cell);
  if (!inv) return null;
  return applyMat3(cart, inv);
}

/** Perpendicular widths of the cell along each lattice direction. */
export function cellHeights(cell: Mat3): Vec3 {
  const vol = Math.abs(determinant3(cell));
  const [a, b, c] = cell;
  const areaBC = norm3(cross3(b, c));
  const areaAC = norm3(cross3(a, c));
  const areaAB = norm3(cross3(a, b));
  return [
    areaBC > 1e-12 ? vol / areaBC : Infinity,
    areaAC > 1e-12 ? vol / areaAC : Infinity,
    areaAB > 1e-12 ? vol / areaAB : Infinity,
  ];
}

/**
 * Shortest vector from `from` to `to` under periodic boundary conditions,
 * together with the integer lattice shift applied to `to`.
 *
 * Uses the fractional round trick, then a small 3x3x3 search around it so the
 * result is correct for strongly skewed cells too (the round trick alone is
 * not the true minimum image for non-reduced cells).
 */
export function minimumImage(
  from: number[],
  to: number[],
  cell: Mat3,
  inv?: Mat3 | null,
): { vector: Vec3; shift: Vec3; distance: number } | null {
  const ci = inv ?? invert3(cell);
  if (!ci) return null;
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const f = applyMat3(d, ci);
  const base: Vec3 = [-Math.round(f[0]), -Math.round(f[1]), -Math.round(f[2])];

  let best: { vector: Vec3; shift: Vec3; distance: number } | null = null;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let dk = -1; dk <= 1; dk++) {
        const shift: Vec3 = [base[0] + di, base[1] + dj, base[2] + dk];
        const t = applyMat3(shift, cell);
        const v: Vec3 = [d[0] + t[0], d[1] + t[1], d[2] + t[2]];
        const dist = norm3(v);
        if (!best || dist < best.distance) best = { vector: v, shift, distance: dist };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// CIF parsing
// ---------------------------------------------------------------------------

/** Strip a CIF standard-uncertainty suffix and parse: `6.1114(3)` -> 6.1114. */
function cifNumber(token: string | undefined): number {
  if (token == null) return NaN;
  const cleaned = token.trim().replace(/\((\d+)\)\s*$/, "");
  if (cleaned === "" || cleaned === "?" || cleaned === ".") return NaN;
  return Number(cleaned);
}

/**
 * Split a CIF data line into tokens, honouring single and double quotes.
 * Comments (`#` outside quotes) are dropped.
 */
function tokenizeCifLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "#") break;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let buf = "";
      while (i < n && line[i] !== quote) buf += line[i++];
      i++; // closing quote
      out.push(buf);
      continue;
    }
    let buf = "";
    while (i < n && line[i] !== " " && line[i] !== "\t") buf += line[i++];
    out.push(buf);
  }
  return out;
}

/**
 * Parse a CIF into a single structure (first data block, P1 coordinates as
 * listed — symmetry operations are not expanded; ATHANOR's generators emit P1).
 *
 * Returns null for anything unusable rather than throwing: this runs on live
 * stream data.
 */
export function parseCif(text: string): StructureData | null {
  if (typeof text !== "string" || text.trim() === "") return null;

  const rawLines = text.split(/\r\n|\r|\n/);

  // Join multi-line semicolon text fields into their tag so they don't confuse
  // the loop reader.
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.startsWith(";")) {
      // swallow until the closing semicolon line
      i++;
      while (i < rawLines.length && !rawLines[i].startsWith(";")) i++;
      continue;
    }
    lines.push(line);
  }

  const items = new Map<string, string>();
  type Loop = { tags: string[]; rows: string[][] };
  const loops: Loop[] = [];

  let i = 0;
  let sawDataBlock = false;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const lower = trimmed.toLowerCase();

    if (lower.startsWith("data_")) {
      if (sawDataBlock) break; // only the first block
      sawDataBlock = true;
      i++;
      continue;
    }

    if (lower === "loop_" || lower.startsWith("loop_")) {
      i++;
      const tags: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("_")) {
        tags.push(lines[i].trim().split(/\s+/)[0].toLowerCase());
        i++;
      }
      const rows: string[][] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t === "" || t.startsWith("#")) {
          i++;
          continue;
        }
        if (t.startsWith("_") || t.toLowerCase().startsWith("loop_") || t.toLowerCase().startsWith("data_")) {
          break;
        }
        const toks = tokenizeCifLine(lines[i]);
        i++;
        if (toks.length === 0) continue;
        // Some writers wrap long rows; accumulate until we have enough tokens.
        while (toks.length < tags.length && i < lines.length) {
          const more = tokenizeCifLine(lines[i]);
          if (more.length === 0 || lines[i].trim().startsWith("_")) break;
          toks.push(...more);
          i++;
        }
        if (toks.length >= tags.length) rows.push(toks.slice(0, tags.length));
      }
      loops.push({ tags, rows });
      continue;
    }

    if (trimmed.startsWith("_")) {
      const toks = tokenizeCifLine(line);
      const tag = toks[0].toLowerCase();
      if (toks.length >= 2) {
        items.set(tag, toks.slice(1).join(" "));
      } else if (i + 1 < lines.length) {
        // value on the following line
        const next = tokenizeCifLine(lines[i + 1]);
        if (next.length && !next[0].startsWith("_")) {
          items.set(tag, next.join(" "));
          i++;
        }
      }
      i++;
      continue;
    }

    i++;
  }

  // --- cell -------------------------------------------------------------
  const params: CellParameters = {
    a: cifNumber(items.get("_cell_length_a")),
    b: cifNumber(items.get("_cell_length_b")),
    c: cifNumber(items.get("_cell_length_c")),
    alpha: cifNumber(items.get("_cell_angle_alpha")),
    beta: cifNumber(items.get("_cell_angle_beta")),
    gamma: cifNumber(items.get("_cell_angle_gamma")),
  };
  const haveCell =
    Number.isFinite(params.a) &&
    Number.isFinite(params.b) &&
    Number.isFinite(params.c) &&
    Number.isFinite(params.alpha) &&
    Number.isFinite(params.beta) &&
    Number.isFinite(params.gamma);
  const cell = haveCell ? cellParamsToMatrix(params) : null;

  // --- atom site loop ---------------------------------------------------
  const siteLoop = loops.find((l) => l.tags.some((t) => t.startsWith("_atom_site")));
  if (!siteLoop) return null;

  const col = (name: string) => siteLoop.tags.indexOf(name);
  const iType = col("_atom_site_type_symbol");
  const iLabel = col("_atom_site_label");
  const iFx = col("_atom_site_fract_x");
  const iFy = col("_atom_site_fract_y");
  const iFz = col("_atom_site_fract_z");
  const iCx = col("_atom_site_cartn_x");
  const iCy = col("_atom_site_cartn_y");
  const iCz = col("_atom_site_cartn_z");
  const iOcc = col("_atom_site_occupancy");

  const fractional = iFx >= 0 && iFy >= 0 && iFz >= 0;
  const cartesian = iCx >= 0 && iCy >= 0 && iCz >= 0;
  if (!fractional && !cartesian) return null;
  if (fractional && !cell) return null; // fractional coords need a cell

  const symbols: string[] = [];
  const positions: Frame = [];

  for (const row of siteLoop.rows) {
    const rawSymbol = iType >= 0 ? row[iType] : iLabel >= 0 ? row[iLabel] : "";
    const element = normalizeElement(rawSymbol) || normalizeElement(iLabel >= 0 ? row[iLabel] : "");
    if (!element) continue;

    // Drop partially-occupied duplicates below half occupancy: drawing both
    // images of a disordered site looks like a clash.
    if (iOcc >= 0) {
      const occ = cifNumber(row[iOcc]);
      if (Number.isFinite(occ) && occ < 0.5) continue;
    }

    let pos: Vec3;
    if (fractional) {
      const f = [cifNumber(row[iFx]), cifNumber(row[iFy]), cifNumber(row[iFz])];
      if (!isFiniteVec3(f)) continue;
      pos = fractionalToCartesian(f, cell as Mat3);
    } else {
      const c = [cifNumber(row[iCx]), cifNumber(row[iCy]), cifNumber(row[iCz])];
      if (!isFiniteVec3(c)) continue;
      pos = [c[0], c[1], c[2]];
    }
    symbols.push(element);
    positions.push(pos);
  }

  if (symbols.length === 0) return null;

  return { symbols, cell, pbc: cell != null, positions };
}

/** `_chemical_formula_sum` from a CIF, if present. */
export function cifFormulaSum(text: string): string | null {
  const m = text.match(/_chemical_formula_sum\s+("([^"]*)"|'([^']*)'|(\S+))/i);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim() || null;
}

// ---------------------------------------------------------------------------
// XYZ parsing
// ---------------------------------------------------------------------------

/** Standard XYZ. Honours an extended-XYZ `Lattice="..."` comment line. */
export function parseXyz(text: string): StructureData | null {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length < 2) return null;
  const count = parseInt(lines[0].trim(), 10);
  if (!Number.isFinite(count) || count <= 0) return null;

  let cell: Mat3 | null = null;
  const lat = lines[1].match(/Lattice\s*=\s*"([^"]+)"/i);
  if (lat) {
    const nums = lat[1].trim().split(/\s+/).map(Number);
    if (nums.length === 9 && nums.every(Number.isFinite)) {
      cell = [nums.slice(0, 3), nums.slice(3, 6), nums.slice(6, 9)];
      if (!isValidCell(cell)) cell = null;
    }
  }

  const symbols: string[] = [];
  const positions: Frame = [];
  for (let k = 0; k < count && 2 + k < lines.length; k++) {
    const toks = lines[2 + k].trim().split(/\s+/);
    if (toks.length < 4) continue;
    const element = normalizeElement(toks[0]);
    const p = [Number(toks[1]), Number(toks[2]), Number(toks[3])];
    if (!element || !isFiniteVec3(p)) continue;
    symbols.push(element);
    positions.push([p[0], p[1], p[2]]);
  }
  if (symbols.length === 0) return null;
  return { symbols, cell, pbc: cell != null, positions };
}

// ---------------------------------------------------------------------------
// PDB / SMILES
// ---------------------------------------------------------------------------

/**
 * Minimal PDB reader: ATOM/HETATM records only, no connectivity, no chains.
 * Deliberately shallow — ATHANOR no longer renders proteins. Kept so a `pdb`
 * repr_kind coming down the event stream degrades to something drawable
 * instead of a blank panel.
 */
export function parsePdb(text: string): StructureData | null {
  if (typeof text !== "string") return null;
  const symbols: string[] = [];
  const positions: Frame = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.startsWith("ATOM") && !line.startsWith("HETATM")) continue;
    const x = Number(line.slice(30, 38));
    const y = Number(line.slice(38, 46));
    const z = Number(line.slice(46, 54));
    if (!isFiniteVec3([x, y, z])) continue;
    const element =
      normalizeElement(line.slice(76, 78)) || normalizeElement(line.slice(12, 16));
    if (!element) continue;
    symbols.push(element);
    positions.push([x, y, z]);
  }
  if (symbols.length === 0) return null;
  return { symbols, cell: null, pbc: false, positions };
}

/**
 * SMILES is not supported: turning a SMILES string into 3D coordinates needs a
 * conformer generator (ETKDG or similar), which is not available here and is
 * well out of scope for a visualization layer. Returns null so callers fall
 * back to a 2D/text view rather than drawing something wrong.
 */
export function parseSmiles(_smiles: string): StructureData | null {
  return null;
}

/** Dispatch on an event-stream `repr_kind`. */
export function parseStructure(
  text: string,
  kind: "cif" | "smiles" | "pdb" | "xyz" | string,
): StructureData | null {
  switch (kind) {
    case "cif":
      return parseCif(text);
    case "xyz":
      return parseXyz(text);
    case "pdb":
      return parsePdb(text);
    case "smiles":
      return parseSmiles(text);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Bond inference
// ---------------------------------------------------------------------------

export interface BondOptions {
  /** Bond when d < tolerance * (r_i + r_j). */
  tolerance?: number;
  /** Elements never bonded to anything (drawn as free ions). */
  exclude?: readonly string[];
  /** Hard upper bound on bond length, angstroms. */
  maxDistance?: number;
}

const DEFAULT_TOLERANCE = 1.15;
const MIN_BOND = 0.4;

/**
 * Infer bonds by distance, handling periodic images so bonds wrap correctly
 * across cell boundaries.
 *
 * For every ordered pair i <= j we test every lattice image within the range
 * implied by the cell's perpendicular widths (not its edge lengths — those are
 * wrong for a skewed cell such as a bcc primitive lattice). Self-bonds across
 * an image are allowed: in a small cell an atom really is bonded to its own
 * periodic copy.
 *
 * O(N^2 * images). At 300 atoms with a 3x3x3 image range that is ~1.2M checks,
 * a few milliseconds — a spatial grid is not worth the complexity here.
 */
export function inferBonds(
  symbols: string[],
  positions: Frame,
  cell: Cell,
  pbc: boolean,
  options: BondOptions = {},
): Bond[] {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const exclude = new Set(options.exclude ?? []);
  const n = Math.min(symbols.length, positions.length);
  if (n === 0) return [];

  const radii = new Array<number>(n);
  const skip = new Array<boolean>(n);
  for (let k = 0; k < n; k++) {
    radii[k] = covalentRadius(symbols[k]);
    skip[k] = exclude.has(symbols[k]);
  }
  let maxRadius = 0;
  for (let k = 0; k < n; k++) if (!skip[k]) maxRadius = Math.max(maxRadius, radii[k]);
  const globalCut = Math.min(
    options.maxDistance ?? Infinity,
    tolerance * 2 * maxRadius,
  );
  if (!(globalCut > 0)) return [];

  const usePbc = pbc && isValidCell(cell);
  const lattice = usePbc ? (cell as Mat3) : null;

  // Image range: how many cells along each lattice direction can reach within
  // the cutoff, derived from perpendicular widths.
  let ra = 0;
  let rb = 0;
  let rc = 0;
  if (lattice) {
    const h = cellHeights(lattice);
    ra = Math.min(3, Math.max(1, Math.ceil(globalCut / h[0])));
    rb = Math.min(3, Math.max(1, Math.ceil(globalCut / h[1])));
    rc = Math.min(3, Math.max(1, Math.ceil(globalCut / h[2])));
  }

  // Precompute image translation vectors.
  const shifts: Vec3[] = [];
  const translations: Vec3[] = [];
  if (lattice) {
    for (let ia = -ra; ia <= ra; ia++) {
      for (let ib = -rb; ib <= rb; ib++) {
        for (let ic = -rc; ic <= rc; ic++) {
          shifts.push([ia, ib, ic]);
          translations.push(applyMat3([ia, ib, ic], lattice));
        }
      }
    }
  } else {
    shifts.push([0, 0, 0]);
    translations.push([0, 0, 0]);
  }

  const bonds: Bond[] = [];
  const cut2 = globalCut * globalCut;
  const min2 = MIN_BOND * MIN_BOND;

  for (let i = 0; i < n; i++) {
    if (skip[i]) continue;
    const pi = positions[i];
    if (!isFiniteVec3(pi)) continue;
    for (let j = i; j < n; j++) {
      if (skip[j]) continue;
      const pj = positions[j];
      if (!isFiniteVec3(pj)) continue;
      const pairCut = tolerance * (radii[i] + radii[j]);
      const pairCut2 = Math.min(pairCut * pairCut, cut2);
      const dx0 = pj[0] - pi[0];
      const dy0 = pj[1] - pi[1];
      const dz0 = pj[2] - pi[2];

      for (let s = 0; s < shifts.length; s++) {
        const t = translations[s];
        const dx = dx0 + t[0];
        const dy = dy0 + t[1];
        const dz = dz0 + t[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > pairCut2 || d2 < min2) continue;
        const sh = shifts[s];
        // For i === j, keep only one of each +/- image pair.
        if (i === j) {
          if (sh[0] < 0) continue;
          if (sh[0] === 0 && sh[1] < 0) continue;
          if (sh[0] === 0 && sh[1] === 0 && sh[2] <= 0) continue;
        }
        bonds.push({ i, j, shift: sh, distance: Math.sqrt(d2) });
      }
    }
  }
  return bonds;
}

/**
 * Neighbours of atom `index` as Cartesian offsets from it, periodic images
 * resolved. Used to build coordination polyhedra.
 */
export function neighborsOf(
  index: number,
  symbols: string[],
  positions: Frame,
  cell: Cell,
  pbc: boolean,
  options: BondOptions & { maxNeighbors?: number } = {},
): { index: number; position: Vec3; distance: number }[] {
  const tolerance = options.tolerance ?? 1.35; // polyhedra want ionic contacts too
  const n = Math.min(symbols.length, positions.length);
  if (index < 0 || index >= n) return [];
  const pi = positions[index];
  if (!isFiniteVec3(pi)) return [];

  const usePbc = pbc && isValidCell(cell);
  const lattice = usePbc ? (cell as Mat3) : null;
  const ri = covalentRadius(symbols[index]);

  const found: { index: number; position: Vec3; distance: number }[] = [];
  const maxCut = tolerance * (ri + 2.6);
  let ra = 0;
  let rb = 0;
  let rc = 0;
  if (lattice) {
    const h = cellHeights(lattice);
    ra = Math.min(2, Math.max(1, Math.ceil(maxCut / h[0])));
    rb = Math.min(2, Math.max(1, Math.ceil(maxCut / h[1])));
    rc = Math.min(2, Math.max(1, Math.ceil(maxCut / h[2])));
  }

  for (let j = 0; j < n; j++) {
    const pj = positions[j];
    if (!isFiniteVec3(pj)) continue;
    const cut = tolerance * (ri + covalentRadius(symbols[j]));
    const cut2 = cut * cut;
    for (let ia = -ra; ia <= ra; ia++) {
      for (let ib = -rb; ib <= rb; ib++) {
        for (let ic = -rc; ic <= rc; ic++) {
          const t: Vec3 = lattice ? applyMat3([ia, ib, ic], lattice) : [0, 0, 0];
          const x = pj[0] + t[0];
          const y = pj[1] + t[1];
          const z = pj[2] + t[2];
          const d2 = (x - pi[0]) ** 2 + (y - pi[1]) ** 2 + (z - pi[2]) ** 2;
          if (d2 > cut2 || d2 < min2OrZero()) continue;
          found.push({ index: j, position: [x, y, z], distance: Math.sqrt(d2) });
        }
      }
    }
  }
  found.sort((p, q) => p.distance - q.distance);
  const limit = options.maxNeighbors ?? 12;
  return found.slice(0, limit);
}

function min2OrZero(): number {
  return MIN_BOND * MIN_BOND;
}

// ---------------------------------------------------------------------------
// Supercell
// ---------------------------------------------------------------------------

/**
 * Tile the structure `nx * ny * nz` times. The returned cell is the enlarged
 * lattice, so bond inference on the result still wraps correctly.
 */
export function expandSupercell(
  data: StructureData,
  nx: number,
  ny: number,
  nz: number,
): StructureData {
  const a = Math.max(1, Math.floor(nx) || 1);
  const b = Math.max(1, Math.floor(ny) || 1);
  const c = Math.max(1, Math.floor(nz) || 1);
  if (a === 1 && b === 1 && c === 1) return data;
  if (!isValidCell(data.cell)) return data;
  const cell = data.cell as Mat3;

  const symbols: string[] = [];
  const positions: Frame = [];
  for (let ia = 0; ia < a; ia++) {
    for (let ib = 0; ib < b; ib++) {
      for (let ic = 0; ic < c; ic++) {
        const t = applyMat3([ia, ib, ic], cell);
        for (let k = 0; k < data.positions.length; k++) {
          const p = data.positions[k];
          if (!isFiniteVec3(p)) continue;
          symbols.push(data.symbols[k]);
          positions.push([p[0] + t[0], p[1] + t[1], p[2] + t[2]]);
        }
      }
    }
  }
  const newCell: Mat3 = [
    cell[0].map((v) => v * a),
    cell[1].map((v) => v * b),
    cell[2].map((v) => v * c),
  ];
  return { symbols, cell: newCell, pbc: data.pbc, positions };
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Sphere enclosing the drawn content, for camera framing.
 *
 * Includes the eight cell corners when a cell is present (the wireframe box is
 * drawn, so it has to fit) and pads by the largest display radius.
 */
export function boundingSphere(
  input: StructureData | Frame,
  options: { includeCell?: boolean; pad?: number } = {},
): BoundingSphere {
  let positions: Frame;
  let cell: Cell = null;
  if (Array.isArray(input)) {
    positions = input;
  } else {
    positions = input.positions ?? [];
    cell = input.cell;
  }

  const points: number[][] = positions.filter(isFiniteVec3);
  if ((options.includeCell ?? true) && isValidCell(cell)) {
    const m = cell as Mat3;
    for (let ia = 0; ia <= 1; ia++) {
      for (let ib = 0; ib <= 1; ib++) {
        for (let ic = 0; ic <= 1; ic++) {
          points.push(applyMat3([ia, ib, ic], m));
        }
      }
    }
  }

  if (points.length === 0) return { center: [0, 0, 0], radius: 1 };

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] > maxZ) maxZ = p[2];
  }
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  let radius = 0;
  for (const p of points) {
    const d = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
    if (d > radius) radius = d;
  }
  radius += options.pad ?? 0.9;
  return { center, radius: Math.max(radius, 1) };
}

/** Bounding sphere over every frame of a trajectory, so the camera never jumps. */
export function trajectoryBoundingSphere(
  frames: Frame[],
  cell: Cell,
  options: { pad?: number } = {},
): BoundingSphere {
  const all: Frame = [];
  for (const f of frames ?? []) for (const p of f ?? []) if (isFiniteVec3(p)) all.push(p);
  return boundingSphere({ symbols: [], cell, pbc: cell != null, positions: all }, options);
}

/** Composition counts, for formula checks. */
export function composition(symbols: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of symbols) out[s] = (out[s] ?? 0) + 1;
  return out;
}

/**
 * Unwrap a single atom's path across frames so a periodic jump becomes a
 * continuous line. NEB endpoints can sit on opposite sides of the cell; a raw
 * lerp between them streaks the ion across the whole box.
 */
export function unwrapPath(frames: Frame[], index: number, cell: Cell): Vec3[] {
  const out: Vec3[] = [];
  if (!Array.isArray(frames) || frames.length === 0) return out;
  const inv = isValidCell(cell) ? invert3(cell as Mat3) : null;
  let prev: Vec3 | null = null;
  for (const frame of frames) {
    const p = frame?.[index];
    if (!isFiniteVec3(p)) continue;
    let cur: Vec3 = [p[0], p[1], p[2]];
    if (prev && inv) {
      const mi = minimumImage(prev, cur, cell as Mat3, inv);
      if (mi) cur = [prev[0] + mi.vector[0], prev[1] + mi.vector[1], prev[2] + mi.vector[2]];
    }
    out.push(cur);
    prev = cur;
  }
  return out;
}
