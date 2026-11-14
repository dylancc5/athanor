"use client";

import { useMemo } from "react";
import { Panel, EmptyNote } from "@/components/ui/Panel";
import { Chip, ConfidenceBar, FlagDot } from "@/components/ui/Bits";
import { fmtValue, titleCase } from "@/lib/format";
import { measuredProperties, paretoRankMap } from "@/lib/campaign-state";
import { useCampaign } from "@/lib/store";

export function MeasurementsTable() {
  const state = useCampaign((s) => s.state);
  const selected = useCampaign((s) => s.selectedCandidateId);
  const selectCandidate = useCampaign((s) => s.selectCandidate);

  const properties = useMemo(() => measuredProperties(state), [state]);
  const ranks = useMemo(() => paretoRankMap(state), [state]);
  const labels = useMemo(() => {
    const out: Record<string, { label: string; unit: string }> = {};
    for (const o of state.spec?.objectives ?? []) {
      out[o.property] = { label: o.label, unit: o.unit };
    }
    return out;
  }, [state.spec]);

  const rows = state.candidateIds.filter((id) => state.measurements[id]);
  // A property that is not a spec objective (energy per atom) has no label
  // entry, so its unit comes from the first measurement that carries one.
  const unitOf = (p: string) =>
    labels[p]?.unit ??
    rows.map((id) => state.measurements[id]?.[p]?.unit).find((u) => Boolean(u)) ??
    "";
  const scoring = state.scoring.filter((s) => !s.done);
  const vetoed = new Set(state.vetoedIds);

  const flagCounts = useMemo(() => {
    let ood = 0;
    let proxy = 0;
    for (const m of state.measurementLog) {
      if (m.ood_flag) ood++;
      if (m.is_proxy) proxy++;
    }
    return { ood, proxy };
  }, [state.measurementLog]);

  return (
    <Panel
      id="panel-measurements"
      title="Measurements"
      eyebrow={
        state.measurementLog.length > 0
          ? `${state.measurementLog.length} recorded`
          : undefined
      }
      right={
        <div className="flex items-center gap-1.5">
          {flagCounts.ood > 0 ? (
            <Chip color="#fbbf24" title="measurements the scorer flagged as out of its training distribution">
              {flagCounts.ood} ood
            </Chip>
          ) : null}
          {flagCounts.proxy > 0 ? (
            <Chip color="#a78bfa" title="values standing in for a property the model cannot compute directly">
              {flagCounts.proxy} proxy
            </Chip>
          ) : null}
        </div>
      }
      bodyClassName=""
    >
      {rows.length === 0 ? (
        <EmptyNote>
          No measurements yet. Each one records its source, its method, and whether
          it is a proxy or an extrapolation.
        </EmptyNote>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left">
          <caption className="sr-only">
            Measured properties per candidate, with confidence and honesty flags
          </caption>
          <thead className="sticky top-0 z-10 bg-panel shadow-[0_1px_0_var(--color-rule)]">
            <tr>
              <th scope="col" className="label px-3 py-2.5 align-bottom font-normal">
                Candidate
              </th>
              {properties.map((p) => {
                const full = labels[p]?.label ?? titleCase(p);
                // "Band gap (electrochemical window proxy)" wrapped to three
                // lines in a column header. The qualifier moves to the tooltip
                // and the unit takes its place, which is what a reader scans for.
                const short = full.replace(/\s*\([^)]*\)\s*$/, "");
                return (
                  <th
                    key={p}
                    scope="col"
                    className="px-3 py-2.5 text-right align-bottom font-normal"
                    title={unitOf(p) ? `${full} (${unitOf(p)})` : full}
                  >
                    <span className="label block leading-tight">{short}</span>
                    {unitOf(p) ? (
                      <span className="num mt-1 block text-[0.6875rem] text-ink-faint">
                        {unitOf(p)}
                      </span>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((id) => {
              const c = state.candidates[id];
              const isSel = selected === id;
              const rank = ranks[id];
              return (
                <tr
                  key={id}
                  onClick={() => selectCandidate(isSel ? null : id)}
                  data-selected={isSel || undefined}
                  className={`rise-in cursor-pointer border-b border-rule/60 transition-colors duration-150 ${
                    isSel ? "bg-accent/10" : "hover:bg-panel-2"
                  }`}
                >
                  <th scope="row" className="px-3 py-2.5 text-left align-top font-normal">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        aria-pressed={isSel}
                        title="Show this candidate in the viewer"
                        onClick={(e) => {
                          e.stopPropagation();
                          selectCandidate(isSel ? null : id);
                        }}
                        className="num rounded-sm text-[0.875rem] text-ink underline-offset-4 hover:underline"
                      >
                        {c?.name ?? id}
                      </button>
                      {rank === 0 ? <Chip color="#38bdf8">frontier</Chip> : null}
                      {vetoed.has(id) ? <Chip color="#fbbf24">vetoed</Chip> : null}
                    </div>
                    <div className="num mt-1 text-[0.6875rem] text-ink-faint">
                      {c?.provenance.external_id ?? id}
                      {c?.provenance.operation ? ` · ${c.provenance.operation}` : ""}
                    </div>
                  </th>
                  {properties.map((p) => {
                    const m = state.measurements[id]?.[p];
                    if (!m) {
                      return (
                        <td
                          key={p}
                          className="num px-3 py-2.5 text-right align-top text-[0.8125rem] text-ink-faint"
                          title="not measured for this candidate"
                        >
                          —
                        </td>
                      );
                    }
                    const hover = [
                      `${m.property} = ${fmtValue(m.value, m.unit)}`,
                      `source: ${m.source}`,
                      m.method ? `method: ${m.method}` : null,
                      `confidence: ${m.confidence.toFixed(2)}`,
                      m.ood_flag ? "OUT OF DISTRIBUTION — the scorer is extrapolating" : null,
                      m.is_proxy ? "PROXY — stands in for the real property" : null,
                      m.note ? `note: ${m.note}` : null,
                    ]
                      .filter(Boolean)
                      .join("\n");
                    return (
                      <td key={p} className="px-3 py-2.5 text-right align-top" title={hover}>
                        <div className="num text-[0.875rem] text-ink">{fmtValue(m.value)}</div>
                        <div className="mt-1.5 flex items-center justify-end gap-1.5">
                          {m.ood_flag ? (
                            <FlagDot
                              kind="ood"
                              title={`Out of distribution — ${m.source} is extrapolating beyond what it was trained on.${m.note ? `\n${m.note}` : ""}`}
                            />
                          ) : null}
                          {m.is_proxy ? (
                            <FlagDot
                              kind="proxy"
                              title={`Proxy value${m.method ? ` — ${m.method}` : ""}. It stands in for the property rather than measuring it.`}
                            />
                          ) : null}
                          <ConfidenceBar value={m.confidence} />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {scoring.map((s) => (
              <tr key={`scoring-${s.candidateId}`} className="border-b border-rule/60">
                <td className="px-3 py-2.5">
                  <span className="num text-[0.875rem] text-ink-dim">
                    {state.candidates[s.candidateId]?.name ?? s.candidateId}
                  </span>
                  <div className="label mt-1 text-accent">scoring · {s.scorer}…</div>
                </td>
                <td colSpan={properties.length} className="px-3 py-2.5">
                  <div className="h-0.5 w-full overflow-hidden rounded bg-rule">
                    <div className="slug h-full w-1/4 rounded bg-accent" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </Panel>
  );
}
