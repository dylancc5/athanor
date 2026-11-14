"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/Bits";
import { VERDICT_COLOR } from "@/lib/design";
import { fmtClock } from "@/lib/format";
import { useCampaign } from "@/lib/store";

/** Event types that deserve a visible mark on the timeline. */
const MARKS: Record<string, { color: string; label: string }> = {
  "spec.created": { color: "#38bdf8", label: "spec" },
  "round.started": { color: "#64748b", label: "round" },
  "hypothesis.proposed": { color: "#94a3b8", label: "hypothesis" },
  "skeptic.reviewed": { color: "#fbbf24", label: "skeptic review" },
  "pareto.updated": { color: "#0e7490", label: "pareto" },
  "controller.decision": { color: "#a78bfa", label: "controller" },
  "proposal.created": { color: "#34d399", label: "proposal" },
  "campaign.completed": { color: "#34d399", label: "complete" },
  "campaign.error": { color: "#f87171", label: "error" },
};

const SPEEDS = [0.5, 1, 2, 4];

export function Timeline() {
  const events = useCampaign((s) => s.events);
  const cursor = useCampaign((s) => s.cursor);
  const playing = useCampaign((s) => s.playing);
  const speed = useCampaign((s) => s.speed);
  const state = useCampaign((s) => s.state);
  const setCursor = useCampaign((s) => s.setCursor);
  const stepBy = useCampaign((s) => s.stepBy);
  const toggle = useCampaign((s) => s.toggle);
  const setSpeed = useCampaign((s) => s.setSpeed);
  const restart = useCampaign((s) => s.restart);
  const jumpToEnd = useCampaign((s) => s.jumpToEnd);
  const jumpToEvent = useCampaign((s) => s.jumpToEvent);

  const n = events.length;
  const marks = useMemo(() => {
    if (n === 0) return [];
    return events
      .map((e, i) => {
        const type = e.body.type;
        if (type === "analyst.verdict") {
          return {
            i,
            color: VERDICT_COLOR[e.body.verdict],
            label: `verdict: ${e.body.verdict.toLowerCase()}`,
            big: true,
          };
        }
        const m = MARKS[type];
        return m ? { i, color: m.color, label: m.label, big: false } : null;
      })
      .filter((m): m is { i: number; color: string; label: string; big: boolean } =>
        Boolean(m),
      );
  }, [events, n]);

  const firstVerdict = useMemo(
    () => events.findIndex((e) => e.body.type === "analyst.verdict"),
    [events],
  );

  const pct = n === 0 ? 0 : (cursor / n) * 100;
  const current = cursor > 0 ? events[cursor - 1] : null;

  return (
    <div className="no-print flex flex-col gap-1.5 border border-rule bg-panel px-3 py-2">
      <div className="flex items-center gap-2">
        <Button onClick={toggle} tone="accent" title={playing ? "Pause" : "Play"}>
          {playing ? "Pause" : "Play"}
        </Button>
        <Button size="sm" onClick={() => stepBy(-1)} title="Previous event" disabled={cursor === 0}>
          Prev
        </Button>
        <Button
          size="sm"
          onClick={() => stepBy(1)}
          title="Next event"
          disabled={cursor >= n}
        >
          Next
        </Button>
        <Button size="sm" onClick={restart} title="Replay from the beginning">
          Restart
        </Button>

        <div className="mx-1 h-4 w-px bg-rule" />

        {SPEEDS.map((s) => (
          <Button
            key={s}
            size="sm"
            active={speed === s}
            onClick={() => setSpeed(s)}
            title={`${s}x replay speed`}
          >
            {s}x
          </Button>
        ))}

        <div className="mx-1 h-4 w-px bg-rule" />

        {firstVerdict >= 0 ? (
          <Button
            size="sm"
            onClick={() => jumpToEvent((e) => e.body.type === "analyst.verdict")}
            title="Jump to the first verdict"
          >
            Verdict
          </Button>
        ) : null}
        <Button size="sm" onClick={jumpToEnd} title="Jump to the end">
          End
        </Button>

        <div className="ml-auto flex items-center gap-3">
          <span className="num text-[0.6875rem] text-ink-faint">
            {state.round > 0 ? `round ${state.round} · ` : ""}
            {cursor}/{n}
          </span>
          <span className="num text-[0.6875rem] text-ink-dim">
            {fmtClock(state.lastT)}
          </span>
        </div>
      </div>

      <div className="relative h-7">
        {/* the track */}
        <div className="pointer-events-none absolute inset-x-0 top-3 h-1 rounded-full bg-rule">
          <div
            className="h-full rounded-full bg-accent/70"
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* event marks */}
        {marks.map((m) => (
          <button
            key={`${m.i}-${m.label}`}
            type="button"
            title={`${m.label} — event ${m.i + 1}`}
            onClick={() => setCursor(m.i + 1)}
            style={{
              left: `${n === 0 ? 0 : ((m.i + 1) / n) * 100}%`,
              background: m.color,
              opacity: m.i + 1 <= cursor ? 1 : 0.4,
            }}
            className={`absolute -translate-x-1/2 rounded-full transition-opacity ${
              m.big ? "top-0.5 h-5 w-[3px]" : "top-1.5 h-3.5 w-[2px]"
            }`}
          />
        ))}

        {/* the scrubber itself sits on top and takes all the drag */}
        <input
          type="range"
          min={0}
          max={n}
          step={1}
          value={cursor}
          onChange={(e) => setCursor(Number(e.target.value))}
          aria-label="Campaign timeline"
          className="absolute inset-x-0 top-0 h-7 w-full cursor-pointer appearance-none bg-transparent
            [&::-webkit-slider-runnable-track]:h-7 [&::-webkit-slider-runnable-track]:bg-transparent
            [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-1.5 [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:rounded-sm [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-ground
            [&::-webkit-slider-thumb]:bg-accent
            [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-1.5 [&::-moz-range-thumb]:rounded-sm
            [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:bg-accent
            [&::-moz-range-track]:bg-transparent"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="num truncate text-[0.625rem] text-ink-faint">
          {current ? current.body.type : "start of campaign"}
        </span>
        {state.completed ? (
          <span className="label text-supported">campaign complete</span>
        ) : playing ? (
          <span className="label text-accent">replaying</span>
        ) : null}
      </div>
    </div>
  );
}
