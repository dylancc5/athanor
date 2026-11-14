/** Triangulation, axis normalization and formatting — the numeric spine of
 *  ChemicalSpace and ParetoSurface. */

import test from "node:test";
import assert from "node:assert/strict";

import { delaunay, frontierMesh } from "../delaunay";
import {
  axisRanges,
  formatValue,
  isVec3,
  normalizeAxis,
  normalizeVec3,
  truncate,
  type Vec3,
} from "../math";
import { FIXTURE_EMBEDDING, FIXTURE_OBJECTIVES, FIXTURE_PARETO } from "./fixtures";

const AXES = FIXTURE_OBJECTIVES.map((o) => o.property) as [string, string, string];

function orientedFixturePoints(rank: number | null): Vec3[] {
  const signs = FIXTURE_OBJECTIVES.map((o) => (o.direction === "min" ? -1 : 1));
  return FIXTURE_PARETO.filter((p) => rank === null || p.rank === rank).map((p) => {
    const v = p.values as Record<string, number>;
    return [v[AXES[0]] * signs[0], v[AXES[1]] * signs[1], v[AXES[2]] * signs[2]] as Vec3;
  });
}

// ---------------------------------------------------------------------------
// axis scaling
// ---------------------------------------------------------------------------

test("axes scale to the real fixture data, not to assumed ranges", () => {
  const rows = Object.values(FIXTURE_EMBEDDING);
  const ranges = axisRanges(rows);
  assert.equal(ranges[0].min, 0);
  assert.ok(ranges[0].max > 19 && ranges[0].max < 20); // 19.414 in the log
  for (const row of rows) {
    const n = normalizeVec3(row, ranges);
    for (const c of n) assert.ok(c >= -1 - 1e-9 && c <= 1 + 1e-9, `${c} outside the unit cube`);
  }
});

test("NaN and Infinity never leak into a coordinate", () => {
  const rows: Vec3[] = [
    [0, 1, 2],
    [Number.NaN, 4, 5],
    [1, Number.POSITIVE_INFINITY, 3],
    [2, 3, Number.NaN],
  ];
  const ranges = axisRanges(rows);
  for (const row of rows) {
    for (const c of normalizeVec3(row, ranges)) assert.ok(Number.isFinite(c));
  }
  // An axis with no finite values at all collapses instead of exploding.
  const allBad = axisRanges([[Number.NaN, Number.NaN, Number.NaN]]);
  assert.deepEqual(allBad[0], { min: 0, max: 0 });
  assert.equal(normalizeAxis(5, allBad[0]), 0);
});

test("a degenerate axis (one point, or all identical) collapses to the centre", () => {
  const ranges = axisRanges([[3, 3, 3]]);
  assert.deepEqual(normalizeVec3([3, 3, 3], ranges), [0, 0, 0]);
  assert.equal(normalizeAxis(7, { min: 2, max: 2 }), 0);
});

test("isVec3 rejects the shapes a live stream actually sends", () => {
  assert.equal(isVec3([1, 2, 3]), true);
  assert.equal(isVec3([1, 2]), false);
  assert.equal(isVec3([1, 2, "3"]), false);
  assert.equal(isVec3(null), false);
  assert.equal(isVec3(undefined), false);
  assert.equal(isVec3([1, Number.NaN, 3]), false);
});

// ---------------------------------------------------------------------------
// triangulation
// ---------------------------------------------------------------------------

test("delaunay of a square gives two triangles covering it", () => {
  const tris = delaunay([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]);
  assert.equal(tris.length, 2);
  const used = new Set(tris.flat());
  assert.equal(used.size, 4);
});

test("delaunay of a random cloud is a sane triangulation", () => {
  // Deterministic pseudo-random, so a failure is reproducible.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pts = Array.from({ length: 40 }, () => ({ x: rnd(), y: rnd() }));
  const tris = delaunay(pts);
  assert.ok(tris.length >= pts.length - 2, `only ${tris.length} triangles for 40 points`);
  for (const t of tris) {
    assert.equal(new Set(t).size, 3);
    for (const i of t) assert.ok(i >= 0 && i < pts.length);
  }
});

