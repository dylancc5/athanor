/**
 * Payload acceptance and geometry kernels.
 *
 * The components themselves are `.tsx`, which Node's type stripping cannot
 * load (no JSX support) and which need a WebGL context anyway. So the contract
 * guarantee — "accept every real payload, render `null` on a malformed one" —
 * is tested here at the gate every component actually funnels through: the
 * `normalize*` functions, each of which returns `null` exactly when its
 * component does. The components are additionally mounted for real against
 * these same payloads, plus malformed variants, in the browser pass, which
 * asserts zero console errors.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { neighborsOf, parseCif } from "../../../../lib/structure-parse";
import {
  ELEMENT_COLORS,
  ELEMENT_RADII,
  covalentRadius,
  elementColor,
  elementRadius,
  normalizeElement,
} from "../../elements";
import { convexHullFaces } from "../convex-hull";
import { marchingTetrahedra } from "../marching-cubes";
import {
  normalizeGuests,
  normalizeIndices,
  normalizeStructure,
  normalizeSupercell,
  normalizeTrajectory,
  normalizeVoidGrid,
} from "../normalize";
import { UNPARSEABLE_ARTIFACTS, cifCandidates, loadArtifacts } from "./fixtures";

const CIFS = cifCandidates();

/** The orthorhombic thiophosphate, selected by composition rather than by id. */
function thiophosphateCif() {
  return CIFS.find((c) => {
    const parsed = parseCif(c.structure);
    if (!parsed) return false;
    const n = parsed.symbols.filter((s) => s === "P").length;
    return n === 4 && parsed.symbols.filter((s) => s === "S").length === 16;
  });
}
import { syntheticAdsorptionSites, syntheticVoidGrid } from "./synthetic";

