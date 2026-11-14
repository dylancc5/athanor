"use client";

import type { ReactNode } from "react";

export function Chip({
  children,
  color,
  tone = "outline",
  title,
  className = "",
}: {
  children: ReactNode;
  color?: string;
  tone?: "outline" | "solid" | "ghost";
  title?: string;
  className?: string;
}) {
  const c = color ?? "#94a3b8";
  const style =
    tone === "solid"
      ? { background: c, color: "#06080c", borderColor: c }
      : tone === "ghost"
        ? { color: c, borderColor: "transparent", background: `${c}14` }
        : { color: c, borderColor: `${c}59`, background: `${c}10` };
  return (
    <span
      title={title}
      style={style}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase leading-none tracking-[0.1em] ${className}`}
    >
      {children}
    </span>
  );
}

export function Metric({
  label,
  value,
  unit,
  hint,
  accent,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-l border-rule pl-2.5" title={hint}>
      <span className="label">{label}</span>
      <span
        className={`num text-[1.0625rem] leading-none ${accent ? "text-accent" : "text-ink"}`}
      >
        {value}
        {unit ? (
          <span className="ml-1 text-[0.6875rem] text-ink-faint">{unit}</span>
        ) : null}
      </span>
    </div>
  );
}

export function Button({
  children,
  onClick,
  active,
  disabled,
  title,
  size = "md",
  tone = "default",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  size?: "sm" | "md";
  tone?: "default" | "accent";
  className?: string;
}) {
  const pad = size === "sm" ? "px-1.5 py-1 text-[0.625rem]" : "px-2.5 py-1.5 text-[0.6875rem]";
  const look = active
    ? "border-accent/60 bg-accent/15 text-accent"
    : tone === "accent"
      ? "border-accent/50 bg-accent/10 text-accent hover:bg-accent/20"
      : "border-rule bg-panel-2 text-ink-dim hover:border-rule-bright hover:text-ink";
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded border font-mono uppercase tracking-[0.1em] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${pad} ${look} ${className}`}
    >
      {children}
    </button>
  );
}

/** Honest flags: OOD / proxy / low confidence. Never hidden. */
export function FlagDot({
  kind,
  title,
}: {
  kind: "ood" | "proxy" | "low";
  title: string;
}) {
  const map = {
    ood: { c: "#fbbf24", t: "OOD" },
    proxy: { c: "#a78bfa", t: "PROXY" },
    low: { c: "#f87171", t: "LOW" },
  } as const;
  const { c, t } = map[kind];
  return (
    <span
      title={title}
      style={{ color: c, borderColor: `${c}66`, background: `${c}14` }}
      className="inline-flex cursor-help items-center rounded border px-1 font-mono text-[0.5625rem] leading-[1.35] tracking-[0.08em]"
    >
      {t}
    </span>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  const color = pct >= 0.75 ? "#34d399" : pct >= 0.5 ? "#fbbf24" : "#f87171";
  return (
    <span className="inline-flex items-center gap-1.5" title={`confidence ${pct.toFixed(2)}`}>
      <span className="relative block h-1 w-10 overflow-hidden rounded-full bg-rule">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct * 100}%`, background: color }}
        />
      </span>
      <span className="num text-[0.625rem] text-ink-faint">{pct.toFixed(2)}</span>
    </span>
  );
}
