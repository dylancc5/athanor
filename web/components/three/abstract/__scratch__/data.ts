/**
 * Data for the visual harness (see Harness.tsx). Not shipped: this directory
 * exists so the components can be rendered and judged by eye at demo
 * resolution, and to hold every edge case in one place.
 *
 * Two sources:
 *  - the real recorded campaign (`campaigns/fixture/events.jsonl`), mirrored in
 *    ../__tests__/fixtures.ts,
 *  - a larger synthetic campaign, because the fixture is one round of four
 *    candidates and the demo needs to show a tree that has actually branched.
 *
 * The synthetic numbers are in real physical units with realistic magnitudes
 * (eV, eV/atom) and the Pareto ranks are computed by the same non-dominated
 * sort the backend uses, so nothing here flatters the components.
 */

import type { TreeNodeInput } from "../treeLayout";
import type { ParetoPointInput } from "../ParetoSurface";
import type { Vec3 } from "../math";

/** Deterministic PRNG: a demo that looks different on every reload is a demo
 *  you cannot iterate on. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Hypothesis tree: 5 rounds, 4 branches, one branch refuted early.
// ---------------------------------------------------------------------------

export const SYNTHETIC_TREE: TreeNodeInput[] = [
  {
    id: "h1",
    parent_id: null,
    round: 1,
    branch: "main",
    statement:
      "Among near-hull lithium thiophosphates, a lower energy above hull predicts a lower Li migration barrier, because a well-ordered lattice gives cleaner migration channels.",
    verdict: "REFUTED",
  },
  {
    id: "h2",
    parent_id: "h1",
    round: 2,
    branch: "halide",
    statement:
      "Substituting 25% of the sulfur sublattice with chloride widens the bottleneck of the Li hop and lowers the barrier by more than 0.05 eV without moving off the hull.",
    verdict: "SUPPORTED",
  },
  {
    id: "h3",
    parent_id: "h1",
    round: 2,
    branch: "cation",
    statement:
      "Aliovalent cation doping on the P site creates Li vacancies and raises conductivity, at a stability cost small enough to stay within 0.05 eV/atom of the hull.",
    verdict: "REFUTED",
  },
  {
    id: "h4",
    parent_id: "h1",
    round: 2,
    branch: "framework",
    statement:
      "Argyrodite-framework conductors tolerate a wider electrochemical window than the thiophosphates at comparable barriers.",
    verdict: "INCONCLUSIVE",
  },
  {
    id: "h5",
    parent_id: "h2",
    round: 3,
    branch: "halide",
    statement:
      "Pushing halide substitution to 50% continues to lower the barrier monotonically rather than saturating.",
    verdict: "REFUTED",
  },
  {
    id: "h6",
    parent_id: "h2",
    round: 3,
    branch: "halide",
    statement:
      "Mixed Cl/Br occupancy at 25% total halide beats either halide alone, because the disordered anion sublattice flattens the migration energy landscape.",
    verdict: "SUPPORTED",
  },
  {
    id: "h7",
    parent_id: "h3",
    round: 3,
    branch: "cation",
    statement:
      "The stability penalty of Si-for-P doping is recovered by annealing into a lower-symmetry polymorph.",
    verdict: "INCONCLUSIVE",
  },
  {
    id: "h8",
    parent_id: "h3",
    round: 3,
    branch: "cation",
    statement:
      "Ge-for-P doping gives the same vacancy concentration at half the hull penalty of Si.",
    verdict: null,
  },
  {
    id: "h9",
    parent_id: "h4",
    round: 3,
    branch: "framework",
    statement:
      "The argyrodite band gap advantage survives once the anion site disorder measured in the seeds is included.",
    verdict: "SUPPORTED",
  },
  {
    id: "h10",
    parent_id: "h6",
    round: 4,
    branch: "halide",
    statement:
      "The mixed-halide optimum sits at a Cl:Br ratio near 2:1, where the computed barrier reaches a minimum of about 0.21 eV.",
    verdict: "SUPPORTED",
  },
  {
    id: "h11",
    parent_id: "h6",
    round: 4,
    branch: "halide-stability",
    statement:
      "The mixed-halide composition remains kinetically stable against lithium metal for the first ten cycles.",
    verdict: null,
  },
  {
    id: "h12",
    parent_id: "h9",
    round: 4,
    branch: "framework",
    statement:
      "Argyrodite candidates can be driven below 0.25 eV by the same halide trick, giving a second, independent route to the target.",
    verdict: null,
  },
  {
    id: "h13",
    parent_id: "h7",
    round: 4,
    branch: "cation",
    statement:
      "Annealed Si-doped candidates recover enough stability to re-enter the synthesizable window.",
    verdict: "REFUTED",
  },
  {
    id: "h14",
    parent_id: "h10",
    round: 5,
    branch: "halide",
    statement:
      "The 2:1 Cl:Br composition is the lead candidate: it is the only one that is simultaneously on the frontier, inside the stability constraint, and made of abundant elements.",
    verdict: null,
  },
];

/** The same campaign as it looked three events earlier — used to show that
 *  growth adds nodes without moving the ones already on screen. */