const close = (a: number, b: number, tol: number, what = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: expected ${b} +/- ${tol}, got ${a}`);

// ---------------------------------------------------------------------------
// Element tables
// ---------------------------------------------------------------------------

test("element tables cover everything the fixtures use", () => {
  for (const s of ["Li", "Na", "P", "S", "Cl", "Er", "Al", "O", "H", "C", "N"]) {
    assert.ok(ELEMENT_COLORS[s], `no colour for ${s}`);
    assert.ok(ELEMENT_RADII[s] > 0, `no radius for ${s}`);
    assert.ok(covalentRadius(s) > 0, `no covalent radius for ${s}`);
  }
});

test("display radii are usable directly as ball-and-stick sphere radii", () => {
  // If these came out at van der Waals scale the balls would swallow the
  // sticks and every structure would look like a space-filling model.
  for (const [symbol, r] of Object.entries(ELEMENT_RADII)) {
    assert.ok(r >= 0.25 && r <= 0.8, `${symbol} display radius ${r} is out of range`);
  }
  assert.ok(ELEMENT_RADII.S > ELEMENT_RADII.O, "S should draw larger than O");
});

test("normalizeElement strips label digits and handles two-letter symbols", () => {
  assert.equal(normalizeElement("Li1"), "Li");
  assert.equal(normalizeElement("Li10"), "Li");
  assert.equal(normalizeElement("S16"), "S");
  assert.equal(normalizeElement("CL2A"), "Cl");
  assert.equal(normalizeElement("cl"), "Cl");
  assert.equal(normalizeElement(" o "), "O");
  assert.equal(normalizeElement("Er3"), "Er");
  // 'N' must not be read as 'Nb'.
  assert.equal(normalizeElement("N1"), "N");
  assert.equal(normalizeElement(""), "");
});

test("elementColor and elementRadius fall back instead of throwing", () => {
  assert.equal(elementColor("Li1"), ELEMENT_COLORS.Li);
  assert.ok(elementColor("Xx").startsWith("#"));
  assert.ok(elementRadius("Xx") > 0);
  assert.ok(covalentRadius("Xx") > 0);
});

// ---------------------------------------------------------------------------
// Every real artifact must be accepted
// ---------------------------------------------------------------------------

const ARTIFACTS = loadArtifacts();

test("every artifact on disk is at least valid JSON", () => {
  // `campaigns/fixture/artifacts/a-neb-c-mp-985583.json` contained a bare
  // `NaN` literal, which JSON.parse rejects outright — so no amount of
  // component-level robustness helps, the file never reaches a component.
  // Surfaced here rather than silently skipped by the loader.
  loadArtifacts();

  // An earlier campaign shipped an artifact whose `energies` contained a bare
  // `NaN` — valid Python, invalid JSON, unreadable by any JS consumer, and it
  // failed in the app before ever reaching a component. The regenerated
  // campaign is clean; this guards against it coming back.
  assert.deepEqual(
    UNPARSEABLE_ARTIFACTS,
    [],
    `unparseable artifact JSON (bare NaN/Infinity?): ${JSON.stringify(UNPARSEABLE_ARTIFACTS)}`,
  );
});

test("the fixture artifact set is present", () => {
  assert.ok(ARTIFACTS.length >= 8, `only found ${ARTIFACTS.length} artifacts`);
  assert.ok(
    ARTIFACTS.some((a) => typeof a.payload.mobile_index === "number"),
    "no NEB artifacts found in any campaign",
  );
  assert.ok(CIFS.length > 0, "no CIF candidates found in any campaign");
});

test("TrajectoryView accepts every real relaxation and NEB payload", () => {
  let checked = 0;
  for (const art of ARTIFACTS) {
    if (!Array.isArray(art.payload.frames)) continue;
    const data = normalizeTrajectory(art.payload);
    assert.ok(data, `${art.campaign}/${art.name}: rejected`);
    assert.ok(data.frames.length >= 1, `${art.name}: no frames`);
    assert.equal(
      data.symbols.length,
      data.frames[0].length,
      `${art.name}: symbol/position count mismatch`,
    );
    for (const frame of data.frames) {
      for (const p of frame) {
        assert.ok(p.every(Number.isFinite), `${art.name}: non-finite coordinate survived`);
      }
    }
    if (typeof art.payload.mobile_index === "number") {
      assert.equal(
        data.mobileIndex,
        art.payload.mobile_index,
        `${art.name}: mobile index lost`,
      );
    }
    checked++;
  }
  assert.ok(checked >= 8, `expected to check at least 8 payloads, checked ${checked}`);
});

test("StructureView accepts a frame-0 snapshot of every real artifact", () => {
  for (const art of ARTIFACTS) {
    const frames = art.payload.frames as number[][][] | undefined;
    if (!Array.isArray(frames)) continue;
    const data = normalizeStructure({
      symbols: art.payload.symbols,
      cell: art.payload.cell,
      pbc: art.payload.pbc,
      positions: frames[0],
    });
    assert.ok(data, `${art.name}: rejected`);
    assert.ok(data.cell, `${art.name}: lost the cell`);
    assert.equal(data.pbc, true, `${art.name}: should be periodic`);
  }
});

test("the physically-correct NEB fixtures have sane barriers and clearances", () => {
  // Guards the hero shot: if a regenerated fixture ever puts the mobile ion
  // on top of another atom again, this fails rather than shipping a video of
  // two lithiums fusing.
  const nebs = ARTIFACTS.filter((a) => typeof a.payload.mobile_index === "number");
  assert.ok(nebs.length >= 3, `expected >=3 NEB fixtures, found ${nebs.length}`);
  for (const art of nebs) {
    const p = art.payload as {
      frames: number[][][];
      cell: number[][];
      mobile_index: number;
      barrier_ev: number;
      energies: number[];
    };
    assert.ok(
      p.barrier_ev > 0.01 && p.barrier_ev < 2.0,
      `${art.name}: barrier ${p.barrier_ev} eV is not a physical Li hop`,
    );
    assert.ok(p.energies.every(Number.isFinite), `${art.name}: non-finite energy`);

    const data = normalizeTrajectory(p);
    assert.ok(data);
    for (let f = 0; f < p.frames.length; f++) {
      const m = p.frames[f][p.mobile_index];
      let nearest = Infinity;
      for (let j = 0; j < p.frames[f].length; j++) {
        if (j === p.mobile_index) continue;
        const q = p.frames[f][j];
        nearest = Math.min(nearest, Math.hypot(q[0] - m[0], q[1] - m[1], q[2] - m[2]));
      }
      assert.ok(
        nearest > 1.4,
        `${art.name} frame ${f}: mobile ion is ${nearest.toFixed(2)} A from its neighbour`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Malformed payloads must be rejected
// ---------------------------------------------------------------------------

test("normalizeTrajectory rejects malformed payloads", () => {
  assert.equal(normalizeTrajectory(null), null);
  assert.equal(normalizeTrajectory(undefined), null);
  assert.equal(normalizeTrajectory("nope"), null);
  assert.equal(normalizeTrajectory({}), null);
  assert.equal(normalizeTrajectory({ symbols: [], frames: [] }), null);
  assert.equal(normalizeTrajectory({ symbols: ["Li"], frames: [] }), null);
  assert.equal(normalizeTrajectory({ symbols: ["Li"] }), null);
  // Symbols that are not strings.
  assert.equal(normalizeTrajectory({ symbols: [3], frames: [[[0, 0, 0]]] }), null);
  // Every frame unusable.
  assert.equal(
    normalizeTrajectory({ symbols: ["Li"], frames: [[[0, 0]]] }),
    null,
    "2-component coordinates must be rejected",
  );
  assert.equal(
    normalizeTrajectory({ symbols: ["Li"], frames: [[[NaN, 0, 0]]] }),
    null,
    "NaN coordinates must be rejected",
  );
});

test("a truncated real artifact degrades rather than exploding", () => {
  const art = ARTIFACTS.find((a) => typeof a.payload.mobile_index === "number");
  assert.ok(art);
  const payload = art.payload as {
    symbols: string[];
    cell: number[][];
    frames: number[][][];
    energies: number[];
    mobile_index: number;
  };

  // Case 1: the file was cut off mid-frame. The complete frames still play.
  const halfWritten = {
    ...payload,
    frames: [...payload.frames.slice(0, 4), payload.frames[4].slice(0, 7)],
  };
  const partial = normalizeTrajectory(halfWritten);
  assert.ok(partial, "complete frames should still be usable");
  assert.equal(partial.frames.length, 4, "the half-written frame should be dropped");

  // Case 2: a diverged image wrote NaN. That frame is dropped, the rest plays,
  // and the energies stay aligned to the frames that survived.
  const diverged = {
    ...payload,
    frames: payload.frames.map((f, i) =>
      i === 5 ? f.map(() => [NaN, NaN, NaN]) : f,
    ),
  };
  const survived = normalizeTrajectory(diverged);
  assert.ok(survived);
  assert.equal(survived.frames.length, payload.frames.length - 1);
  assert.equal(survived.energies?.length, payload.frames.length - 1);
  assert.equal(survived.energies?.[5], payload.energies[6], "energies must be realigned");

  // Case 3: the cell is garbage. The structure still draws, as a molecule.
  const noCell = normalizeTrajectory({ ...payload, cell: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] });
  assert.ok(noCell);
  assert.equal(noCell.cell, null);
  assert.equal(noCell.pbc, false);

  // Case 4: mobile_index out of range is dropped, not trusted.
  const badMobile = normalizeTrajectory({ ...payload, mobile_index: 99999 });
  assert.ok(badMobile);
  assert.equal(badMobile.mobileIndex, undefined);
});

test("normalizeTrajectory tolerates a partly non-finite energy list", () => {
  const data = normalizeTrajectory({
    symbols: ["Li", "Li"],
    cell: null,
    frames: [
      [[0, 0, 0], [2, 0, 0]],
      [[0.5, 0, 0], [2, 0, 0]],
      [[1, 0, 0], [2, 0, 0]],
    ],
    energies: [-10, null, -10.5],
  });
  assert.ok(data);
  assert.equal(data.energies?.length, 3);
  assert.ok(Number.isNaN(data.energies?.[1]), "the bad entry becomes NaN, not 0");
});

test("normalizeStructure rejects malformed payloads", () => {
  assert.equal(normalizeStructure(null), null);
  assert.equal(normalizeStructure({}), null);
  assert.equal(normalizeStructure({ symbols: ["Li"] }), null);
  assert.equal(normalizeStructure({ symbols: [], positions: [] }), null);
  assert.equal(normalizeStructure({ symbols: ["Li"], positions: [] }), null);
  assert.equal(normalizeStructure({ symbols: ["Li"], positions: [[1, 2]] }), null);
  assert.equal(normalizeStructure({ symbols: ["Li"], positions: [[1, 2, "x"]] }), null);
});

test("normalizeStructure clips a truncated position list to the atoms it has", () => {
  const data = normalizeStructure({
    symbols: ["Li", "P", "S", "S"],
    positions: [[0, 0, 0], [1, 1, 1]],
    cell: null,
  });
  assert.ok(data);
  assert.equal(data.symbols.length, 2);
  assert.deepEqual(data.symbols, ["Li", "P"]);
});

test("normalizeVoidGrid rejects malformed grids", () => {
  const cell = [[10, 0, 0], [0, 10, 0], [0, 0, 10]];
  assert.equal(normalizeVoidGrid(null), null);
  assert.equal(normalizeVoidGrid({ cell: null, shape: [4, 4, 4], values: [] }), null);
  assert.equal(normalizeVoidGrid({ cell, shape: [4, 4], values: [] }), null);
  assert.equal(normalizeVoidGrid({ cell, shape: [1, 4, 4], values: new Array(16) }), null);
  // Values shorter than the declared shape.
  assert.equal(normalizeVoidGrid({ cell, shape: [4, 4, 4], values: new Array(10).fill(0) }), null);
  // Absurd grid sizes are refused rather than locking the tab up.
  assert.equal(
    normalizeVoidGrid({ cell, shape: [400, 400, 400], values: { length: 64e6 } }),
    null,
  );
  // The happy path.
  assert.ok(normalizeVoidGrid({ cell, shape: [4, 4, 4], values: new Array(64).fill(0.5) }));
});

test("normalizeGuests drops bad guests and keeps good ones", () => {
  const guests = normalizeGuests([
    { symbols: ["O", "H", "H"], positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], energy_ev: -0.4 },
    { symbols: ["O"], positions: [[NaN, 0, 0]] },
    null,
    { symbols: "O", positions: [] },
    { symbols: ["N", "N"], positions: [[0, 0, 0], [1.1, 0, 0]], energy_ev: "bad" },
  ]);
  assert.equal(guests.length, 2);
  assert.equal(guests[0].energy_ev, -0.4);
  assert.equal(guests[1].energy_ev, undefined, "a non-numeric energy is dropped");
  assert.deepEqual(normalizeGuests(null), []);
  assert.deepEqual(normalizeGuests("x"), []);
});

test("normalizeIndices and normalizeSupercell clamp hostile input", () => {
  assert.deepEqual(normalizeIndices([0, 2, 2, -1, 99, 1.5, "x"], 3), [0, 2]);
  assert.deepEqual(normalizeIndices(null, 3), []);
  assert.deepEqual(normalizeSupercell(undefined, 32), [1, 1, 1]);
  assert.deepEqual(normalizeSupercell([2, 2, 2], 32), [2, 2, 2]);
  assert.deepEqual(normalizeSupercell([0, -3, 1.9], 32), [1, 1, 1]);
  // 10x10x10 of a 32-atom cell is 32000 atoms: must be clamped.
  const clamped = normalizeSupercell([10, 10, 10], 32);
  assert.ok(
    clamped[0] * clamped[1] * clamped[2] * 32 <= 4000,
    `supercell ${clamped} was not clamped`,
  );
});

// ---------------------------------------------------------------------------
// Convex hull (coordination polyhedra)
// ---------------------------------------------------------------------------

test("convexHullFaces: regular tetrahedron has 4 faces", () => {
  const pts = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  assert.equal(convexHullFaces(pts).length, 4);
});

test("convexHullFaces: octahedron has 8 faces", () => {
  const pts = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  assert.equal(convexHullFaces(pts).length, 8);
});

test("convexHullFaces: cube's square faces are fan-triangulated, not duplicated", () => {
  const pts: number[][] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) pts.push([x, y, z]);
  // 6 square faces x 2 triangles. A naive per-triple hull would emit 4
  // overlapping triangles per face and z-fight.
  assert.equal(convexHullFaces(pts).length, 12);
});

test("convexHullFaces: interior points do not create faces", () => {
  const pts = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1], [0, 0, 0]];
  const faces = convexHullFaces(pts);
  assert.equal(faces.length, 4);
  assert.ok(faces.every((f) => !f.includes(4)), "the interior point is on a face");
});

test("convexHullFaces: hull faces are wound outwards", () => {
  const pts = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  const faces = convexHullFaces(pts);
  const centroid = [0, 0, 0];
  for (const [a, b, c] of faces) {
    const u = pts[b].map((v, i) => v - pts[a][i]);
    const v = pts[c].map((w, i) => w - pts[a][i]);
    const n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const toFace = pts[a].map((w, i) => w - centroid[i]);
    const dot = n[0] * toFace[0] + n[1] * toFace[1] + n[2] * toFace[2];
    assert.ok(dot > 0, "face normal points inwards");
  }
});

test("convexHullFaces: degenerate input yields no faces", () => {
  assert.deepEqual(convexHullFaces([]), []);
  assert.deepEqual(convexHullFaces([[0, 0, 0], [1, 0, 0], [0, 1, 0]]), []);
  // All coplanar: no volume to shade.
  assert.deepEqual(
    convexHullFaces([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]]),
    [],
  );
  // All coincident.
  assert.deepEqual(
    convexHullFaces([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]),
    [],
  );
});

test("convexHullFaces builds a PS4 tetrahedron from real Li3PS4 coordinates", () => {
  const cand = thiophosphateCif();
  assert.ok(cand);
  const s = parseCif(cand.structure);
  assert.ok(s);

  // Neighbours must be found with periodic images resolved — in this cell one
  // of the four S of the first P is across a cell boundary, and a plain
  // in-cell search finds a 4.15 A "neighbour" instead of the real 2.1 A one.
  const pIndex = s.symbols.indexOf("P");
  const shell = neighborsOf(pIndex, s.symbols, s.positions, s.cell, s.pbc, {
    maxNeighbors: 4,
  }).filter((n) => s.symbols[n.index] === "S");
  assert.equal(shell.length, 4, "a PS4 unit has four S neighbours");

  for (const n of shell) {
    assert.ok(
      n.distance > 1.9 && n.distance < 2.3,
      `P-S distance ${n.distance.toFixed(3)} A is not tetrahedral`,
    );
  }
  assert.equal(convexHullFaces(shell.map((n) => n.position as number[])).length, 4);
});

// ---------------------------------------------------------------------------
// Marching tetrahedra (VoidSurface)
// ---------------------------------------------------------------------------

/** A sphere of radius `r` (in fractional units) centred in a cubic cell. */
function sphereField(n: number, r: number): number[] {
  const values = new Array<number>(n * n * n);
  for (let ix = 0; ix < n; ix++) {
    for (let iy = 0; iy < n; iy++) {
      for (let iz = 0; iz < n; iz++) {
        const d = Math.hypot(ix / n - 0.5, iy / n - 0.5, iz / n - 0.5);
        values[(ix * n + iy) * n + iz] = d < r ? 1 : 0;
      }
    }
  }
  return values;
}

test("marchingTetrahedra produces a watertight mesh", () => {
  const n = 20;
  const cell = [[10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const result = marchingTetrahedra(sphereField(n, 0.25), [n, n, n], cell, 0.5);
  assert.ok(result, "no surface extracted");
  assert.ok(result.triangleCount > 100, `only ${result.triangleCount} triangles`);

  // Watertight means every undirected edge is shared by exactly two triangles.
  const edges = new Map<string, number>();
  for (let t = 0; t < result.indices.length; t += 3) {
    const tri = [result.indices[t], result.indices[t + 1], result.indices[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const bad = [...edges.values()].filter((c) => c !== 2);
  assert.equal(bad.length, 0, `${bad.length} non-manifold edges — the surface has cracks`);
});

test("marchingTetrahedra geometry sits where the field says it should", () => {
  const n = 24;
  const radiusFrac = 0.25;
  const a = 12;
  const cell = [[a, 0, 0], [0, a, 0], [0, 0, a]];
  const result = marchingTetrahedra(sphereField(n, radiusFrac), [n, n, n], cell, 0.5);
  assert.ok(result);

  // Every vertex should lie near the sphere of radius 0.25*a about the centre.
  const expected = radiusFrac * a;
  let minR = Infinity;
  let maxR = -Infinity;
  for (let i = 0; i < result.positions.length; i += 3) {
    const r = Math.hypot(
      result.positions[i] - a / 2,
      result.positions[i + 1] - a / 2,
      result.positions[i + 2] - a / 2,
    );
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  }
  // One grid spacing of tolerance, since the field is a hard 0/1 step.
  const spacing = a / n;
  close((minR + maxR) / 2, expected, spacing, "surface radius");

  // Normals must be unit length (smooth shading depends on it).
  for (let i = 0; i < result.normals.length; i += 3) {
    const len = Math.hypot(result.normals[i], result.normals[i + 1], result.normals[i + 2]);
    close(len, 1, 1e-5, "normal length");
  }
});

test("marchingTetrahedra respects a non-orthogonal lattice", () => {
  // In a sheared cell, a field that is constant in fractional space must
  // produce geometry that is sheared the same way. Checks the surface is
  // transformed by the lattice rather than assuming a cubic box.
  const n = 16;
  const sheared = [[10, 0, 0], [5, 8.66, 0], [0, 0, 10]];
  const result = marchingTetrahedra(sphereField(n, 0.3), [n, n, n], sheared, 0.5);
  assert.ok(result);
  // Fractional centre (0.5, 0.5, 0.5) maps to (7.5, 4.33, 5).
  let cx = 0;
  let cy = 0;
  const count = result.positions.length / 3;
  for (let i = 0; i < result.positions.length; i += 3) {
    cx += result.positions[i] / count;
    cy += result.positions[i + 1] / count;
  }
  close(cx, 7.5, 0.4, "sheared centroid x");
  close(cy, 4.33, 0.4, "sheared centroid y");
});

test("marchingTetrahedra returns null when there is no surface to find", () => {
  const cell = [[10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const n = 8;
  assert.equal(marchingTetrahedra(new Array(n ** 3).fill(0), [n, n, n], cell, 0.5), null);
  assert.equal(marchingTetrahedra(new Array(n ** 3).fill(1), [n, n, n], cell, 0.5), null);
  assert.equal(marchingTetrahedra([0, 1], [1, 1, 2], cell, 0.5), null, "degenerate shape");
  assert.equal(marchingTetrahedra([0, 1], [4, 4, 4], cell, 0.5), null, "values too short");
});

test("a surface that reaches the cell boundary is open only there", () => {
  // A field that is solid only in the middle third along x: the two pore walls
  // span the whole y-z cross-section, so they are genuinely clipped at the
  // cell faces and cannot be closed. What must NOT happen is a crack in the
  // interior, so every open edge is required to lie on a cell face.
  const n = 16;
  const cell = [[10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const values = new Array<number>(n ** 3);
  for (let ix = 0; ix < n; ix++) {
    for (let iy = 0; iy < n; iy++) {
      for (let iz = 0; iz < n; iz++) {
        // Solid only in the middle third along x.
        values[(ix * n + iy) * n + iz] = ix > n / 3 && ix < (2 * n) / 3 ? 0 : 1;
      }
    }
  }
  const result = marchingTetrahedra(values, [n, n, n], cell, 0.5);
  assert.ok(result);

  const edges = new Map<string, { count: number; a: number; b: number }>();
  for (let t = 0; t < result.indices.length; t += 3) {
    const tri = [result.indices[t], result.indices[t + 1], result.indices[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const prev = edges.get(key);
      if (prev) prev.count++;
      else edges.set(key, { count: 1, a, b });
    }
  }

  // Cell is cubic with edge 10, so a boundary vertex has a coordinate at 0
  // or 10 (within floating-point slop).
  const onBoundary = (v: number) => {
    for (let k = 0; k < 3; k++) {
      const c = result.positions[v * 3 + k];
      if (Math.abs(c) < 1e-4 || Math.abs(c - 10) < 1e-4) return true;
    }
    return false;
  };

  let interiorCracks = 0;
  let boundaryEdges = 0;
  for (const e of edges.values()) {
    if (e.count === 2) continue;
    if (onBoundary(e.a) && onBoundary(e.b)) boundaryEdges++;
    else interiorCracks++;
  }
  assert.equal(interiorCracks, 0, `${interiorCracks} cracks away from the cell boundary`);
  assert.ok(boundaryEdges > 0, "expected the clipped surface to have a boundary");
});

// ---------------------------------------------------------------------------
// Synthetic void / adsorption payloads
// ---------------------------------------------------------------------------

test("the synthetic void grid is a valid void_grid payload with real pores", () => {
  const cand = thiophosphateCif();
  assert.ok(cand);
  const s = parseCif(cand.structure);
  assert.ok(s);
  const grid = syntheticVoidGrid(s, [24, 24, 24]);
  assert.ok(grid);
  assert.ok(normalizeVoidGrid(grid), "the generator must emit an acceptable payload");
  assert.equal(grid.values.length, 24 ** 3);
  for (const v of grid.values) assert.ok(v >= 0 && v <= 1, `value ${v} outside 0..1`);
  assert.ok(grid.void_fraction > 0 && grid.void_fraction < 1, "no pore space found");
  assert.ok(grid.pore_diameter_A > 0.2, `pore diameter ${grid.pore_diameter_A} A`);

  // And an isosurface can actually be extracted from it.
  const iso = marchingTetrahedra(grid.values, grid.shape, grid.cell, 0.5);
  assert.ok(iso, "no isosurface from the synthetic grid");
  assert.ok(iso.triangleCount > 50);
});

test("the synthetic adsorption payload is accepted and guests do not overlap", () => {
  const cand = CIFS.find((c) => parseCif(c.structure)?.symbols.includes("Cl")) ?? CIFS[0];
  assert.ok(cand);
  const s = parseCif(cand.structure);
  assert.ok(s);
  const payload = syntheticAdsorptionSites(s, 3, [20, 20, 20]);
  assert.ok(payload);
  assert.ok(normalizeStructure(payload), "host must be acceptable");
  const guests = normalizeGuests(payload.guests);
  assert.equal(guests.length, payload.guests.length);
  for (const g of guests) {
    assert.deepEqual(g.symbols, ["O", "H", "H"]);
    // O-H bond length must survive the orientation maths.
    for (let i = 1; i < 3; i++) {
      const d = Math.hypot(
        g.positions[i][0] - g.positions[0][0],
        g.positions[i][1] - g.positions[0][1],
        g.positions[i][2] - g.positions[0][2],
      );
      close(d, 0.958, 1e-6, "O-H bond length");
    }
  }
  for (let i = 0; i < guests.length; i++) {
    for (let j = i + 1; j < guests.length; j++) {
      const d = Math.hypot(
        guests[i].positions[0][0] - guests[j].positions[0][0],
        guests[i].positions[0][1] - guests[j].positions[0][1],
        guests[i].positions[0][2] - guests[j].positions[0][2],
      );
      assert.ok(d > 3.5, `guests ${i} and ${j} are ${d.toFixed(2)} A apart`);
    }
  }
});

test("syntheticVoidGrid refuses a structure with no cell", () => {
  assert.equal(
    syntheticVoidGrid({ symbols: ["C"], cell: null, pbc: false, positions: [[0, 0, 0]] }),
    null,
  );
});

test("marchingTetrahedra triangles are consistently wound", () => {
  // The decisive check on the case table. Two independent conditions:
  //  (a) every interior edge is traversed once in each direction, which is
  //      only true if neighbouring triangles agree on their winding;
  //  (b) on a sphere field, every face normal points the same way relative to
  //      the centre.
  // A single mis-wound case in the table flips shading triangle by triangle
  // and corrupts the area-weighted smooth normals.
  const n = 20;
  const a = 10;
  const cell = [[a, 0, 0], [0, a, 0], [0, 0, a]];
  const result = marchingTetrahedra(sphereField(n, 0.25), [n, n, n], cell, 0.5);
  assert.ok(result);

  const directed = new Set<string>();
  let reversedMissing = 0;
  for (let t = 0; t < result.indices.length; t += 3) {
    const tri = [result.indices[t], result.indices[t + 1], result.indices[t + 2]];
    for (let e = 0; e < 3; e++) directed.add(`${tri[e]}->${tri[(e + 1) % 3]}`);
  }
  for (const key of directed) {
    const [x, y] = key.split("->");
    if (!directed.has(`${y}->${x}`)) reversedMissing++;
  }
  assert.equal(reversedMissing, 0, `${reversedMissing} edges not traversed in both directions`);

  let outward = 0;
  let inward = 0;
  for (let t = 0; t < result.indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => {
      const i = result.indices[t + k] * 3;
      return [result.positions[i], result.positions[i + 1], result.positions[i + 2]];
    });
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const nx = u[1] * v[2] - u[2] * v[1];
    const ny = u[2] * v[0] - u[0] * v[2];
    const nz = u[0] * v[1] - u[1] * v[0];
    const r = [p[0][0] - a / 2, p[0][1] - a / 2, p[0][2] - a / 2];
    if (nx * r[0] + ny * r[1] + nz * r[2] > 0) outward++;
    else inward++;
  }
  assert.ok(
    outward === 0 || inward === 0,
    `inconsistent winding: ${outward} faces point out, ${inward} point in`,
  );
});
