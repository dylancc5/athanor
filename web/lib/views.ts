/**
 * The 3D view registry. One place that knows which views exist, what each
 * needs from the campaign state, and how to pull it out of an artifact
 * payload. Panels and the tour both read from here.
 */

import type { Artifact } from "@/lib/contracts";
import type { CampaignState } from "@/lib/campaign-state";
import { latestArtifactOfKind, measuredProperties } from "@/lib/campaign-state";

export type ViewName =
  | "structure"
  | "trajectory"
  | "void"
  | "space"
  | "pareto"
  | "tree";

export interface ViewDef {
  name: ViewName;
  label: string;
  /** one line, shown under the selector */
  blurb: string;
}

export const VIEWS: ViewDef[] = [
  { name: "structure", label: "Structure", blurb: "Relaxed unit cell, ball-and-stick" },
  { name: "trajectory", label: "Migration path", blurb: "NEB hop or relaxation playback" },
  { name: "void", label: "Void surface", blurb: "Accessible pore volume isosurface" },
  { name: "space", label: "Chemical space", blurb: "Every candidate as a point" },
  { name: "pareto", label: "Pareto surface", blurb: "The frontier as a surface" },
  { name: "tree", label: "Hypothesis tree", blurb: "Branches darken when refuted" },
];

// --------------------------------------------------------------------------
// Artifact payload shapes (documented on the Artifact docstring in
// backend/athanor/contracts.py). Parsed payloads arrive as `unknown`.
// --------------------------------------------------------------------------

export interface FramesPayload {
  symbols: string[];
  cell: number[][] | null;
  pbc: boolean;
  frames: number[][][];
  energies?: number[];
  mobile_index?: number;
  barrier_ev?: number;
}

export interface VoidPayload {
  cell: number[][];
  shape: [number, number, number];
  values: number[];
  void_fraction?: number;
  pore_diameter_A?: number;
}

function isNumberMatrix(v: unknown): v is number[][] {
  return (
    Array.isArray(v) &&
    v.every((row) => Array.isArray(row) && row.every((n) => typeof n === "number"))
  );
}

export function asFramesPayload(payload: unknown): FramesPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.symbols) || !p.symbols.every((s) => typeof s === "string")) {
    return null;
  }
  if (!Array.isArray(p.frames) || p.frames.length === 0) return null;
  const frames = p.frames.filter(isNumberMatrix);
  if (frames.length === 0) return null;
  return {
    symbols: p.symbols as string[],
    cell: isNumberMatrix(p.cell) ? p.cell : null,
    pbc: p.pbc === true,
    frames,
    energies: Array.isArray(p.energies)
      ? (p.energies.filter((n) => typeof n === "number") as number[])
      : undefined,
    mobile_index: typeof p.mobile_index === "number" ? p.mobile_index : undefined,
    barrier_ev: typeof p.barrier_ev === "number" ? p.barrier_ev : undefined,
  };
}

export function asVoidPayload(payload: unknown): VoidPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (!isNumberMatrix(p.cell)) return null;
  if (!Array.isArray(p.shape) || p.shape.length !== 3) return null;
  if (!Array.isArray(p.values)) return null;
  return {
    cell: p.cell,
    shape: p.shape as [number, number, number],
    values: p.values as number[],
    void_fraction: typeof p.void_fraction === "number" ? p.void_fraction : undefined,
    pore_diameter_A:
      typeof p.pore_diameter_A === "number" ? p.pore_diameter_A : undefined,
  };
}

/** Last frame of a relaxation is the relaxed structure. No CIF parsing needed. */
export function relaxedStructure(payload: unknown) {
  const p = asFramesPayload(payload);
  if (!p) return null;
  return {
    symbols: p.symbols,
    cell: p.cell,
    pbc: p.pbc,
    positions: p.frames[p.frames.length - 1],
  };
}

// --------------------------------------------------------------------------
// Which artifact feeds which view, for the current selection
// --------------------------------------------------------------------------

