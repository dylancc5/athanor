"use client";

import { useEffect, useRef, useState } from "react";
import { hypothesisList, type HypothesisStatus } from "@/lib/campaign-state";
import { VERDICT_COLOR, VERDICT_LABEL } from "@/lib/design";
import { useCampaign } from "@/lib/store";

const HEADLINE: Record<HypothesisStatus, string> = {
  REFUTED: "It was wrong, and it caught it.",
  SUPPORTED: "The prediction held.",
  INCONCLUSIVE: "Not enough to call it either way.",
  OPEN: "",
};

/**
 * A full-width banner the moment the replay crosses a verdict, so the turn of
 * the story does not slip past as one more row in a panel. Only fires while
 * the replay is moving forward, never on a scrub or a jump.
 */
export function VerdictMoment() {
  const state = useCampaign((s) => s.state);
  const playing = useCampaign((s) => s.playing);
  const tour = useCampaign((s) => s.tour);
  const [shown, setShown] = useState<{ status: HypothesisStatus; statement: string } | null>(
    null,
  );
  const decided = useRef(0);

  useEffect(() => {
    const done = hypothesisList(state).filter((h) => h.status !== "OPEN");
    const grew = done.length > decided.current;
    decided.current = done.length;
    if (!grew || !(playing || tour)) return;
    const h = done.at(-1)!;
    setShown({ status: h.status, statement: h.hypothesis.statement });
    const t = setTimeout(() => setShown(null), 4500);
    return () => clearTimeout(t);
  }, [state, playing, tour]);

  if (!shown) return null;
  const color = VERDICT_COLOR[shown.status];

  return (
    <div className="no-print pointer-events-none fixed inset-x-0 top-28 z-40 flex justify-center px-4">
      <div
        key={shown.statement}
        role="status"
        aria-live="assertive"
        className="verdict-drop w-full max-w-3xl border bg-ground/95 px-6 py-5 text-center shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur"
        style={{ borderColor: `${color}88`, boxShadow: `0 0 80px -20px ${color}` }}
      >
        <div
          className="font-mono text-[2.25rem] font-medium leading-none tracking-[0.2em] sm:text-[3rem]"
          style={{ color }}
        >
          {VERDICT_LABEL[shown.status].toUpperCase()}
        </div>
        <p className="mt-3 text-[1.125rem] font-medium text-ink">{HEADLINE[shown.status]}</p>
        <p className="mx-auto mt-1.5 max-w-2xl text-[0.875rem] leading-relaxed text-ink-dim">
          “{shown.statement}”
        </p>
      </div>
    </div>
  );
}
