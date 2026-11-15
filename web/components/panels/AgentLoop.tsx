"use client";

import { useMemo } from "react";
import type { Event } from "@/lib/contracts";
import { AUTHOR_COLOR } from "@/lib/design";
import { useCampaign } from "@/lib/store";

/** The loop the campaign runs, in order. */
const STAGES = [
  { id: "strategist", label: "Strategist", does: "proposes a hypothesis and candidates" },
  { id: "skeptic", label: "Skeptic", does: "vetoes bad candidates before compute is spent" },
  { id: "scorers", label: "Physics", does: "measures each candidate with ML potentials" },
  { id: "analyst", label: "Analyst", does: "holds the hypothesis to its own test" },
  { id: "controller", label: "Controller", does: "decides what to do next" },
] as const;

type StageId = (typeof STAGES)[number]["id"];

const STAGE_COLOR: Record<StageId, string> = {
  strategist: AUTHOR_COLOR.strategist,
  skeptic: AUTHOR_COLOR.skeptic,
  scorers: "#38bdf8",
  analyst: AUTHOR_COLOR.analyst,
  controller: AUTHOR_COLOR.controller,
};

function stageOf(e: Event): StageId | null {
  const b = e.body;
  switch (b.type) {
    case "spec.created":
    case "hypothesis.proposed":
    case "candidates.generated":
      return "strategist";
    case "skeptic.reviewed":
      return "skeptic";
    case "scoring.started":
    case "measurement.recorded":
    case "artifact.created":
    case "embedding.updated":
      return "scorers";
    case "analyst.verdict":
    case "pareto.updated":
      return "analyst";
    case "controller.decision":
    case "proposal.created":
    case "ledger.updated":
      return "controller";
    case "notebook.delta":
      return b.author === "system" ? null : (b.author as StageId);
    default:
      return null;
  }
}

/**
 * Which agent is working right now, as a lit-up step in the loop. Reads the
 * most recent event that belongs to a stage.
 */
export function AgentLoop() {
  const events = useCampaign((s) => s.events);
  const cursor = useCampaign((s) => s.cursor);
  const playing = useCampaign((s) => s.playing);
  const completed = useCampaign((s) => s.state.completed);

  const active = useMemo(() => {
    for (let i = cursor - 1; i >= 0; i--) {
      const s = stageOf(events[i]);
      if (s) return s;
    }
    return null;
  }, [events, cursor]);

  if (events.length === 0) return null;
  const activeIdx = STAGES.findIndex((s) => s.id === active);

  return (
    <ol
      aria-label="Agent loop"
      className="no-print flex flex-wrap items-stretch gap-1.5 border border-rule bg-panel px-3 py-2"
    >
      {STAGES.map((s, i) => {
        const on = !completed && s.id === active;
        const past = completed || i < activeIdx;
        const color = STAGE_COLOR[s.id];
        return (
          <li key={s.id} className="flex min-w-0 flex-1 items-center gap-1.5">
            <div
              aria-current={on ? "step" : undefined}
              title={s.does}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded border px-2.5 py-1.5 transition-all duration-300 ${
                on ? "bg-panel-2" : "border-transparent"
              }`}
              style={on ? { borderColor: `${color}99`, boxShadow: `0 0 18px -6px ${color}` } : undefined}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${on && playing ? "agent-pulse" : ""}`}
                style={{
                  background: on || past ? color : "transparent",
                  border: `1px solid ${color}`,
                  color,
                  opacity: on || past ? 1 : 0.5,
                }}
              />
              <span className="flex min-w-0 flex-col">
                <span
                  className="truncate text-[0.8125rem] font-medium leading-tight"
                  style={{ color: on ? color : past ? "var(--color-ink)" : "var(--color-ink-faint)" }}
                >
                  {s.label}
                </span>
                <span className="hidden truncate text-[0.6875rem] leading-tight text-ink-faint lg:block">
                  {s.does}
                </span>
              </span>
            </div>
            {i < STAGES.length - 1 ? (
              <span aria-hidden className="shrink-0 text-ink-faint/50">
                →
              </span>
            ) : (
              <span aria-hidden className="shrink-0 text-ink-faint/50" title="and back to the strategist">
                ↺
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
