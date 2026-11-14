"use client";

import { useMemo, useRef, useState } from "react";
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

interface Mark {
  i: number;
  color: string;
  label: string;
  big: boolean;
}

/** How close (in px) the pointer has to be to a mark to name it. */
const SNAP_PX = 7;

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

  const track = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ x: number; text: string; color: string | null } | null>(
    null,
  );

  const n = events.length;
  const marks = useMemo<Mark[]>(() => {
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
      .filter((m): m is Mark => Boolean(m));
  }, [events, n]);

  /** One legend entry per kind of mark that actually occurs in this log. */
  const legend = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of marks) {
      const name = m.big ? "verdict" : m.label;
      if (!seen.has(name)) seen.set(name, m.color);
    }
    return [...seen.entries()];
  }, [marks]);

  const firstVerdict = useMemo(
    () => events.findIndex((e) => e.body.type === "analyst.verdict"),
    [events],
  );

  const frac = n === 0 ? 0 : cursor / n;
  const current = cursor > 0 ? events[cursor - 1] : null;

  // The range input covers the whole strip so it can take the drag, which
  // means the marks underneath never receive a hover. Name them from the
  // pointer position instead.
  const onMove = (clientX: number) => {
    const el = track.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    let best: Mark | null = null;
    let bestD = SNAP_PX;
    for (const m of marks) {
      const d = Math.abs(((m.i + 1) / n) * rect.width - x);
      if (d <= bestD) {
        best = m;
        bestD = d;
      }
    }
    if (best) {
      setHover({
        x: ((best.i + 1) / n) * rect.width,
        text: `${best.label} · event ${best.i + 1}`,
        color: best.color,
      });
    } else {
      const at = Math.max(0, Math.min(n, Math.round((x / rect.width) * n)));
      setHover({ x, text: `event ${at}/${n}`, color: null });
    }
  };

  return (
    <div className="no-print z-30 md:sticky md:top-0 md:-mx-2.5 md:-mt-2.5 md:border-b md:border-rule md:bg-ground/95 md:px-2.5 md:pt-2.5 md:pb-2.5 md:backdrop-blur-md">
      <div
        role="group"
        aria-label="Replay controls"
        className="panel-surface flex flex-col gap-1.5 border border-rule bg-panel px-3 py-2"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Button
            onClick={toggle}
            tone="accent"
            title={playing ? "Pause (Space)" : "Play (Space)"}
            aria-keyshortcuts="Space"
            className="min-w-[4.25rem]"
          >
            {playing ? "Pause" : "Play"}
          </Button>
          <Button
            size="sm"
            onClick={() => stepBy(-1)}
            title="Previous event (←)"
            aria-keyshortcuts="ArrowLeft"
            disabled={cursor === 0}
          >
            Prev
          </Button>
          <Button
            size="sm"
            onClick={() => stepBy(1)}
            title="Next event (→)"
            aria-keyshortcuts="ArrowRight"
            disabled={cursor >= n}
          >
            Next
          </Button>
          <Button size="sm" onClick={restart} title="Replay from the beginning (Home)">
            Restart
          </Button>

          <div aria-hidden className="mx-1 h-4 w-px bg-rule" />

          <div role="group" aria-label="Replay speed" className="flex items-center gap-1">
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
          </div>

          <div aria-hidden className="mx-1 h-4 w-px bg-rule" />

          {firstVerdict >= 0 ? (
            <Button
              size="sm"
              onClick={() => jumpToEvent((e) => e.body.type === "analyst.verdict")}
              title="Jump to the first verdict"
            >
              Verdict
            </Button>
          ) : null}
          <Button size="sm" onClick={jumpToEnd} title="Jump to the end (End)">
            End
          </Button>

          <div className="ml-auto flex items-center gap-3">
            <span className="num text-[0.75rem] text-ink-faint">
              {state.round > 0 ? `round ${state.round} · ` : ""}
              event {cursor}/{n}
            </span>
            <span className="num text-[0.8125rem] text-ink">{fmtClock(state.lastT)}</span>
          </div>
        </div>

        <div
          ref={track}
          className="relative h-7"
          onPointerMove={(e) => onMove(e.clientX)}
          onPointerLeave={() => setHover(null)}
        >
          {/* the track */}
          <div className="pointer-events-none absolute inset-x-0 top-3 h-1 overflow-hidden rounded-full bg-rule">
            <div
              className="h-full w-full origin-left rounded-full bg-accent/70"
              style={{
                transform: `scaleX(${frac})`,
                // Smooth only while the replay drives it. A scrub or a key press
                // must land where the hand put it, with no lag.
                transition: playing ? "transform 180ms linear" : "none",
              }}
            />
          </div>

          {/* event marks */}
          {marks.map((m) => (
            <span
              key={`${m.i}-${m.label}`}
              aria-hidden
              style={{
                left: `${n === 0 ? 0 : ((m.i + 1) / n) * 100}%`,
                background: m.color,
                opacity: m.i + 1 <= cursor ? 1 : 0.4,
              }}
              className={`pointer-events-none absolute -translate-x-1/2 rounded-full transition-opacity duration-200 ${
                m.big ? "top-0.5 h-5 w-[3px]" : "top-1.5 h-3.5 w-[2px]"
              }`}
            />
          ))}

          {/* playhead halo, only while running */}
          {playing ? (
            <span
              aria-hidden
              className="head-glow pointer-events-none absolute top-1.5 h-4 w-4 -translate-x-1/2 rounded-full bg-accent/40 blur-[6px]"
              style={{ left: `${frac * 100}%` }}
            />
          ) : null}

          {/* names whatever the pointer is over */}
          {hover ? (
            <span
              aria-hidden
              className="num pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded border border-rule-bright bg-ground px-1.5 py-1 text-[0.6875rem] text-ink shadow-[0_4px_16px_rgba(0,0,0,0.5)]"
              style={{ left: hover.x }}
            >
              {hover.color ? (
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                  style={{ background: hover.color }}
                />
              ) : null}
              {hover.text}
            </span>
          ) : null}

          {/* the scrubber itself sits on top and takes all the drag */}
          <input
            type="range"
            min={0}
            max={n}
            step={1}
            value={cursor}
            onChange={(e) => setCursor(Number(e.target.value))}
            aria-label="Campaign timeline"
            aria-valuetext={`event ${cursor} of ${n}${current ? `, ${current.body.type}` : ""}`}
            className="absolute inset-x-0 top-0 h-7 w-full cursor-pointer appearance-none bg-transparent
              [&::-webkit-slider-runnable-track]:h-7 [&::-webkit-slider-runnable-track]:bg-transparent
              [&::-webkit-slider-thumb]:mt-1.5 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-1.5 [&::-webkit-slider-thumb]:appearance-none
              [&::-webkit-slider-thumb]:rounded-sm [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-ground
              [&::-webkit-slider-thumb]:bg-accent
              [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-1.5 [&::-moz-range-thumb]:rounded-sm
              [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:bg-accent
              [&::-moz-range-track]:bg-transparent"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="num min-w-0 truncate text-[0.75rem] text-ink-dim">
            {current ? current.body.type : "start of campaign"}
          </span>
          <div className="flex items-center gap-x-3">
            <ul aria-label="Timeline marks" className="hidden items-center gap-x-3 xl:flex">
              {legend.map(([name, color]) => (
                <li key={name} className="label inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-[3px] rounded-full"
                    style={{ background: color }}
                  />
                  {name}
                </li>
              ))}
            </ul>
            <span aria-live="polite" className="min-w-[8.5rem] text-right">
              {state.completed ? (
                <span className="label text-supported">campaign complete</span>
              ) : playing ? (
                <span className="label text-accent">replaying…</span>
              ) : (
                <span className="label">paused</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
