"use client";

import { Panel, EmptyNote } from "@/components/ui/Panel";
import { Button, Chip } from "@/components/ui/Bits";
import { useCampaign } from "@/lib/store";

function Section({
  heading,
  items,
  ordered,
  accent,
}: {
  heading: string;
  items: string[];
  ordered?: boolean;
  accent?: string;
}) {
  if (items.length === 0) return null;
  const List = ordered ? "ol" : "ul";
  return (
    <section className="flex flex-col gap-1.5">
      <h2
        className="label"
        style={accent ? { color: accent } : undefined}
      >
        {heading}
      </h2>
      <List className="flex flex-col gap-1.5">
        {items.map((item, i) => (
          <li
            key={i}
            className="grid grid-cols-[1.25rem_1fr] gap-2 text-[0.8125rem] leading-relaxed text-ink-dim"
          >
            <span className="num pt-0.5 text-[0.6875rem] text-ink-faint">
              {ordered ? `${i + 1}.` : "—"}
            </span>
            <span>{item}</span>
          </li>
        ))}
      </List>
    </section>
  );
}

export function ProposalPanel() {
  const state = useCampaign((s) => s.state);
  const p = state.proposal;

  return (
    <Panel
      id="panel-proposal"
      title="Experimental proposal"
      eyebrow={p ? "ready to run" : undefined}
      right={
        p ? (
          <Button
            className="no-print"
            onClick={() => window.print()}
            title="Print or save the proposal as a PDF"
          >
            Download PDF
          </Button>
        ) : null
      }
      bodyClassName="print-sheet"
    >
      {!p ? (
        <EmptyNote>
          The campaign closes with a proposal a bench scientist could actually run:
          a synthesis route, a validation protocol, and the results that would prove
          it wrong.
        </EmptyNote>
      ) : (
        <article className="flex flex-col gap-4 p-3">
          <header className="flex flex-col gap-2 border-b border-rule pb-3">
            <h1 className="text-[1.0625rem] font-medium leading-snug tracking-tight text-ink">
              {p.title}
            </h1>
            <p className="text-[0.8125rem] leading-relaxed text-ink-dim">{p.summary}</p>
            {p.lead_candidate_ids.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="label">Leads</span>
                {p.lead_candidate_ids.map((id) => (
                  <Chip key={id} color="#38bdf8" tone="outline">
                    {state.candidates[id]?.name ?? id}
                  </Chip>
                ))}
              </div>
            ) : null}
            <p className="print-only num text-[0.6875rem] text-ink-faint">
              ATHANOR autonomous research campaign · {state.spec?.title ?? ""} ·{" "}
              {state.candidateIds.length} candidates screened ·{" "}
              {state.measurementLog.length} measurements
            </p>
          </header>

          <Section heading="Synthesis route" items={p.synthesis_route} ordered />
          <Section heading="Validation protocol" items={p.validation_protocol} ordered />
          <Section
            heading="What would prove this wrong"
            items={p.falsification_criteria}
            accent="#f87171"
          />
          <Section heading="Caveats and limits" items={p.caveats} accent="#fbbf24" />

          {state.heuristics.length > 0 ? (
            <section className="flex flex-col gap-1.5 border-t border-rule pt-3">
              <h2 className="label">Heuristics carried forward</h2>
              <ul className="flex flex-col gap-1.5">
                {state.heuristics.map((h) => (
                  <li key={h.id} className="flex items-start gap-2">
                    <Chip
                      color={h.strength === "established" ? "#34d399" : "#94a3b8"}
                      title={`learned from ${h.learned_from}`}
                    >
                      {h.strength}
                    </Chip>
                    <span className="text-[0.8125rem] leading-relaxed text-ink-dim">
                      {h.text}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </article>
      )}
    </Panel>
  );
}
