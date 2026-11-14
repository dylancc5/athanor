/**
 * Pure numeric helpers shared by the abstract views.
 *
 * Everything here is defensive: a live campaign hands us partial rows, NaNs
 * from a failed scorer, and axes whose physical magnitudes differ by orders of
 * magnitude. No function in this file ever throws.
 */

export type Vec3 = [number, number, number];

export interface Range {
  min: number;
  max: number;
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    isFiniteNumber(v[0]) &&
    isFiniteNumber(v[1]) &&
    isFiniteNumber(v[2])
  );
}

/** Per-axis min/max over rows, ignoring non-finite entries. */
export function axisRanges(rows: Vec3[]): [Range, Range, Range] {
  const out: [Range, Range, Range] = [
    { min: Infinity, max: -Infinity },
    { min: Infinity, max: -Infinity },
    { min: Infinity, max: -Infinity },
  ];
  for (const row of rows) {
    for (let a = 0; a < 3; a++) {
      const v = row[a];
      if (!isFiniteNumber(v)) continue;
      if (v < out[a].min) out[a].min = v;
      if (v > out[a].max) out[a].max = v;
    }
  }
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(out[a].min) || !Number.isFinite(out[a].max)) {
      out[a] = { min: 0, max: 0 };
    }
  }
  return out;
}

const DEGENERATE = 1e-12;

/**
 * Map one raw value onto [-half, half] for its axis.
 *
 * A degenerate axis (every candidate identical, or a single point) collapses to
 * the centre rather than dividing by zero — the cloud then reads as a plane or
 * a dot, which is the truth about the data.
 */
export function normalizeAxis(value: number, range: Range, half = 1): number {
  if (!isFiniteNumber(value)) return 0;
  const span = range.max - range.min;
  if (!Number.isFinite(span) || Math.abs(span) < DEGENERATE) return 0;
  const t = (value - range.min) / span; // 0..1
  return (t * 2 - 1) * half;
}

export function normalizeVec3(v: Vec3, ranges: [Range, Range, Range], half = 1): Vec3 {
  return [
    normalizeAxis(v[0], ranges[0], half),
    normalizeAxis(v[1], ranges[1], half),
    normalizeAxis(v[2], ranges[2], half),
  ];
}

/** Frame-rate independent exponential approach, as in three's MathUtils.damp. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  if (!isFiniteNumber(current)) return target;
  if (!isFiniteNumber(target)) return current;
  const d = Math.min(Math.max(dt, 0), 0.1); // clamp: a stalled tab must not jump
  return target + (current - target) * Math.exp(-lambda * d);
}

/** Format a physical value compactly enough for a 3D label. */
export function formatValue(v: number): string {
  if (!isFiniteNumber(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a < 1e-3 || a >= 1e5) return v.toExponential(2);
  if (a < 1) return v.toFixed(3);
  if (a < 100) return v.toFixed(2);
  return v.toFixed(1);
}

/** Truncate on a word boundary where possible; never mid-escape. */
export function truncate(text: string, max = 150): string {
  if (typeof text !== "string") return "";
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, "") + "…";
}
