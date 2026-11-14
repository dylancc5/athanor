"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { GoalPanel } from "@/components/panels/GoalPanel";
import { HypothesisBoard } from "@/components/panels/HypothesisBoard";
import { LedgerPanel } from "@/components/panels/LedgerPanel";
import { MeasurementsTable } from "@/components/panels/MeasurementsTable";
import { Notebook } from "@/components/panels/Notebook";
import { ParetoPanel } from "@/components/panels/ParetoPanel";
import { ProposalPanel } from "@/components/panels/ProposalPanel";
import { Timeline } from "@/components/panels/Timeline";
import { TourOverlay } from "@/components/panels/TourOverlay";
import { Button } from "@/components/ui/Bits";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { disposeCampaignStore, useCampaign } from "@/lib/store";
import { isViewName } from "@/lib/views";

// WebGL cannot render on the server, and a Canvas in the prerender would
// break the static build.
const Viewer = dynamic(
  () => import("@/components/panels/viewer/Viewer").then((m) => m.Viewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-0 flex-col border border-rule bg-panel">
        <div className="border-b border-rule px-3 py-2">
          <h2 className="text-[0.8125rem] font-medium text-ink">Viewer</h2>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <span className="label">initializing renderer</span>
        </div>
      </div>
    ),
  },
);

