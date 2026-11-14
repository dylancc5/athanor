"use client";

import { Panel, EmptyNote } from "@/components/ui/Panel";
import { Metric } from "@/components/ui/Bits";
import { fmtCpuHours, fmtDuration, fmtNumber } from "@/lib/format";
import { useCampaign } from "@/lib/store";

export function LedgerPanel() {
  const state = useCampaign((s) => s.state);
  const ledger = state.ledger;

  // Before the backend emits a ledger, count what the log already proves.
  const fallback = {
    candidates_generated: state.candidateIds.length,
    candidates_vetoed: state.vetoedIds.length,
    candidates_scored: Object.keys(state.measurements).length,
    measurements: state.measurementLog.length,
    llm_calls: 0,
    wall_seconds: state.lastT,
    est_dft_cpu_hours: 0,
  };
  const l = ledger ?? fallback;
  const dft = l.est_dft_cpu_hours ?? 0;
  const wall = l.wall_seconds ?? state.lastT;

  return (
    <Panel
      id="panel-ledger"
      title="Compute ledger"
      eyebrow={ledger ? undefined : "provisional"}
      bodyClassName="p-3"
    >
      {state.candidateIds.length === 0 ? (
        <EmptyNote>Nothing has been spent yet.</EmptyNote>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-x-3 gap-y-3.5">
            <Metric
              label="Screened"
              tick
              value={fmtNumber(l.candidates_generated ?? 0)}
              hint="candidates generated across every round"
            />
            <Metric
              label="Vetoed"
              tick
              value={fmtNumber(l.candidates_vetoed ?? 0)}
              hint="rejected by the skeptic before any compute was spent"
            />
            <Metric
              label="Measurements"
              tick
              value={fmtNumber(l.measurements ?? 0)}
              hint="individual property values recorded"
            />
            <Metric
              label="Model calls"
              tick
              value={fmtNumber(l.llm_calls ?? 0)}
              hint={`${fmtNumber(ledger?.llm_input_tokens ?? 0)} in / ${fmtNumber(ledger?.llm_output_tokens ?? 0)} out tokens`}
            />
            <Metric
              label="Wall time"
              value={fmtDuration(wall)}
              hint="end to end, as recorded in the event log"
            />
            <Metric
              label="Scorer time"
              value={fmtDuration(ledger?.scorer_seconds ?? 0)}
              hint="time inside the physics models"
            />
          </div>

          {dft > 0 ? (
            <div className="rise-in border border-accent/25 bg-accent/5 px-3 py-2.5">
              <p className="text-[0.875rem] leading-relaxed text-ink">
                The same screen with DFT would have cost{" "}
                <span className="num text-accent">~{fmtCpuHours(dft)} CPU-hours</span>.
                This campaign took{" "}
                <span className="num text-accent">{fmtDuration(wall)}</span> on one
                machine.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
