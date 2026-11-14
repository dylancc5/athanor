/**
 * The 3D view registry. One place that knows which views exist, what each
 * needs from the campaign state, and how to pull it out of an artifact
 * payload. Panels and the tour both read from here.
 */

import type { Artifact } from "@/lib/contracts";
import type { CampaignState } from "@/lib/campaign-state";
import { latestArtifactOfKind } from "@/lib/campaign-state";

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

/** Bounding sphere radius of a point cloud, for camera placement. */
export function boundingSphere(points: number[][]): { center: [number, number, number]; radius: number } {
  if (points.length === 0) return { center: [0, 0, 0], radius: 10 };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      const v = p[i] ?? 0;
      if (v < min[i]) min[i] = v;
      if (v > max[i]) max[i] = v;
    }
  }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  let radius = 0;
  for (const p of points) {
    const dx = (p[0] ?? 0) - center[0];
    const dy = (p[1] ?? 0) - center[1];
    const dz = (p[2] ?? 0) - center[2];
    radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return { center, radius: Math.max(radius, 2) };
}