function Header() {
  const state = useCampaign((s) => s.state);
  const campaigns = useCampaign((s) => s.campaigns);
  const campaignId = useCampaign((s) => s.campaignId);
  const loadCampaign = useCampaign((s) => s.loadCampaign);
  const source = useCampaign((s) => s.source);
  const sourceStatus = useCampaign((s) => s.sourceStatus);
  const tour = useCampaign((s) => s.tour);
  const setTour = useCampaign((s) => s.setTour);
  const restart = useCampaign((s) => s.restart);

  // Two campaigns can share a spec title; fall back to the id so the picker
  // never shows two identical buttons.
  const titleCounts = new Map<string, number>();
  for (const c of campaigns) titleCounts.set(c.title, (titleCounts.get(c.title) ?? 0) + 1);

  return (
    <header className="no-print flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-rule bg-panel px-4 py-2.5">
      <div className="flex items-baseline gap-3">
        <h1 className="font-mono text-[0.9375rem] font-medium tracking-[0.24em] text-ink">
          ATHANOR
        </h1>
        <span className="hidden text-[0.6875rem] text-ink-faint sm:inline">
          autonomous research campaigns
        </span>
        {state.spec ? (
          <span className="hidden border-l border-rule pl-3 text-[0.75rem] text-ink-dim md:inline">
            {state.spec.title}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {campaigns.map((c) => (
          <Button
            key={c.id}
            size="sm"
            active={c.id === campaignId}
            title={c.goal}
            onClick={() => void loadCampaign(c.id, { play: true })}
          >
            {(titleCounts.get(c.title) ?? 0) > 1 ? `${c.title} · ${c.id}` : c.title}
          </Button>
        ))}
        <div className="mx-1 h-4 w-px bg-rule" />
        <Button
          size="sm"
          active={tour}
          onClick={() => {
            setTour(!tour);
            if (!tour) restart();
          }}
          title="Drive the campaign with explanatory captions"
        >
          Tour
        </Button>
        <span
          className="label ml-1"
          title={
            source?.kind === "api"
              ? "connected to the ATHANOR backend"
              : "replaying recorded campaigns from static files — no backend required"
          }
        >
          {sourceStatus === "detecting" ? "connecting" : (source?.label ?? "offline")}
        </span>
      </div>
    </header>
  );
}

/** Reads `?campaign=&seq=&view=&tour=1` once, then keeps the URL in step. */
function useDeepLink() {
  const params = useSearchParams();
  const sourceStatus = useCampaign((s) => s.sourceStatus);
  const campaigns = useCampaign((s) => s.campaigns);
  const loadCampaign = useCampaign((s) => s.loadCampaign);
  const setView = useCampaign((s) => s.setView);
  const setTour = useCampaign((s) => s.setTour);
  const applied = useRef(false);

  // restore
  useEffect(() => {
    if (applied.current || sourceStatus !== "ready" || campaigns.length === 0) return;
    applied.current = true;

    const wanted = params.get("campaign");
    const id = campaigns.find((c) => c.id === wanted)?.id ?? campaigns[0].id;
    const view = params.get("view");
    const seqParam = params.get("seq");
    const wantTour = params.get("tour") === "1";

    if (isViewName(view)) setView(view);

    void loadCampaign(id, { play: wantTour || seqParam === null }).then(() => {
      if (seqParam !== null) {
        const seq = Number(seqParam);
        if (Number.isFinite(seq)) {
          const { events, setCursor } = useCampaign.getState();
          // `seq` is the event's seq, not its array index
          let cursor = 0;
          for (let i = 0; i < events.length; i++) {
            if (events[i].seq <= seq) cursor = i + 1;
            else break;
          }
          setCursor(cursor);
        }
      }
      if (wantTour) setTour(true);
    });
  }, [sourceStatus, campaigns, params, loadCampaign, setView, setTour]);

  // keep the address bar shareable while paused
  const campaignId = useCampaign((s) => s.campaignId);
  const cursor = useCampaign((s) => s.cursor);
  const view = useCampaign((s) => s.view);
  const playing = useCampaign((s) => s.playing);
  const events = useCampaign((s) => s.events);

  useEffect(() => {
    if (!applied.current || playing || !campaignId) return;
    const next = new URLSearchParams(window.location.search);
    next.set("campaign", campaignId);
    next.set("view", view);
    if (cursor > 0 && events[cursor - 1]) next.set("seq", String(events[cursor - 1].seq));
    else next.delete("seq");
    window.history.replaceState(null, "", `?${next.toString()}`);
  }, [campaignId, cursor, view, playing, events]);
}

export function AppShell() {
  const init = useCampaign((s) => s.init);
  const loadError = useCampaign((s) => s.loadError);
  useDeepLink();

  useEffect(() => {
    void init();
    return () => disposeCampaignStore();
  }, [init]);

  return (
    <div className="flex h-dvh flex-col bg-ground">
      <Header />

      {loadError ? (
        <div className="no-print shrink-0 border-b border-refuted/40 bg-refuted/10 px-4 py-1.5">
          <span className="num text-[0.6875rem] text-refuted">{loadError}</span>
        </div>
      ) : null}

      <main className="instrument-grid min-h-0 flex-1 overflow-y-auto p-2.5">
        <div className="mx-auto flex min-h-full max-w-[1800px] flex-col gap-2.5">
          <Timeline />

          <div className="grid min-h-0 flex-1 gap-2.5 xl:grid-cols-[minmax(0,19rem)_minmax(0,1.15fr)_minmax(0,1fr)]">
            {/* left rail: intake, cost */}
            <div className="flex min-h-0 flex-col gap-2.5">
              <GoalPanel />
              <LedgerPanel />
            </div>

            {/* centre: the money shot, then the evidence under it */}
            <div className="flex min-h-0 flex-col gap-2.5">
              <div className="min-h-[22rem] xl:max-h-[46vh]">
                <HypothesisBoard />
              </div>
              <div className="min-h-[16rem] xl:max-h-[32vh]">
                <MeasurementsTable />
              </div>
              <ProposalPanel />
            </div>

            {/* right: what it is thinking and what it is looking at */}
            <div className="flex min-h-0 flex-col gap-2.5">
              <div className="h-[27rem] shrink-0">
                <ErrorBoundary label="viewer-host">
                  <Viewer />
                </ErrorBoundary>
              </div>
              <ParetoPanel />
              <div className="min-h-[18rem] flex-1">
                <Notebook />
              </div>
            </div>
          </div>
        </div>
      </main>

      <TourOverlay />
    </div>
  );
}