export const SYNTHETIC_TREE_EARLIER = SYNTHETIC_TREE.slice(0, 9);

export const TREE_SINGLE: TreeNodeInput[] = [SYNTHETIC_TREE[0]];

export const TREE_CHAIN: TreeNodeInput[] = Array.from({ length: 9 }, (_, i) => ({
  id: `c${i}`,
  parent_id: i === 0 ? null : `c${i - 1}`,
  round: i + 1,
  branch: "main",
  statement: `Round ${i + 1}: the chain continues, each hypothesis narrowing the previous one.`,
  verdict: i === 5 ? ("REFUTED" as const) : i % 2 === 0 ? ("SUPPORTED" as const) : null,
}));

/** Every malformed shape a live stream has produced. */
export const TREE_BROKEN: TreeNodeInput[] = [
  { id: "ok", parent_id: null, round: 1, branch: "main", statement: "A normal root.", verdict: null },
  {
    id: "orphan",
    parent_id: "never-arrived",
    round: 3,
    branch: "ghost",
    statement: "My parent_id points at a hypothesis that does not exist.",
    verdict: "SUPPORTED",
  },
  { id: "selfy", parent_id: "selfy", round: 2, branch: "main", statement: "I am my own parent.", verdict: null },
  { id: "cycA", parent_id: "cycB", round: 2, branch: "loop", statement: "Cycle A.", verdict: "REFUTED" },
  { id: "cycB", parent_id: "cycA", round: 2, branch: "loop", statement: "Cycle B.", verdict: null },
  {
    id: "nanround",
    parent_id: "ok",
    round: Number.NaN,
    branch: "main",
    statement: "My round is NaN.",
    verdict: "INCONCLUSIVE",
  },
  { id: "ok", parent_id: null, round: 1, branch: "main", statement: "Duplicate id.", verdict: null },
];

// ---------------------------------------------------------------------------
// Candidates: property space + Pareto shells
// ---------------------------------------------------------------------------

const PROPS = ["migration_barrier", "energy_above_hull", "band_gap"] as const;
const DIRECTIONS: ("min" | "max" | "target")[] = ["min", "min", "max"];

export const OBJECTIVE_LABELS: [string, string, string] = [
  "Li migration barrier (eV)",
  "Energy above hull (eV/atom)",
  "Band gap (eV)",
];

export interface SyntheticCandidate {
  id: string;
  name: string;
  values: Record<string, number>;
}

/** Candidates on a trade-off manifold, as a real screen produces: barrier and
 *  stability pull against each other, with scatter on top. */
export function syntheticCandidates(n = 220): SyntheticCandidate[] {
  const rand = rng(20261113);
  const out: SyntheticCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const t = rand();
    const u = rand();
    // `q` is overall quality: a poor candidate is worse on every axis at once,
    // which is what keeps the frontier a thin shell rather than half the cloud.
    const q = rand() ** 0.7;
    const barrier = 0.16 + 0.55 * t + 0.42 * q + 0.04 * (rand() - 0.5);
    const hull = 0.052 * (1 - t) ** 1.4 + 0.03 * q + 0.004 * (rand() - 0.5);
    const gap = 5.9 - 2.4 * (1 - u) - 0.5 * t - 2.1 * q + 0.25 * (rand() - 0.5);
    out.push({
      id: `c-${1000 + i}`,
      name: `Li${3 + (i % 5)}P${1 + (i % 3)}S${4 + (i % 4)}${i % 7 === 0 ? "Cl" : ""}`,
      values: {
        migration_barrier: Math.max(0.05, barrier),
        energy_above_hull: Math.max(0, hull),
        band_gap: Math.max(0.2, gap),
      },
    });
  }
  return out;
}

