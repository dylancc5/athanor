"use client";

import { useEffect, useRef, useState } from "react";
import { Panel, EmptyNote } from "@/components/ui/Panel";
import { Chip } from "@/components/ui/Bits";
import { VERDICT_COLOR, VERDICT_LABEL, VETO_LABEL } from "@/lib/design";
import {
  type HypothesisRecord,
  type HypothesisStatus,
  hypothesisList,
  verdictCounts,
} from "@/lib/campaign-state";
import { useCampaign } from "@/lib/store";

/** Remembers which hypotheses just changed verdict, so the card can animate
 *  exactly once when the verdict lands. */
function useJustDecided(records: HypothesisRecord[]) {
  const prev = useRef<Record<string, HypothesisStatus>>({});
  const [flash, setFlash] = useState<string[]>([]);

  useEffect(() => {
    const changed: string[] = [];
    const next: Record<string, HypothesisStatus> = {};
    for (const r of records) {
      next[r.hypothesis.id] = r.status;
      const before = prev.current[r.hypothesis.id];
      if (before && before !== r.status && r.status !== "OPEN") {
        changed.push(r.hypothesis.id);
      }
    }
    prev.current = next;
    if (changed.length === 0) return;
    setFlash(changed);
    const timer = setTimeout(() => setFlash([]), 1200);
    return () => clearTimeout(timer);
  }, [records]);

  return flash;
}

function VerdictBadge({ status, flash }: { status: HypothesisStatus; flash: boolean }) {
  const color = VERDICT_COLOR[status];
  const refuted = status === "REFUTED";
  return (
    <div
      style={{ color }}
      className={`relative inline-flex items-center gap-2 ${flash ? "verdict-strike" : ""}`}
    >
      <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
        <span
          className="block h-1.5 w-1.5 rounded-full"
          style={{ background: color }}
        />
        {status === "OPEN" ? (
          <span className="pulse-ring absolute inset-0 rounded-full" />
        ) : null}
      </span>
      <span
        className={`font-mono tracking-[0.18em] ${
          refuted ? "text-[0.8125rem] font-semibold" : "text-[0.6875rem]"
        }`}
        style={{ color }}
      >
        {VERDICT_LABEL[status].toUpperCase()}
      </span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-0.5 border-t border-rule/70 pt-2">
      <span className="label pt-0.5">{label}</span>
      <div className="text-[0.75rem] leading-relaxed text-ink-dim">{children}</div>
    </div>
  );
}

function Card({
  record,
  flash,
  selected,
  onSelect,
}: {
  record: HypothesisRecord;
  flash: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { hypothesis: h, status } = record;
  const color = VERDICT_COLOR[status];
  const refuted = status === "REFUTED";

  return (
    <article
      onClick={onSelect}
      className={`rise-in group cursor-pointer border bg-panel-2 transition-colors ${
        selected ? "border-accent/50" : "border-rule hover:border-rule-bright"
      }`}
      style={
        refuted
          ? {
              background:
                "repeating-linear-gradient(135deg, rgba(248,113,113,0.045) 0 6px, transparent 6px 14px), #090c12",
            }
          : undefined
      }
    >
      <div
        className="h-px w-full"
        style={{ background: `linear-gradient(90deg, ${color}, transparent 70%)` }}
      />
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="num text-[0.6875rem] text-ink-faint">
            R{h.round} · {h.id}
          </span>
          {h.branch && h.branch !== "main" ? (
            <Chip tone="ghost">{h.branch}</Chip>
          ) : null}
        </div>
        <VerdictBadge status={status} flash={flash} />
      </div>

      <p
        className={`px-3 pb-2.5 text-[0.875rem] leading-snug ${
          refuted ? "text-ink-dim" : "text-ink"
        }`}
      >
        {h.statement}
      </p>

      <div className="flex flex-col gap-2 px-3 pb-3">
        <Field label="Prediction">{h.prediction}</Field>
        <Field label="Falsified if">
          <span className={refuted ? "text-refuted" : undefined}>
            {h.falsification_criterion}
          </span>
        </Field>
        {record.vetoes.length > 0 ? (
          <Field label="Skeptic">
            <div className="flex flex-col gap-1">
              {record.vetoes.map((v, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Chip color="#fbbf24">{VETO_LABEL[v.category] ?? v.category}</Chip>
                  <span className="min-w-0">{v.reason}</span>
                </div>
              ))}
            </div>
          </Field>
        ) : null}

        {record.verdictReasoning ? (
          <div
            className="border-l-2 bg-ground/40 px-2.5 py-2"
            style={{ borderColor: color }}
          >
            <span className="label" style={{ color }}>
              Evidence
            </span>
            <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink">
              {record.verdictReasoning}
            </p>
            {record.heuristics.length > 0 ? (
              <ul className="mt-2.5 flex flex-col gap-1.5 border-t border-rule pt-2">
                {record.heuristics.map((heu) => (
                  <li key={heu.id} className="flex items-start gap-2">
                    <Chip
                      color={heu.strength === "established" ? "#34d399" : "#94a3b8"}
                      title={`learned from ${heu.learned_from}`}
                    >
                      learned
                    </Chip>
                    <span className="text-[0.75rem] leading-relaxed text-ink-dim">
                      {heu.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2 border-t border-rule/70 pt-2">
            <span className="label">Testing</span>
            <span className="num text-[0.6875rem] text-ink-faint">
              {record.candidateIds.length} candidates ·{" "}
              {h.batch_plan.properties.join(", ")}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

export function HypothesisBoard() {
  const state = useCampaign((s) => s.state);
  const selected = useCampaign((s) => s.selectedHypothesisId);
  const selectHypothesis = useCampaign((s) => s.selectHypothesis);
  const records = hypothesisList(state);
  const flash = useJustDecided(records);
  const counts = verdictCounts(state);

  return (
    <Panel
      id="panel-hypotheses"
      title="Hypothesis board"
      eyebrow={`${records.length} proposed`}
      right={
        <div className="flex items-center gap-1.5">
          {(["REFUTED", "SUPPORTED", "INCONCLUSIVE", "OPEN"] as HypothesisStatus[])
            .filter((k) => counts[k] > 0)
            .map((k) => (
              <Chip key={k} color={VERDICT_COLOR[k]}>
                {counts[k]} {VERDICT_LABEL[k]}
              </Chip>
            ))}
        </div>
      }
      bodyClassName="p-2.5"
    >
      {records.length === 0 ? (
        <EmptyNote>
          The strategist has not proposed a hypothesis yet. Each one arrives with a
          prediction and the condition that would kill it.
        </EmptyNote>
      ) : (
        <div className="flex flex-col gap-2.5">
          {records.map((r) => (
            <Card
              key={r.hypothesis.id}
              record={r}
              flash={flash.includes(r.hypothesis.id)}
              selected={selected === r.hypothesis.id}
              onSelect={() =>
                selectHypothesis(selected === r.hypothesis.id ? null : r.hypothesis.id)
              }
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