export function artifactForView(
  state: CampaignState,
  view: ViewName,
  selectedCandidateId: string | null,
): Artifact | null {
  const kinds: Partial<Record<ViewName, Artifact["kind"][]>> = {
    structure: ["relaxation_trajectory", "crystal_packing"],
    trajectory: ["neb_path", "relaxation_trajectory"],
    void: ["void_grid"],
  };
  const wanted = kinds[view];
  if (!wanted) return null;
  for (const kind of wanted) {
    const hit =
      latestArtifactOfKind(state, kind, selectedCandidateId) ??
      latestArtifactOfKind(state, kind);
    if (hit) return hit;
  }
  return null;
}

export function viewAvailable(
  state: CampaignState,
  view: ViewName,
  selectedCandidateId: string | null,
): boolean {
  switch (view) {
    case "structure":
    case "trajectory":
    case "void":
      return artifactForView(state, view, selectedCandidateId) !== null;
    case "space":
      return Object.keys(state.embedding).length > 0;
    case "pareto":
      return state.pareto.length > 0;
    case "tree":
      return state.hypothesisIds.length > 0;
  }
}

export function isViewName(v: string | null | undefined): v is ViewName {
  return VIEWS.some((def) => def.name === v);
}

/** Camera framing comes from agent E's parser module — not reimplemented here. */
export { boundingSphere, trajectoryBoundingSphere } from "@/lib/structure-parse";

// --------------------------------------------------------------------------
// Chemical-space axis labels
// --------------------------------------------------------------------------

/**
 * `embedding.updated` carries bare xyz coordinates — the contract never says
 * which property each dimension is, and in the recorded campaigns the order is
 * NOT `spec.objectives` order (it is barrier, band gap, then hull scaled up for
 * visual spread). Labelling the axes by assuming an order therefore puts the
 * wrong name on real numbers, which is exactly the sort of quiet lie this
 * product is supposed to avoid.
 *
 * So the mapping is recovered from the data: a dimension is labelled with a
 * property only when its values across candidates are an affine function of
 * that property's values (|Pearson r| ~ 1), which survives the arbitrary
 * rescaling. Anything unmatched stays an honest "Dimension N".
 */
export function embeddingAxisLabels(
  state: CampaignState,
): [string, string, string] {
  const ids = Object.keys(state.embedding);
  const objectives = state.spec?.objectives ?? [];
  const properties = measuredProperties(state);

  /**
   * The unit is only printed when the dimension carries the property's actual
   * values (slope 1, intercept 0). Some dimensions are rescaled for visual
   * spread — the hull axis is multiplied by ten in the recorded campaigns —
   * and printing "eV/atom" beside a tenfold number would contradict the
   * measurements table. Those are marked "relative" instead.
   */
  const labelFor = (property: string, exact: boolean) => {
    const o = objectives.find((x) => x.property === property);
    const name = o ? o.label : property.replace(/_/g, " ");
    if (!o) return exact ? name : `${name} (relative)`;
    return exact ? `${name} (${o.unit})` : `${name} (relative)`;
  };

  const out: [string, string, string] = ["Dimension 1", "Dimension 2", "Dimension 3"];

  for (let dim = 0; dim < 3; dim++) {
    let best: { property: string; r: number; exact: boolean } | null = null;

    for (const property of properties) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const id of ids) {
        const point = state.embedding[id];
        const m = state.measurements[id]?.[property];
        if (!point || !m || typeof point[dim] !== "number") continue;
        xs.push(point[dim]);
        ys.push(m.value);
      }
      if (xs.length < 3) continue;

      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      const mx = mean(xs);
      const my = mean(ys);
      let num = 0;
      let dx = 0;
      let dy = 0;
      for (let i = 0; i < xs.length; i++) {
        const a = xs[i] - mx;
        const b = ys[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
      }
      if (dx <= 1e-12 || dy <= 1e-12) continue;
      const r = Math.abs(num / Math.sqrt(dx * dy));
      if (r <= 0.999) continue;
      const slope = num / dx; // property per embedding unit
      const intercept = my - slope * mx;
      const scale = Math.max(1, Math.abs(my));
      const exact =
        Math.abs(slope - 1) < 1e-6 && Math.abs(intercept) < 1e-9 * scale;
      if (!best || r > best.r) best = { property, r, exact };
    }

    if (best) out[dim] = labelFor(best.property, best.exact);
  }
  return out;
}
