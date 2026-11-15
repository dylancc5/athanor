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
          <h2 className="text-[0.875rem] font-medium text-ink">Viewer</h2>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <span className="label">initializing renderer…</span>
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
  const playing = useCampaign((s) => s.playing);
  const tour = useCampaign((s) => s.tour);
  const setTour = useCampaign((s) => s.setTour);
  const restart = useCampaign((s) => s.restart);

  // Two campaigns can share a spec title; fall back to the id so the picker
  // never shows two identical options.
  const titleCounts = new Map<string, number>();
  for (const c of campaigns) titleCounts.set(c.title, (titleCounts.get(c.title) ?? 0) + 1);

  const live = source?.kind === "api";
  const statusText =
    sourceStatus === "detecting" ? "connecting…" : (source?.label ?? "offline");

  return (
    <header className="no-print flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule bg-panel px-4 py-2.5">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="font-mono text-[1rem] font-medium tracking-[0.24em] text-ink">
          ATHANOR
        </h1>
        <span className="hidden text-[0.8125rem] text-ink-faint sm:inline">
          autonomous research campaigns
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {/* The picker is navigation, not a call to action, so it looks like a
            select. The chosen title appears here and nowhere else in the header. */}
        {campaigns.length > 0 ? (
          <label className="flex items-center gap-2">
            <span className="text-[0.8125rem] text-ink-faint">Campaign</span>
            <span className="relative">
              <select
                value={campaignId ?? ""}
                onChange={(e) => void loadCampaign(e.target.value, { play: true })}
                title={campaigns.find((c) => c.id === campaignId)?.goal}
                className="appearance-none rounded border border-rule bg-panel-2 py-1 pr-7 pl-2 text-[0.8125rem] text-ink transition-colors hover:border-rule-bright focus-visible:border-accent/60"
              >
                {campaignId === null ? (
                  <option value="">{state.spec?.title ?? "—"}</option>
                ) : null}
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {(titleCounts.get(c.title) ?? 0) > 1 ? `${c.title} · ${c.id}` : c.title}
                  </option>
                ))}
              </select>
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[0.625rem] text-ink-faint"
              >
                ▾
              </span>
            </span>
          </label>
        ) : null}
        <div aria-hidden className="mx-1 h-4 w-px bg-rule" />
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
          className="label ml-1.5 inline-flex items-center gap-1.5"
          title={
            live
              ? "connected to the ATHANOR backend"
              : "replaying recorded campaigns from static files — no backend required"
          }
        >
          <span
            aria-hidden
            className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
              sourceStatus === "detecting"
                ? "bg-inconclusive"
                : live
                  ? "bg-supported"
                  : "bg-accent"
            } ${playing ? "pulse-ring" : ""}`}
            style={{ color: live ? "var(--color-supported)" : "var(--color-accent)" }}
          />
          {statusText}
        </span>
      </div>
    </header>
  );
}

/**
 * Transport shortcuts. Deliberately not bound while focus is inside a field
 * or on a control that already owns the key — Space on a focused button must
 * still press that button, and the arrows must still move a focused slider.
 */
function useTransportKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) {
        return;
      }
      const onControl = tag === "BUTTON" || tag === "A" || el?.getAttribute("role") === "button";
      const s = useCampaign.getState();
      if (s.events.length === 0) return;

      if (e.key === " " && !onControl) {
        e.preventDefault();
        s.toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        s.stepBy(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        s.stepBy(1);
      } else if (e.key === "Home") {
        e.preventDefault();
        s.restart();
      } else if (e.key === "End") {
        e.preventDefault();
        s.jumpToEnd();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
  useTransportKeys();

  useEffect(() => {
    void init();
    return () => disposeCampaignStore();
  }, [init]);

  return (
    <div className="flex h-dvh flex-col bg-ground">
      <a href="#main" className="skip-link">
        Skip to the campaign
      </a>
      <Header />

      {loadError ? (
        <div
          role="alert"
          className="no-print shrink-0 border-b border-refuted/40 bg-refuted/10 px-4 py-2"
        >
          <span className="num text-[0.8125rem] text-refuted">{loadError}</span>
        </div>
      ) : null}

      <main
        id="main"
        tabIndex={-1}
        className="instrument-grid min-h-0 flex-1 overflow-y-auto overflow-x-clip p-2.5 focus:outline-none"
      >
        <div className="mx-auto flex min-h-full max-w-[1800px] flex-col gap-2.5">
          <Timeline />

          {/* One column on a phone, two from `lg`, three from `xl`. The viewer
              column drops under the other two at `lg` and lays its own panels
              out side by side so it does not become one very long strip. */}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,21.5rem)_minmax(0,1.15fr)_minmax(0,1fr)]">
            {/* left rail: intake, cost. On a phone it follows the board, so the
                first screen is the hypothesis rather than the intake form. */}
            <div className="order-2 flex min-h-0 min-w-0 flex-col gap-2.5 lg:order-none">
              <GoalPanel />
              <LedgerPanel />
            </div>

            {/* centre: the money shot, then the evidence under it */}
            <div className="order-1 flex min-h-0 min-w-0 flex-col gap-2.5 lg:order-none">
              <div className="flex min-h-[16rem] flex-col xl:max-h-[52vh] [&>section]:flex-1">
                <HypothesisBoard />
              </div>
              <div className="flex min-h-[12rem] flex-col xl:max-h-[36vh] [&>section]:flex-1">
                <MeasurementsTable />
              </div>
              <ProposalPanel />
            </div>

            {/* right: what it is thinking and what it is looking at */}
            <div className="order-3 grid min-h-0 min-w-0 grid-cols-1 content-start gap-2.5 lg:order-none lg:col-span-2 lg:grid-cols-2 xl:col-span-1 xl:flex xl:flex-col">
              <div className="h-[clamp(20rem,44vh,27rem)] shrink-0 lg:row-span-2 lg:h-auto lg:min-h-[26rem] xl:h-[clamp(20rem,44vh,27rem)] xl:min-h-0">
                <ErrorBoundary label="viewer-host">
                  <Viewer />
                </ErrorBoundary>
              </div>
              <ParetoPanel />
              <div className="flex min-h-[18rem] flex-1 flex-col [&>section]:flex-1">
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
