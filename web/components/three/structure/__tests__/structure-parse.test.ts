/**
 * CIF parser and lattice geometry, validated against the real fixture CIFs.
 *
 * Run: see `register.mjs`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  boundingSphere,
  cartesianToFractional,
  cellParamsToMatrix,
  cifFormulaSum,
  composition,
  determinant3,
  expandSupercell,
  fractionalToCartesian,
  inferBonds,
  invert3,
  matrixToCellParams,
  minimumImage,
  parseCif,
  parsePdb,
  parseSmiles,
  parseStructure,
  parseXyz,
  unwrapPath,
} from "../../../../lib/structure-parse";
import {
  cifDeclaredCell,
  findCandidate,
  loadArtifacts,
  loadCandidates,
  listCampaigns,
  parseFormulaSum,
} from "./fixtures";

const close = (a: number, b: number, tol: number, what = "") =>
  assert.ok(
    Math.abs(a - b) <= tol,
    `${what}: expected ${b} +/- ${tol}, got ${a} (diff ${Math.abs(a - b)})`,
  );

// ---------------------------------------------------------------------------
// Lattice maths
// ---------------------------------------------------------------------------

test("cellParamsToMatrix: cubic cell is diagonal", () => {
  const m = cellParamsToMatrix({ a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 });
  assert.ok(m);
  close(m[0][0], 4, 1e-9, "ax");
  close(m[0][1], 0, 1e-9, "ay");
  close(m[1][1], 4, 1e-9, "by");
  close(m[2][2], 4, 1e-9, "cz");
  close(determinant3(m), 64, 1e-6, "volume");
});

test("cellParamsToMatrix: hexagonal cell has the textbook form", () => {
  // a = b, gamma = 120: b = (-a/2, a*sqrt(3)/2, 0), c along +z.
  const a = 3.2;
  const c = 5.2;
  const m = cellParamsToMatrix({ a, b: a, c, alpha: 90, beta: 90, gamma: 120 });
  assert.ok(m);
  close(m[1][0], -a / 2, 1e-9, "bx");
  close(m[1][1], (a * Math.sqrt(3)) / 2, 1e-9, "by");
  close(m[2][2], c, 1e-9, "cz");
  // Volume of a hexagonal cell: a^2 c sin(120).
  close(Math.abs(determinant3(m)), a * a * c * Math.sin((120 * Math.PI) / 180), 1e-6, "volume");
});

test("cellParamsToMatrix / matrixToCellParams round-trip (triclinic)", () => {
  const p = { a: 7.3, b: 9.1, c: 11.7, alpha: 83.4, beta: 97.2, gamma: 112.8 };
  const m = cellParamsToMatrix(p);
  assert.ok(m);
  const back = matrixToCellParams(m);
  for (const k of ["a", "b", "c", "alpha", "beta", "gamma"] as const) {
    close(back[k], p[k], 1e-6, `round-trip ${k}`);
  }
});

test("cellParamsToMatrix rejects impossible cells", () => {
  assert.equal(cellParamsToMatrix({ a: 0, b: 1, c: 1, alpha: 90, beta: 90, gamma: 90 }), null);
  // alpha=beta=10, gamma=170 has no real embedding.
  assert.equal(
    cellParamsToMatrix({ a: 5, b: 5, c: 5, alpha: 10, beta: 10, gamma: 170 }),
    null,
  );
});

test("fractional <-> Cartesian round-trips through a skewed cell", () => {
  const m = cellParamsToMatrix({
    a: 11.0096,
    b: 11.0096,
    c: 6.024,
    alpha: 90,
    beta: 90,
    gamma: 120,
  });
  assert.ok(m);
  const frac = [0.1234, 0.8765, 0.4321];
  const cart = fractionalToCartesian(frac, m);
  const back = cartesianToFractional(cart, m);
  assert.ok(back);
  for (let i = 0; i < 3; i++) close(back[i], frac[i], 1e-9, `frac[${i}]`);
});

test("invert3 returns null for a singular matrix", () => {
  assert.equal(invert3([[1, 0, 0], [2, 0, 0], [0, 0, 1]]), null);
});

test("minimumImage finds the wrapped neighbour, not the in-cell distance", () => {
  const cell = [[10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const mi = minimumImage([0.5, 0, 0], [9.5, 0, 0], cell);
  assert.ok(mi);
  close(mi.distance, 1, 1e-9, "wrapped distance");
  assert.deepEqual(mi.shift, [-1, 0, 0]);
});

// ---------------------------------------------------------------------------
// Real fixture CIFs
// ---------------------------------------------------------------------------

const CAMPAIGNS = listCampaigns();

test("fixture campaigns and candidates are present", () => {
  assert.ok(CAMPAIGNS.length > 0, "no campaign directories found");
  const all = CAMPAIGNS.flatMap((c) => loadCandidates(c));
  assert.ok(all.length > 0, "no candidates found in any events.jsonl");
});

test("every fixture CIF parses, and its cell matches what the file declares", () => {
  let checked = 0;
  for (const campaign of CAMPAIGNS) {
    for (const cand of loadCandidates(campaign)) {
      if (cand.repr_kind !== "cif") continue;
      const parsed = parseCif(cand.structure);
      assert.ok(parsed, `${cand.id}: parseCif returned null`);
      assert.ok(parsed.cell, `${cand.id}: no cell recovered`);

      const declared = cifDeclaredCell(cand.structure);
      const recovered = matrixToCellParams(parsed.cell);
      for (const k of ["a", "b", "c"] as const) {
        close(recovered[k], declared[k], 1e-6, `${cand.id} length ${k}`);
      }
      for (const k of ["alpha", "beta", "gamma"] as const) {
        close(recovered[k], declared[k], 1e-5, `${cand.id} angle ${k}`);
      }

      // Physically sensible cell for a solid electrolyte unit cell.
      for (const k of ["a", "b", "c"] as const) {
        assert.ok(
          recovered[k] > 2 && recovered[k] < 60,
          `${cand.id}: ${k} = ${recovered[k]} A is not a plausible cell length`,
        );
      }
      assert.ok(parsed.pbc, `${cand.id}: should be periodic`);
      checked++;
    }
  }
  assert.ok(checked >= 4, `expected several CIFs, checked ${checked}`);
});

test("parsed composition matches _chemical_formula_sum", () => {
  let checked = 0;
  for (const campaign of CAMPAIGNS) {
    for (const cand of loadCandidates(campaign)) {
      if (cand.repr_kind !== "cif") continue;
      const sum = cifFormulaSum(cand.structure);
      if (!sum) continue;
      const expected = parseFormulaSum(sum);
      const parsed = parseCif(cand.structure);
      assert.ok(parsed);
      const got = composition(parsed.symbols);
      assert.deepEqual(
        got,
        expected,
        `${cand.id}: composition ${JSON.stringify(got)} != formula_sum "${sum}"`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 4);
});

test("Li3PS4 (c-mp-1097036) parses to the known cell and composition", () => {
  const cand = findCandidate("c-mp-1097036");
  assert.ok(cand, "c-mp-1097036 missing from the fixtures");
  const parsed = parseCif(cand.structure);
  assert.ok(parsed);
  assert.ok(parsed.cell);

  const p = matrixToCellParams(parsed.cell);
  close(p.a, 6.11139853, 1e-6, "a");
  close(p.b, 7.86250837, 1e-6, "b");
  close(p.c, 13.34790049, 1e-6, "c");
  close(p.alpha, 90, 1e-6, "alpha");
  close(p.beta, 90, 1e-6, "beta");
  close(p.gamma, 90, 1e-6, "gamma");

  assert.equal(parsed.symbols.length, 32);
  assert.deepEqual(composition(parsed.symbols), { Li: 12, P: 4, S: 16 });

  // Site labels must have their digits stripped: "Li10" is lithium, not
  // something unknown.
  assert.ok(parsed.symbols.every((s) => ["Li", "P", "S"].includes(s)));
});

test("Li3ErCl6 (c-mp-676361) handles e-notation fractions and a 120 deg cell", () => {
  const cand = findCandidate("c-mp-676361");
  assert.ok(cand);
  // The file really does contain exponent-notation coordinates.
  assert.match(cand.structure, /e-0\d/);

  const parsed = parseCif(cand.structure);
  assert.ok(parsed);
  assert.ok(parsed.cell);
  const p = matrixToCellParams(parsed.cell);
  close(p.a, 11.009576286916273, 1e-6, "a");
  close(p.c, 6.024006200279149, 1e-6, "c");
  close(p.gamma, 120.0018612464941, 1e-5, "gamma");
  assert.deepEqual(composition(parsed.symbols), { Li: 9, Er: 3, Cl: 18 });

  // Every atom must land back inside [0, 1) in fractional space (the e-05
  // coordinates are essentially 0, which is the easy case to get wrong).
  for (const pos of parsed.positions) {
    const f = cartesianToFractional(pos, parsed.cell);
    assert.ok(f);
    for (const v of f) assert.ok(v > -1e-6 && v < 1 + 1e-6, `fraction ${v} out of range`);
  }
});

test("CIF fractional->Cartesian reproduces the artifact's own frame 0", () => {
  // An orthorhombic cell is in its canonical orientation already, so the CIF
  // and the MACE artifact must agree atom for atom. This is the strongest
  // single check that the lattice convention and ordering are right.
  const artifacts = loadArtifacts().filter(
    (a) => a.campaign === "fixture" && a.name === "a-relax-c-mp-1097036.json",
  );
  assert.equal(artifacts.length, 1, "a-relax-c-mp-1097036.json not found");
  const payload = artifacts[0].payload as {
    symbols: string[];
    frames: number[][][];
  };
  const cand = findCandidate("c-mp-1097036");
  assert.ok(cand);
  const parsed = parseCif(cand.structure);
  assert.ok(parsed);

  assert.deepEqual(parsed.symbols, payload.symbols);
  const frame0 = payload.frames[0];
  for (let i = 0; i < frame0.length; i++) {
    for (let k = 0; k < 3; k++) {
      close(
        parsed.positions[i][k],
        frame0[i][k],
        1e-3,
        `atom ${i} (${parsed.symbols[i]}) component ${k}`,
      );
    }
  }
});

test("non-orthogonal artifact cells agree with the CIF up to a rigid rotation", () => {
  // Li3ErCl6's artifact lattice is a = [5.5046, -9.5347, -0.0001]: the same
  // lattice as the CIF, differently oriented. Lengths and angles must match;
  // the matrices must not be expected to.
  const art = loadArtifacts().find(
    (a) => a.campaign === "fixture" && a.name === "a-relax-c-mp-676361.json",
  );
  assert.ok(art);
  const cand = findCandidate("c-mp-676361");
  assert.ok(cand);
  const parsed = parseCif(cand.structure);
  assert.ok(parsed && parsed.cell);

  const fromCif = matrixToCellParams(parsed.cell);
  const fromArtifact = matrixToCellParams(art.payload.cell as number[][]);
  for (const k of ["a", "b", "c"] as const) {
    close(fromArtifact[k], fromCif[k], 1e-3, `length ${k}`);
  }
  for (const k of ["alpha", "beta", "gamma"] as const) {
    close(fromArtifact[k], fromCif[k], 1e-2, `angle ${k}`);
  }
});

// ---------------------------------------------------------------------------
// Parser robustness
// ---------------------------------------------------------------------------

test("parseCif accepts Cartesian coordinates and quoted values", () => {
  const cif = `data_test
_cell_length_a 10.0
_cell_length_b 10.0
_cell_length_c 10.0
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_chemical_formula_sum "C1 O2"
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_Cartn_x
_atom_site_Cartn_y
_atom_site_Cartn_z
C1 C 0.0 0.0 0.0
O1 O 1.16 0.0 0.0
O2 O -1.16 0.0 0.0
`;
  const parsed = parseCif(cif);
  assert.ok(parsed);
  assert.deepEqual(parsed.symbols, ["C", "O", "O"]);
  assert.deepEqual(parsed.positions[1], [1.16, 0, 0]);
  assert.equal(cifFormulaSum(cif), "C1 O2");
});

test("parseCif strips standard-uncertainty suffixes", () => {
  const cif = `data_x
_cell_length_a 5.431(2)
_cell_length_b 5.431(2)
_cell_length_c 5.431(2)
_cell_angle_alpha 90.0
_cell_angle_beta 90.0
_cell_angle_gamma 90.0
loop_
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Si 0.0 0.0 0.0
Si 0.25(1) 0.25 0.25
`;
  const parsed = parseCif(cif);
  assert.ok(parsed && parsed.cell);
  close(matrixToCellParams(parsed.cell).a, 5.431, 1e-9, "a");
  close(parsed.positions[1][0], 5.431 * 0.25, 1e-9, "x");
});

test("parseCif drops low-occupancy duplicate sites", () => {
  const cif = `data_x
_cell_length_a 5
_cell_length_b 5
_cell_length_c 5
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Li 0.0 0.0 0.0 1.0
Li 0.1 0.0 0.0 0.25
`;
  const parsed = parseCif(cif);
  assert.ok(parsed);
  assert.equal(parsed.symbols.length, 1);
});

test("malformed input returns null rather than throwing", () => {
  assert.equal(parseCif(""), null);
  assert.equal(parseCif("not a cif at all"), null);
  // A cell but no atom_site loop.
  assert.equal(
    parseCif("data_x\n_cell_length_a 5\n_cell_length_b 5\n_cell_length_c 5\n"),
    null,
  );
  // Fractional coordinates with no cell cannot be placed.
  assert.equal(
    parseCif(
      "data_x\nloop_\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\nLi 0 0 0\n",
    ),
    null,
  );
  assert.equal(parseCif(undefined as unknown as string), null);
  assert.equal(parseXyz("garbage"), null);
  assert.equal(parsePdb("garbage"), null);
  assert.equal(parseSmiles("CCO"), null);
  assert.equal(parseStructure("CCO", "smiles"), null);
  assert.equal(parseStructure("whatever", "mol2"), null);
});

test("a truncated CIF still yields the atoms it managed to write", () => {
  const cand = findCandidate("c-mp-1097036");
  assert.ok(cand);
  const lines = cand.structure.split("\n");
  const truncated = lines.slice(0, lines.length - 10).join("\n");
  const parsed = parseCif(truncated);
  assert.ok(parsed, "a half-written CIF should still parse");
  assert.ok(parsed.symbols.length > 0 && parsed.symbols.length < 32);
});

test("parseXyz reads an extended-XYZ lattice", () => {
  const xyz = `3
Lattice="5.0 0.0 0.0 0.0 5.0 0.0 0.0 0.0 5.0" Properties=species:S:1:pos:R:3
O 0.0 0.0 0.0
H 0.76 0.59 0.0
H -0.76 0.59 0.0
`;
  const parsed = parseXyz(xyz);
  assert.ok(parsed);
  assert.deepEqual(parsed.symbols, ["O", "H", "H"]);
  assert.ok(parsed.cell);
  close(matrixToCellParams(parsed.cell).a, 5, 1e-9, "a");
});

test("parsePdb reads ATOM records by column", () => {
  const pdb =
    "ATOM      1  N   MET A   1      11.104   6.134  -6.504  1.00  0.00           N\n" +
    "HETATM    2  O   HOH A   2       3.000   4.000   5.000  1.00  0.00           O\n";
  const parsed = parsePdb(pdb);
  assert.ok(parsed);
  assert.deepEqual(parsed.symbols, ["N", "O"]);
  close(parsed.positions[0][0], 11.104, 1e-9, "x");
  assert.equal(parsed.cell, null);
});

// ---------------------------------------------------------------------------
// Bonds
// ---------------------------------------------------------------------------

test("inferBonds recovers all four PS4 tetrahedra in Li3PS4", () => {
  const cand = findCandidate("c-mp-1097036");
  assert.ok(cand);
  const s = parseCif(cand.structure);
  assert.ok(s);

  // Lithium is excluded by default in StructureView, and the P-S framework is
  // what the tetrahedra are made of.
  const bonds = inferBonds(s.symbols, s.positions, s.cell, s.pbc, {
    exclude: ["Li"],
  });

  const perP = new Map<number, number>();
  for (const b of bonds) {
    const si = s.symbols[b.i];
    const sj = s.symbols[b.j];
    assert.ok(
      (si === "P" && sj === "S") || (si === "S" && sj === "P"),
      `unexpected ${si}-${sj} bond`,
    );
    const p = si === "P" ? b.i : b.j;
    perP.set(p, (perP.get(p) ?? 0) + 1);
  }
  assert.equal(bonds.length, 16, "four PS4 units = 16 P-S bonds");
  assert.equal(perP.size, 4, "four distinct P atoms");
  for (const [p, n] of perP) assert.equal(n, 4, `P at index ${p} has ${n} S neighbours`);
});

test("inferBonds wraps bonds across the cell boundary", () => {
  // Two atoms 1 A apart, but across the periodic boundary of a 10 A cell.
  const cell = [[10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const bonds = inferBonds(
    ["C", "C"],
    [[0.5, 5, 5], [9.5, 5, 5]],
    cell,
    true,
    { exclude: [] },
  );
  assert.equal(bonds.length, 1);
  assert.notDeepEqual(bonds[0].shift, [0, 0, 0], "bond should carry a lattice shift");
  close(bonds[0].distance, 1, 1e-9, "wrapped bond length");

  // The same pair with pbc off must not be bonded (they are 9 A apart).
  assert.equal(
    inferBonds(["C", "C"], [[0.5, 5, 5], [9.5, 5, 5]], cell, false, { exclude: [] }).length,
    0,
  );
});

test("inferBonds bonds an atom to its own periodic image in a tiny cell", () => {
  const cell = [[1.4, 0, 0], [0, 12, 0], [0, 0, 12]];
  const bonds = inferBonds(["C"], [[0, 6, 6]], cell, true, { exclude: [] });
  // Exactly one bond, to the +a image (not also to -a: that is the same bond).
  assert.equal(bonds.length, 1);
  assert.equal(bonds[0].i, 0);
  assert.equal(bonds[0].j, 0);
  assert.deepEqual(bonds[0].shift, [1, 0, 0]);
});

test("inferBonds image range accounts for skewed cells", () => {
  // The Na3PS4 artifact cell is bcc-primitive: every row is (3.47, 3.47, 3.47)
  // after permutation, so edge lengths are 6 A while the perpendicular width
  // is only 4 A. Using lengths instead of heights misses neighbours.
  const art = loadArtifacts().find((a) => a.name === "a-relax-c-mp-985584.json");
  assert.ok(art, "a-relax-c-mp-985584.json not found");
  const payload = art.payload as { symbols: string[]; cell: number[][]; frames: number[][][] };
  const bonds = inferBonds(
    payload.symbols,
    payload.frames[0],
    payload.cell,
    true,
    { exclude: ["Na"] },
  );
  // One PS4 tetrahedron in the primitive cell.
  assert.equal(bonds.length, 4, `expected 4 P-S bonds, got ${bonds.length}`);
});

test("inferBonds excludes alkali cations by request", () => {
  const cand = findCandidate("c-mp-1097036");
  assert.ok(cand);
  const s = parseCif(cand.structure);
  assert.ok(s);
  const withLi = inferBonds(s.symbols, s.positions, s.cell, s.pbc, { exclude: [] });
  const withoutLi = inferBonds(s.symbols, s.positions, s.cell, s.pbc, { exclude: ["Li"] });
  assert.ok(
    withLi.length > withoutLi.length,
    "Li-S contacts are inside the covalent cutoff, so excluding Li must reduce the bond count",
  );
});

test("inferBonds tolerates garbage without throwing", () => {
  assert.deepEqual(inferBonds([], [], null, false), []);
  assert.deepEqual(
    inferBonds(["C", "C"], [[0, 0, 0], [NaN, 0, 0]], null, false, { exclude: [] }),
    [],
  );
  // A degenerate cell must fall back to the non-periodic path, not divide by 0.
  const bonds = inferBonds(
    ["C", "C"],
    [[0, 0, 0], [1.4, 0, 0]],
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    true,
    { exclude: [] },
  );
  assert.equal(bonds.length, 1);
});

// ---------------------------------------------------------------------------
// Supercell, framing, paths
// ---------------------------------------------------------------------------

test("expandSupercell multiplies atoms and scales the lattice", () => {
  const cand = findCandidate("c-mp-1097036");
  assert.ok(cand);
  const s = parseCif(cand.structure);
  assert.ok(s && s.cell);
  const big = expandSupercell(s, 2, 2, 1);
  assert.equal(big.symbols.length, 32 * 4);
  assert.equal(big.positions.length, 32 * 4);
  const p0 = matrixToCellParams(s.cell);
  const p1 = matrixToCellParams(big.cell as number[][]);
  close(p1.a, p0.a * 2, 1e-6, "a doubled");
  close(p1.b, p0.b * 2, 1e-6, "b doubled");
  close(p1.c, p0.c, 1e-6, "c unchanged");
  // Composition is preserved per image.
  assert.deepEqual(composition(big.symbols), { Li: 48, P: 16, S: 64 });
});

test("expandSupercell is a no-op for 1x1x1 and for molecules", () => {
  const s = parseXyz("1\n\nC 0 0 0\n");
  assert.ok(s);
  assert.equal(expandSupercell(s, 1, 1, 1), s);
  assert.equal(expandSupercell(s, 2, 2, 2), s, "no cell: cannot tile");
});

test("a 300-atom supercell with bonds builds in well under a second", () => {
  const cand = findCandidate("c-mp-1097036");
  assert.ok(cand);
  const s = parseCif(cand.structure);
  assert.ok(s);
  const big = expandSupercell(s, 2, 2, 2); // 256 atoms
  const started = Date.now();
  const bonds = inferBonds(big.symbols, big.positions, big.cell, big.pbc, {
    exclude: ["Li"],
  });
  const elapsed = Date.now() - started;
  assert.equal(bonds.length, 16 * 8);
  assert.ok(elapsed < 800, `bond inference took ${elapsed} ms`);
});

test("boundingSphere encloses the atoms and the cell corners", () => {
  const cand = findCandidate("c-mp-1097036");
  assert.ok(cand);
  const s = parseCif(cand.structure);
  assert.ok(s && s.cell);
  const sphere = boundingSphere(s);
  for (const p of s.positions) {
    const d = Math.hypot(
      p[0] - sphere.center[0],
      p[1] - sphere.center[1],
      p[2] - sphere.center[2],
    );
    assert.ok(d <= sphere.radius + 1e-6, `atom at distance ${d} outside radius ${sphere.radius}`);
  }
  // The far cell corner must fit too, or the camera clips the wireframe box.
  const far = [
    s.cell[0][0] + s.cell[1][0] + s.cell[2][0],
    s.cell[0][1] + s.cell[1][1] + s.cell[2][1],
    s.cell[0][2] + s.cell[1][2] + s.cell[2][2],
  ];
  const d = Math.hypot(
    far[0] - sphere.center[0],
    far[1] - sphere.center[1],
    far[2] - sphere.center[2],
  );
  assert.ok(d <= sphere.radius + 1e-6, "cell corner outside the bounding sphere");
});

test("boundingSphere survives empty and non-finite input", () => {
  const empty = boundingSphere([]);
  assert.equal(empty.radius, 1);
  const nanny = boundingSphere([[NaN, 0, 0], [1, 1, 1]]);
  assert.ok(Number.isFinite(nanny.radius) && nanny.radius > 0);
});

test("unwrapPath makes a boundary-crossing hop continuous", () => {
  const cell = [[10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const frames = [
    [[9.5, 5, 5]],
    [[9.9, 5, 5]],
    [[0.3, 5, 5]], // wrapped
  ];
  const path = unwrapPath(frames, 0, cell);
  assert.equal(path.length, 3);
  // Without unwrapping the last step would be -9.6 A; unwrapped it is +0.4.
  close(path[2][0] - path[1][0], 0.4, 1e-9, "final step");
  for (let i = 1; i < path.length; i++) {
    const step = Math.hypot(
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1],
      path[i][2] - path[i - 1][2],
    );
    assert.ok(step < 1, `step ${i} is ${step} A — path was not unwrapped`);
  }
});

test("every real NEB path is already continuous (no spurious unwrapping)", () => {
  const nebs = loadArtifacts().filter((a) => typeof a.payload.mobile_index === "number");
  assert.ok(nebs.length > 0, "no NEB artifacts found");
  for (const art of nebs) {
    const p = art.payload as {
      frames: number[][][];
      cell: number[][];
      mobile_index: number;
    };
    const path = unwrapPath(p.frames, p.mobile_index, p.cell);
    assert.equal(path.length, p.frames.length, `${art.name}: path length`);
    for (let i = 0; i < path.length; i++) {
      for (let k = 0; k < 3; k++) {
        close(path[i][k], p.frames[i][p.mobile_index][k], 1e-9, `${art.name} frame ${i}`);
      }
    }
  }
});
