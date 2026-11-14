"use client";

import { useMemo, useState } from "react";
import { scaleLinear } from "d3-scale";
import { Panel, EmptyNote } from "@/components/ui/Panel";
import { Chip } from "@/components/ui/Bits";
import { fmtValue } from "@/lib/format";
import { useCampaign } from "@/lib/store";
import type { Objective } from "@/lib/contracts";

const W = 520;
const H = 300;
const M = { top: 14, right: 16, bottom: 44, left: 62 };

/**
 * 2D Pareto frontier. Axes are scaled to whatever the data actually is —
 * no hardcoded ranges anywhere, because the scorers' value ranges change
 * when the models behind them are regenerated.
 */
export function ParetoPanel() {
  const state = useCampaign((s) => s.state);
  const selected = useCampaign((s) => s.selectedCandidateId);
  const selectCandidate = useCampaign((s) => s.selectCandidate);
  const spec = state.spec;

  const [xKey, setXKey] = useState<string | null>(null);
  const [yKey, setYKey] = useState<string | null>(null);

  const axes = useMemo(() => {
    const objectives = spec?.objectives ?? [];
    const available = objectives.filter((o) =>
      state.pareto.some((p) => typeof p.values[o.property] === "number"),
    );
    const x =
      available.find((o) => o.property === xKey) ?? available[0] ?? null;
    const y =
      available.find((o) => o.property === yKey) ??
      available.find((o) => o.property !== x?.property) ??
      null;
    return { x, y, available };
  }, [spec, state.pareto, xKey, yKey]);

  const plot = useMemo(() => {
    const { x, y } = axes;
    if (!x || !y) return null;
    const rows = state.pareto
      .map((p) => ({
        id: p.candidate_id,
        rank: p.rank,
        score: p.scalar_score,
        x: p.values[x.property],
        y: p.values[y.property],
      }))
      .filter((r) => typeof r.x === "number" && typeof r.y === "number");
    if (rows.length === 0) return null;

    // Domains from the data, padded by 8% so points never sit on an axis.
    const pad = (lo: number, hi: number): [number, number] => {
      if (lo === hi) {
        const d = Math.abs(lo) > 0 ? Math.abs(lo) * 0.15 : 1;
        return [lo - d, hi + d];
      }
      const d = (hi - lo) * 0.08;
      return [lo - d, hi + d];
    };
    const xs = rows.map((r) => r.x);
    const ys = rows.map((r) => r.y);
    const sx = scaleLinear()
      .domain(pad(Math.min(...xs), Math.max(...xs)))
      .range([M.left, W - M.right])
      .nice();
    const sy = scaleLinear()
      .domain(pad(Math.min(...ys), Math.max(...ys)))
      .range([H - M.bottom, M.top])
      .nice();

    // The backend's rank 0 is non-dominated across ALL objectives, which is
    // not the same as non-dominated in the two being displayed — drawing that
    // staircase would run the line through points the viewer can see are
    // beaten on both axes. So recompute the frontier for these two axes.
    const better = (a: number, b: number, dir: Objective["direction"]) =>
      dir === "max" ? a > b : a < b;
    const atLeast = (a: number, b: number, dir: Objective["direction"]) =>
      dir === "max" ? a >= b : a <= b;
    const dominated = (r: (typeof rows)[number]) =>
      rows.some(
        (o) =>
          o !== r &&
          atLeast(o.x, r.x, x.direction) &&
          atLeast(o.y, r.y, y.direction) &&
          (better(o.x, r.x, x.direction) || better(o.y, r.y, y.direction)),
      );
    const frontier = rows
      .filter((r) => !dominated(r))
      .sort((a, b) => (x.direction === "min" ? a.x - b.x : b.x - a.x));
    const frontierIds = new Set(frontier.map((r) => r.id));

    return { rows, sx, sy, frontier, frontierIds, x, y };
  }, [axes, state.pareto]);

  // candidates that were measured but never made it into a pareto update
  const unranked = useMemo(() => {
    const ranked = new Set(state.pareto.map((p) => p.candidate_id));
    return state.candidateIds.filter(
      (id) => !ranked.has(id) && state.measurements[id],
    );
  }, [state.pareto, state.candidateIds, state.measurements]);

  const axisPicker = (
    which: "x" | "y",
    current: Objective | null,
    set: (p: string) => void,
  ) =>
    axes.available.length > 2 ? (
      <select
        value={current?.property ?? ""}
        onChange={(e) => set(e.target.value)}
        aria-label={`${which} axis`}
        className="rounded border border-rule bg-panel-2 px-1 py-0.5 font-mono text-[0.625rem] text-ink-dim"
      >
        {axes.available.map((o) => (
          <option key={o.property} value={o.property}>
            {o.label}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <Panel
      id="panel-pareto"
      title="Pareto frontier"
      eyebrow={
        state.pareto.length > 0
          ? `${state.pareto.filter((p) => p.rank === 0).length} on frontier`
          : undefined
      }
      bodyClassName="p-2"
    >
      {!plot ? (
        <EmptyNote>
          Candidates appear here once they have been scored on two objectives.
          Nothing is ranked until the measurements exist.
        </EmptyNote>
      ) : (
        <div className="flex h-full flex-col gap-2">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            style={{ maxHeight: 320 }}
            role="img"
            aria-label="Pareto frontier scatter plot"
          >
            {/* gridlines + ticks, from the scales, not from constants */}
            {plot.sy.ticks(5).map((t) => (
              <g key={`y${t}`}>
                <line
                  x1={M.left}
                  x2={W - M.right}
                  y1={plot.sy(t)}
                  y2={plot.sy(t)}
                  stroke="#1b2330"
                />
                <text
                  x={M.left - 8}
                  y={plot.sy(t)}
                  dy="0.32em"
                  textAnchor="end"
                  className="num"
                  fontSize="9"
                  fill="#64748b"
                >
                  {t}
                </text>
              </g>
            ))}
            {plot.sx.ticks(6).map((t) => (
              <g key={`x${t}`}>
                <line
                  y1={M.top}
                  y2={H - M.bottom}
                  x1={plot.sx(t)}
                  x2={plot.sx(t)}
                  stroke="#1b2330"
                />
                <text
                  x={plot.sx(t)}
                  y={H - M.bottom + 14}
                  textAnchor="middle"
                  className="num"
                  fontSize="9"
                  fill="#64748b"
                >
                  {t}
                </text>
              </g>
            ))}

            {/* frontier staircase */}
            {plot.frontier.length > 1 ? (
              <polyline
                points={plot.frontier
                  .map((r) => `${plot.sx(r.x)},${plot.sy(r.y)}`)
                  .join(" ")}
                fill="none"
                stroke="#38bdf8"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                opacity="0.75"
              />
            ) : null}

            {plot.rows.map((r) => {
              const on = plot.frontierIds.has(r.id);
              const isSel = r.id === selected;
              return (
                <g
                  key={r.id}
                  transform={`translate(${plot.sx(r.x)},${plot.sy(r.y)})`}
                  onClick={() => selectCandidate(isSel ? null : r.id)}
                  style={{ cursor: "pointer" }}
                >
                  <title>
                    {`${state.candidates[r.id]?.name ?? r.id}\n${plot.x.label}: ${fmtValue(r.x, plot.x.unit)}\n${plot.y.label}: ${fmtValue(r.y, plot.y.unit)}\n${on ? "on this 2D frontier" : "dominated on these two axes"}\noverall rank ${r.rank} (all objectives) · score ${r.score.toFixed(3)}`}
                  </title>
                  {isSel ? (
                    <circle r="9" fill="none" stroke="#38bdf8" strokeWidth="1" />
                  ) : null}
                  <circle
                    r={on ? 4.5 : 3.5}
                    fill={on ? "#38bdf8" : "#334155"}
                    stroke={on ? "#7dd3fc" : "#475569"}
                    strokeWidth="1"
                  />
                  <text
                    x="8"
                    y="0"
                    dy="0.32em"
                    fontSize="9"
                    fill={isSel ? "#e6ecf3" : "#94a3b8"}
                  >
                    {state.candidates[r.id]?.name ?? r.id}
                  </text>
                </g>
              );
            })}

            {/* axis labels carry the real objective label, unit and direction */}
            <text
              x={(W - M.right + M.left) / 2}
              y={H - 6}
              textAnchor="middle"
              fontSize="10"
              fill="#9aa8b8"
            >
              {`${plot.x.label} (${plot.x.unit}) · ${plot.x.direction === "min" ? "lower is better" : plot.x.direction === "max" ? "higher is better" : "target"}`}
            </text>
            <text
              transform={`translate(13,${(H - M.bottom + M.top) / 2}) rotate(-90)`}
              textAnchor="middle"
              fontSize="10"
              fill="#9aa8b8"
            >
              {`${plot.y.label} (${plot.y.unit}) · ${plot.y.direction === "min" ? "lower is better" : plot.y.direction === "max" ? "higher is better" : "target"}`}
            </text>
          </svg>

          <div className="flex flex-wrap items-center gap-2 border-t border-rule px-1 pt-2">
            <Chip color="#38bdf8" title="non-dominated on the two axes shown">
              frontier · these 2 axes
            </Chip>
            <Chip color="#475569">dominated</Chip>
            {state.pareto.filter((p) => p.rank === 0).length !==
            plot.frontier.length ? (
              <span
                className="label"
                title="The backend ranks across every objective at once; a point can be on that frontier yet be beaten on the two shown here."
              >
                {state.pareto.filter((p) => p.rank === 0).length} on the full
                {" "}
                {(state.spec?.objectives ?? []).length}-objective frontier
              </span>
            ) : null}
            {unranked.length > 0 ? (
              <span
                className="label"
                title={unranked
                  .map((id) => state.candidates[id]?.name ?? id)
                  .join(", ")}
              >
                {unranked.length} not ranked — missing an objective
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-1.5">
              {axisPicker("x", plot.x, setXKey)}
              {axisPicker("y", plot.y, setYKey)}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
