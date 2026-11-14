"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Bits";
import { TOUR } from "@/lib/tour";
import { useCampaign } from "@/lib/store";

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
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
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
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    },
    [],
  );

  if (!tour || !caption) return null;

  // from the store, not the ref — a ref would never re-render the counter
  const progress = `${Math.max(0, tourStep) + 1}/${TOUR.length}`;

  return (
    <div className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-5">
      <div
        key={caption.title}
        className="rise-in pointer-events-auto w-full max-w-3xl border border-rule-bright bg-panel/95 shadow-[0_-8px_40px_rgba(0,0,0,0.55)] backdrop-blur"
      >
        <div className="h-px w-full bg-gradient-to-r from-accent via-accent/40 to-transparent" />
        <div className="flex items-start gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              <span className="label text-accent">Guided tour</span>
              <span className="num text-[0.625rem] text-ink-faint">{progress}</span>
            </div>
            <h3 className="text-[0.9375rem] font-medium leading-snug tracking-tight text-ink">
              {caption.title}
            </h3>
            <p className="text-[0.8125rem] leading-[1.6] text-ink-dim">{caption.body}</p>
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