function signed(v: number, dir: "min" | "max" | "target") {
  return dir === "min" ? -v : v;
}

/** The backend's non-dominated sort, mirrored so the harness shows real shells
 *  rather than a rank number invented for the demo. */
export function paretoRank(candidates: SyntheticCandidate[]): ParetoPointInput[] {
  const remaining = new Map(candidates.map((c) => [c.id, c]));
  const out: ParetoPointInput[] = [];
  const spans = PROPS.map((p, a) => {
    const vals = candidates.map((c) => signed(c.values[p], DIRECTIONS[a]));
    return [Math.min(...vals), Math.max(...vals)] as const;
  });
  const weights = [2, 1, 1];
  const scalar = (c: SyntheticCandidate) => {
    let acc = 0;
    PROPS.forEach((p, a) => {
      const [lo, hi] = spans[a];
      const s = signed(c.values[p], DIRECTIONS[a]);
      acc += weights[a] * (hi - lo < 1e-12 ? 1 : (s - lo) / (hi - lo));
    });
    return acc / weights.reduce((x, y) => x + y, 0);
  };
  const dominates = (a: SyntheticCandidate, b: SyntheticCandidate) => {
    let better = false;
    for (let i = 0; i < PROPS.length; i++) {
      const av = signed(a.values[PROPS[i]], DIRECTIONS[i]);
      const bv = signed(b.values[PROPS[i]], DIRECTIONS[i]);
      if (av < bv) return false;
      if (av > bv) better = true;
    }
    return better;
  };
  let shell = 0;
  while (remaining.size) {
    const front = [...remaining.values()].filter(
      (c) => ![...remaining.values()].some((o) => o.id !== c.id && dominates(o, c)),
    );
    const batch = front.length ? front : [...remaining.values()];
    for (const c of batch) {
      out.push({
        candidate_id: c.id,
        rank: shell,
        values: { ...c.values },
        scalar_score: Number(scalar(c).toFixed(6)),
      });
      remaining.delete(c.id);
    }
    shell++;
  }
  return out;
}

export const SYNTHETIC_CANDIDATES = syntheticCandidates();
export const SYNTHETIC_PARETO = paretoRank(SYNTHETIC_CANDIDATES);

export const SYNTHETIC_AXES: [string, string, string] = [...PROPS] as [string, string, string];
export const SYNTHETIC_DIRECTIONS = DIRECTIONS;

/** Property-space points: the raw physical values, exactly as the embedding
 *  event carries them — three axes whose magnitudes differ by ~1000x. */
export const SYNTHETIC_POINTS: Record<string, Vec3> = Object.fromEntries(
  SYNTHETIC_CANDIDATES.map((c) => [
    c.id,
    [c.values.migration_barrier, c.values.energy_above_hull, c.values.band_gap] as Vec3,
  ]),
);

export const SYNTHETIC_LABELS: Record<string, string> = Object.fromEntries(
  SYNTHETIC_CANDIDATES.map((c) => [c.id, c.name]),
);

export const SYNTHETIC_RANKS: Record<string, number> = Object.fromEntries(
  SYNTHETIC_PARETO.map((p) => [p.candidate_id, p.rank]),
);

/** Degenerate Pareto inputs: one frontier point, collinear frontier,
 *  duplicates, and a NaN value. */
export const PARETO_DEGENERATE: ParetoPointInput[] = [
  { candidate_id: "only", rank: 0, values: { a: 0.3, b: 0.02, c: 4.1 }, scalar_score: 0.9 },
  { candidate_id: "dup1", rank: 1, values: { a: 0.5, b: 0.03, c: 3.2 }, scalar_score: 0.5 },
  { candidate_id: "dup2", rank: 1, values: { a: 0.5, b: 0.03, c: 3.2 }, scalar_score: 0.5 },
  { candidate_id: "nan", rank: 1, values: { a: Number.NaN, b: 0.03, c: 3.2 }, scalar_score: 0.1 },
  { candidate_id: "missing", rank: 2, values: { a: 0.7 }, scalar_score: 0.1 },
];

export const PARETO_COLLINEAR: ParetoPointInput[] = [0, 1, 2, 3].map((i) => ({
  candidate_id: `col${i}`,
  rank: 0,
  values: { a: 0.2 + 0.1 * i, b: 0.05 - 0.01 * i, c: 3 },
  scalar_score: 0.5,
}));