test("delaunay degrades rather than throwing", () => {
  assert.deepEqual(delaunay([]), []);
  assert.deepEqual(delaunay([{ x: 0, y: 0 }]), []);
  assert.deepEqual(delaunay([{ x: 0, y: 0 }, { x: 1, y: 1 }]), []);
  // Collinear: no circumcircles exist, so no triangles.
  assert.deepEqual(
    delaunay([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]),
    [],
  );
  assert.deepEqual(delaunay([{ x: Number.NaN, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]), []);
});

test("the real fixture frontier (3 points) becomes one triangle", () => {
  const mesh = frontierMesh(orientedFixturePoints(0));
  assert.equal(mesh.kind, "surface");
  assert.equal(mesh.triangles.length, 1);
  assert.equal(mesh.positions.length, 3);
});

test("frontier fallbacks: empty, one point, two points, collinear, duplicates", () => {
  assert.equal(frontierMesh([]).kind, "empty");
  assert.equal(frontierMesh(null as unknown as Vec3[]).kind, "empty");

  const one = frontierMesh([[0.1, 0.2, 0.3]]);
  assert.equal(one.kind, "points");
  assert.equal(one.positions.length, 1);

  const two = frontierMesh([
    [0, 0, 0],
    [1, 1, 0],
  ]);
  assert.equal(two.kind, "polyline");
  assert.equal(two.path.length, 2);

  const collinear = frontierMesh([
    [0, 0, 0],
    [1, -1, 0],
    [2, -2, 0],
    [3, -3, 0],
  ]);
  assert.equal(collinear.kind, "polyline");
  assert.equal(collinear.path.length, 4);
  // The path is ordered along the line, so the fallback does not zig-zag.
  const xs = collinear.path.map((i) => collinear.positions[i][0]);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] !== xs[i - 1]);

  const dupes = frontierMesh([
    [0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5],
  ]);
  assert.equal(dupes.positions.length, 1);
  assert.equal(dupes.kind, "points");

  const dupesPlusOne = frontierMesh([
    [0, 0, 0],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ]);
  assert.equal(dupesPlusOne.positions.length, 3);
  assert.equal(dupesPlusOne.kind, "surface");

  const nans = frontierMesh([
    [Number.NaN, 0, 0],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ]);
  assert.equal(nans.positions.length, 3);
  assert.equal(nans.kind, "surface");
  assert.deepEqual(nans.sourceIndex, [1, 2, 3]);
});

test("a frontier of mutually non-dominated points triangulates without folding", () => {
  // Every point sums to the same total after orientation: a classic frontier.
  const pts: Vec3[] = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j + i <= 6; j++) {
      pts.push([i / 6, j / 6, (6 - i - j) / 6]);
    }
  }
  const mesh = frontierMesh(pts);
  assert.equal(mesh.kind, "surface");
  assert.ok(mesh.triangles.length >= pts.length - 2);
});

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

test("values format compactly across the magnitudes the campaign produces", () => {
  assert.equal(formatValue(0), "0");
  assert.equal(formatValue(0.0138), "0.014");
  assert.equal(formatValue(14.659), "14.66");
  assert.equal(formatValue(1234.5), "1234.5");
  assert.equal(formatValue(Number.NaN), "—");
  assert.equal(formatValue(1e-7), "1.00e-7");
});

test("statements truncate on a word boundary", () => {
  const long = FIXTURE_PARETO.length ? "a".repeat(5) : "";
  assert.equal(truncate(long, 10), long);
  const s = "Among near-hull lithium thiophosphates, a lower energy above hull predicts a lower barrier";
  const t = truncate(s, 40);
  assert.ok(t.length <= 41);
  assert.ok(t.endsWith("…"));
  assert.ok(!t.includes("  "));
  assert.equal(truncate("" as unknown as string, 10), "");
});
