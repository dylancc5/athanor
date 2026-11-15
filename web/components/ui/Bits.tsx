"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { GLOSSARY } from "@/lib/glossary";

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
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-[0.1875rem] font-mono text-[0.6875rem] uppercase leading-none tracking-[0.08em] ${className}`}
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
  tick,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: string;
  accent?: boolean;
  /** flash once when the value changes — for counts, not for running clocks */
  tick?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-l border-rule pl-2.5" title={hint}>
      <span className="label truncate">{label}</span>
      <span
        // Re-keying on the value restarts the one-shot animation.
        key={tick ? String(value) : undefined}
        className={`num text-[1.125rem] leading-none ${accent ? "text-accent" : "text-ink"} ${
          tick ? "value-tick" : ""
        }`}
      >
        {value}
        {unit ? (
          <span className="ml-1 text-[0.75rem] text-ink-faint">{unit}</span>
        ) : null}
      </span>
    </div>
  );
}

type ButtonPassthrough = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "aria-selected" | "aria-controls" | "aria-keyshortcuts" | "role" | "id"
>;

export function Button({
  children,
  onClick,
  active,
  disabled,
  title,
  size = "md",
  tone = "default",
  className = "",
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  /** When defined, the button is a toggle and announces its state. */
  active?: boolean;
  disabled?: boolean;
  title?: string;
  size?: "sm" | "md";
  tone?: "default" | "accent";
  className?: string;
} & ButtonPassthrough) {
  const pad =
    size === "sm"
      ? "px-2 py-[0.3125rem] text-[0.6875rem]"
      : "px-2.5 py-1.5 text-[0.75rem]";
  const look = active
    ? "border-accent/60 bg-accent/15 text-accent"
    : tone === "accent"
      ? "border-accent/50 bg-accent/10 text-accent hover:bg-accent/20"
      : "border-rule bg-panel-2 text-ink-dim hover:border-rule-bright hover:text-ink";
  // A tab announces `aria-selected`; any other toggle announces `aria-pressed`.
  const pressed =
    active !== undefined && rest.role !== "tab" ? { "aria-pressed": active } : {};
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      {...pressed}
      {...rest}
      className={`pressable shrink-0 whitespace-nowrap rounded border font-mono uppercase leading-none tracking-[0.08em] disabled:cursor-not-allowed disabled:border-dashed disabled:opacity-45 ${pad} ${look} ${className}`}
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
      className="inline-flex cursor-help items-center rounded border px-1 font-mono text-[0.6875rem] leading-[1.35] tracking-[0.06em]"
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
          className="bar-fill absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct * 100}%`, background: color }}
        />
      </span>
      <span className="num text-[0.6875rem] text-ink-faint">{pct.toFixed(2)}</span>
    </span>
  );
}

/**
 * A number that counts up to its value when it first appears or changes.
 * Skips the animation under prefers-reduced-motion.
 */
export function CountUp({
  value,
  format = (v) => String(Math.round(v)),
  durationMs = 900,
}: {
  value: number;
  format?: (v: number) => string;
  durationMs?: number;
}) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = from.current;
    from.current = value;
    if (reduce || start === value) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(start + (value - start) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  return <>{format(shown)}</>;
}

/** A property name with its plain-English meaning on hover. */
export function Term({ property, children }: { property: string; children: ReactNode }) {
  const meaning = GLOSSARY[property];
  if (!meaning) return <>{children}</>;
  return (
    <span
      title={meaning}
      className="cursor-help underline decoration-ink-faint/60 decoration-dotted underline-offset-4"
    >
      {children}
    </span>
  );
}
