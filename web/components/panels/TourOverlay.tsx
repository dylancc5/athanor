"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Bits";
import { CHAPTERS, TOUR, chapterOf } from "@/lib/tour";
import { useCampaign } from "@/lib/store";

/**
 * Dims every panel except the one being narrated. Pass null to light them all.
 * Done on the DOM rather than through React so no panel has to know about it.
 */
function spotlight(id: string | null) {
  const root = document.getElementById("dashboard");
  if (!root) return;
  for (const el of root.querySelectorAll('[id^="panel-"]')) el.classList.remove("is-spot");
  if (id === null) {
    root.dataset.spotlight = "off";
    return;
  }
  document.getElementById(id)?.classList.add("is-spot");
  root.dataset.spotlight = "on";
}

/**
 * Drives itself through the campaign: watches the cursor, fires the first
 * matching beat, switches panels and 3D views, holds the replay while the
 * caption is on screen, then lets it run on. No interaction needed.
 */
export function TourOverlay() {
  const tour = useCampaign((s) => s.tour);
  const events = useCampaign((s) => s.events);
  const cursor = useCampaign((s) => s.cursor);
  const state = useCampaign((s) => s.state);
  const caption = useCampaign((s) => s.tourCaption);
  const tourStep = useCampaign((s) => s.tourStep);
  const setTourCaption = useCampaign((s) => s.setTourCaption);
  const setTour = useCampaign((s) => s.setTour);
  const setView = useCampaign((s) => s.setView);
  const pause = useCampaign((s) => s.pause);
  const play = useCampaign((s) => s.play);

  const fired = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);

  // reset when the tour restarts or the campaign changes
  useEffect(() => {
    if (!tour) {
      fired.current = new Set();
      setHolding(false);
      spotlight(null);
    }
  }, [tour]);

  useEffect(() => {
    fired.current = new Set();
  }, [events]);

  useEffect(() => {
    if (!tour || cursor === 0 || holding) return;
    const event = events[cursor - 1];
    if (!event) return;

    const beat = TOUR.find(
      (b) => !fired.current.has(b.id) && b.match(event, state),
    );
    if (!beat) return;

    fired.current.add(beat.id);
    const body = beat.body(state, event);
    if (!body) return;

    if (beat.view) setView(beat.view);
    if (beat.focus) {
      document
        .getElementById(beat.focus)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    spotlight(beat.focus ?? null);
    setTourCaption({ title: beat.title, body }, TOUR.indexOf(beat));

    // hold the replay for as long as the caption needs to be read
    pause();
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      timer.current = null;
      const s = useCampaign.getState();
      // At the end of the log `play()` rewinds to 0, which would wipe the
      // board under the closing caption. Stop instead.
      if (s.tour && s.cursor < s.events.length) play();
    }, beat.dwellMs);

    // NO cleanup that clears `timer` here. This effect re-runs the moment
    // `setHolding(true)` lands, so a cleanup would cancel the dwell timer it
    // had just set and the tour would freeze on its first caption forever.
    // The timer is cleared when the tour stops and on unmount, below.
    // state is intentionally a dependency: beats can match on derived state
  }, [tour, cursor, events, state, holding, pause, play, setTourCaption, setView]);

  // Stop any pending dwell when the tour is switched off, and on unmount.
  useEffect(() => {
    if (tour) return;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, [tour]);

  useEffect(
    () => () => {
      spotlight(null);
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    },
    [],
  );

  if (!tour || !caption) return null;

  // from the store, not the ref — a ref would never re-render the counter
  const chapter = chapterOf(TOUR[tourStep]?.id);

  return (
    <div className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-5">
      <div
        key={caption.title}
        role="status"
        aria-live="polite"
        className="rise-in pointer-events-auto w-full max-w-4xl border border-rule-bright bg-panel/95 shadow-[0_-8px_40px_rgba(0,0,0,0.55)] backdrop-blur"
      >
        <div className="h-px w-full bg-gradient-to-r from-accent via-accent/40 to-transparent" />
        <div className="flex items-start gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <ol aria-label="Story chapters" className="flex flex-wrap items-center gap-1">
              {CHAPTERS.map((c, i) => (
                <li
                  key={c.title}
                  aria-current={i === chapter ? "step" : undefined}
                  className={`flex items-center gap-1 text-[0.6875rem] transition-colors ${
                    i === chapter ? "text-accent" : i < chapter ? "text-ink-dim" : "text-ink-faint/60"
                  }`}
                >
                  <span
                    className={`num flex h-4 w-4 items-center justify-center rounded-full border text-[0.5625rem] ${
                      i === chapter
                        ? "border-accent bg-accent/20"
                        : i < chapter
                          ? "border-ink-dim/50 bg-ink-dim/10"
                          : "border-rule-bright"
                    }`}
                  >
                    {i < chapter ? "✓" : i + 1}
                  </span>
                  {c.title}
                  {i < CHAPTERS.length - 1 ? (
                    <span aria-hidden className="mx-1 text-ink-faint/40">
                      —
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
            <h3 className="text-[1.375rem] font-medium leading-snug tracking-tight text-ink">
              {caption.title}
            </h3>
            <p className="text-[1rem] leading-[1.6] text-ink-dim">{caption.body}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5">
            <Button
              size="sm"
              onClick={() => {
                if (timer.current !== null) {
                  clearTimeout(timer.current);
                  timer.current = null;
                }
                setHolding(false);
                const s = useCampaign.getState();
                if (s.cursor < s.events.length) play();
              }}
              title="Skip ahead to the next moment"
            >
              Skip
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (timer.current !== null) {
                  clearTimeout(timer.current);
                  timer.current = null;
                }
                setHolding(false);
                setTour(false);
                setTourCaption(null, -1);
              }}
              title="Leave the tour and explore freely"
            >
              Exit
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
