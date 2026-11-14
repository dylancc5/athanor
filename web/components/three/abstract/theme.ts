/**
 * Shared palette and geometric constants for the abstract (reasoning) views.
 *
 * Restrained, instrument-like: a cool neutral base, one warm accent for the
 * Pareto frontier, and the four verdict colors fixed by CONTRACT.md.
 */

export const VERDICT_COLORS = {
  OPEN: "#94a3b8",
  SUPPORTED: "#34d399",
  REFUTED: "#f87171",
  INCONCLUSIVE: "#fbbf24",
} as const;

export type VerdictKey = keyof typeof VERDICT_COLORS;

export function verdictColor(v: string | null | undefined): string {
  if (v === "SUPPORTED" || v === "REFUTED" || v === "INCONCLUSIVE") {
    return VERDICT_COLORS[v];
  }
  return VERDICT_COLORS.OPEN;
}

/** Instrument chrome: axes, grids, frames, labels. */
export const CHROME = {
  axis: "#475569",
  axisBright: "#94a3b8",
  grid: "#1e293b",
  gridMinor: "#172033",
  label: "#cbd5e1",
  labelDim: "#64748b",
  edge: "#64748b",
  selection: "#e2e8f0",
} as const;

/** Property-space cloud: neutral steel, with a warm frontier accent. */
export const CLOUD = {
  frontier: "#fbbf24",
  frontierGlow: "#fde68a",
  shell: "#60a5fa",
  deepShell: "#334155",
  unranked: "#52627a",
  surface: "#38bdf8",
} as const;

/** Opacity floor for a refuted hypothesis, per CONTRACT.md (~25%). */
export const REFUTED_OPACITY = 0.25;
/** A node below a refuted ancestor: dimmed, but still legible. */
export const SHADOWED_OPACITY = 0.42;

export const TREE = {
  /** Vertical distance between rounds (world units). */
  levelHeight: 1.7,
  /** Radial splay added per level of depth. */
  radialStep: 1.15,
  /** Lateral spacing between siblings sharing a (branch, round) slot. */
  siblingStep: 1.05,
  /** How far a child is pulled back toward its parent (0 = on top of it). */
  parentPull: 0.34,
  nodeRadius: 0.3,
} as const;

/** Golden angle: spreads branch directions without depending on branch count,
 *  so adding a branch never moves an existing one. */
export const GOLDEN_ANGLE = 2.399963229728653;

/** Shared easing/damping rate for all "glide to target" animations (1/s). */
export const DAMP_LAMBDA = 4.5;
