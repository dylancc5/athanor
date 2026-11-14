/** Small, boring formatters. Scientific instruments do not round carelessly. */

export function fmtValue(value: number, unit?: string): string {
  const abs = Math.abs(value);
  let s: string;
  if (value === 0) s = "0";
  else if (abs >= 1000 || abs < 1e-3) s = value.toExponential(2);
  else if (abs >= 100) s = value.toFixed(1);
  else if (abs >= 1) s = value.toFixed(3);
  else s = value.toFixed(4);
  return unit ? `${s} ${unit}` : s;
}

export function fmtNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

export function fmtCpuHours(hours: number): string {
  if (hours >= 1000) return `${Math.round(hours / 100) / 10}k`;
  if (hours >= 10) return Math.round(hours).toLocaleString("en-US");
  return hours.toFixed(1);
}

export function fmtClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const OP_TEXT: Record<string, string> = {
  "<": "<",
  "<=": "≤",
  ">": ">",
  ">=": "≥",
  "==": "=",
  in: "in",
  not_in: "not in",
};

export function fmtConstraint(
  property: string,
  op: string,
  value: number | string | string[],
): string {
  const v = Array.isArray(value) ? value.join(", ") : String(value);
  return `${property} ${OP_TEXT[op] ?? op} ${v}`;
}

export function titleCase(key: string): string {
  return key
    .split(/[_\s]+/)
    .map((w) => (w.length > 3 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
