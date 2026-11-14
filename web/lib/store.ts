"use client";

/**
 * Campaign store. Holds the raw event log and a cursor; everything the UI
 * draws is `stateAt(events, cursor)`. Because the UI is a pure function of the
 * log, scrubbing is just moving the cursor.
 */

import { create } from "zustand";
import type { Artifact, Event } from "@/lib/contracts";
import {
  EMPTY_STATE,
  type CampaignState,
  createSnapshotCache,
  stateAt,
} from "@/lib/campaign-state";
import {
  type CampaignSource,
  type CampaignSummary,
  PublicDemoError,
  type StreamHandle,
  detectSource,
  staticSource,
} from "@/lib/sources";
import type { ViewName } from "@/lib/views";

// --------------------------------------------------------------------------
// Pacing
// --------------------------------------------------------------------------

/**
 * Recorded timestamps are the baseline, but a real campaign emits whole
 * bursts at one instant: in the fixture, the refuted verdict, all four
 * notebook chunks, the pareto update and the proposal share a single `t`.
 * Replaying strictly by `t` would flash the whole conclusion in one frame, so
 * each event type gets a floor on how fast it may go by, and long real gaps
 * get capped so a replay never stalls.
 */
const MIN_GAP_MS: Record<string, number> = {
  "campaign.started": 500,
  "spec.created": 900,
  "round.started": 650,
  "hypothesis.proposed": 1100,
  "notebook.delta": 520,
  "candidates.generated": 800,
  "skeptic.reviewed": 850,
  "scoring.started": 260,
  "measurement.recorded": 190,
  "artifact.created": 120,
  "embedding.updated": 400,
  "pareto.updated": 700,
  "analyst.verdict": 1800,
  "controller.decision": 1100,
  "ledger.updated": 600,
  "proposal.created": 1400,
  "campaign.completed": 700,
  "campaign.error": 900,
};

const MAX_GAP_MS = 2600;

export function gapMs(prev: Event | undefined, next: Event): number {
  const floor = MIN_GAP_MS[next.body.type] ?? 300;
  const recorded = prev ? Math.max(0, (next.t - prev.t) * 1000) : 0;
  return Math.min(Math.max(recorded, floor), MAX_GAP_MS);
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

export type SourceStatus = "idle" | "detecting" | "ready" | "error";

export interface TourStep {
  /** index into the caption script */
  index: number;
  caption: string;
  title: string;
}

interface CampaignStore {
  source: CampaignSource | null;
  sourceStatus: SourceStatus;
  campaigns: CampaignSummary[];

  campaignId: string | null;
  events: Event[];
  cursor: number;
  state: CampaignState;
  loading: boolean;
  loadError: string | null;

  playing: boolean;
  speed: number;
  /** follow the stream tail (live/API mode) */
  follow: boolean;

  view: ViewName;
  selectedCandidateId: string | null;
  selectedHypothesisId: string | null;

  /** resolved artifact payloads, by artifact id */
  artifactPayloads: Record<string, unknown>;

  tour: boolean;
  tourStep: number;
  tourCaption: { title: string; body: string } | null;

  /** set when a live campaign was refused — the charming public-demo notice */
  publicDemoNotice: boolean;

  init: () => Promise<void>;
  loadCampaign: (id: string, opts?: { cursor?: number; play?: boolean }) => Promise<void>;
  setCursor: (cursor: number) => void;
  stepBy: (delta: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (speed: number) => void;
  restart: () => void;
  jumpToEnd: () => void;
  /** move the cursor to just after the first event matching a predicate */
  jumpToEvent: (match: (e: Event) => boolean) => boolean;
  setView: (view: ViewName) => void;
  selectCandidate: (id: string | null) => void;
  selectHypothesis: (id: string | null) => void;
  ensureArtifact: (artifact: Artifact) => void;
  requestCampaign: (goal: string) => Promise<void>;
  dismissNotice: () => void;
  setTour: (on: boolean) => void;
  setTourCaption: (c: { title: string; body: string } | null, step: number) => void;
}

const cache = createSnapshotCache(6);
let playTimer: ReturnType<typeof setTimeout> | null = null;
let stream: StreamHandle | null = null;
const inflightArtifacts = new Set<string>();

function clearTimer() {
  if (playTimer !== null) {
    clearTimeout(playTimer);
    playTimer = null;
  }
}

export const useCampaign = create<CampaignStore>((set, get) => {
  /** schedule the next event, honouring the pacing floors */
  function schedule() {
    clearTimer();
    const { playing, events, cursor, speed } = get();
    if (!playing) return;
    if (cursor >= events.length) {
      // in API mode new events may still arrive; keep waiting
      if (get().source?.kind === "api" && !get().state.completed) {
        playTimer = setTimeout(schedule, 200);
      } else {
        set({ playing: false });
      }
      return;
    }
    const next = events[cursor];
    const prev = cursor > 0 ? events[cursor - 1] : undefined;
    const delay = gapMs(prev, next) / Math.max(0.1, speed);
    playTimer = setTimeout(() => {
      const s = get();
      if (!s.playing) return;
      const c = Math.min(s.cursor + 1, s.events.length);
      set({ cursor: c, state: stateAt(s.events, c, cache) });
      schedule();
    }, delay);
  }

  return {
    source: null,
    sourceStatus: "idle",
    campaigns: [],
    campaignId: null,
    events: [],
    cursor: 0,
    state: EMPTY_STATE,
    loading: false,
    loadError: null,
    playing: false,
    speed: 1,
    follow: true,
    view: "structure",
    selectedCandidateId: null,
    selectedHypothesisId: null,
    artifactPayloads: {},
    tour: false,
    tourStep: -1,
    tourCaption: null,
    publicDemoNotice: false,

    async init() {
      if (get().sourceStatus !== "idle") return;
      set({ sourceStatus: "detecting" });
      const source = await detectSource();
      let campaigns: CampaignSummary[] = [];
      try {
        campaigns = await source.listCampaigns();
      } catch {
        // an API that answered /api/campaigns but then failed: fall back
        const fallback = staticSource();
        try {
          campaigns = await fallback.listCampaigns();
          set({ source: fallback, sourceStatus: "ready", campaigns });
          return;
        } catch {
          set({ sourceStatus: "error", loadError: "no campaigns available" });
          return;
        }
      }
      set({ source, sourceStatus: "ready", campaigns });
    },

    async loadCampaign(id, opts) {
      clearTimer();
      stream?.close();
      stream = null;
      const source = get().source ?? staticSource();
      set({
        campaignId: id,
        loading: true,
        loadError: null,
        events: [],
        cursor: 0,
        state: EMPTY_STATE,
        playing: false,
        artifactPayloads: {},
        selectedCandidateId: null,
        selectedHypothesisId: null,
      });
      try {
        const log = await source.fetchLog(id);
        if (log) {
          const cursor =
            opts?.cursor === undefined
              ? 0
              : Math.max(0, Math.min(opts.cursor, log.length));
          set({
            events: log,
            cursor,
            state: stateAt(log, cursor, cache),
            loading: false,
          });
          if (opts?.play) {
            set({ playing: true });
            schedule();
          }
        } else if (source.subscribe) {
          // server-paced stream: append and follow the tail
          set({ loading: false });
          stream = source.subscribe(id, {
            onEvent: (event) => {
              const s = get();
              if (s.events.some((e) => e.seq === event.seq)) return;
              const events = [...s.events, event];
              const cursor = s.follow ? events.length : s.cursor;
              set({ events, cursor, state: stateAt(events, cursor, cache) });
            },
            onError: (message) => set({ loadError: message }),
          });
        } else {
          set({ loading: false, loadError: "this source cannot read campaigns" });
        }
      } catch (err) {
        set({
          loading: false,
          loadError: err instanceof Error ? err.message : "failed to load campaign",
        });
      }
    },

    setCursor(cursor) {
      const { events } = get();
      const c = Math.max(0, Math.min(Math.round(cursor), events.length));
      set({ cursor: c, state: stateAt(events, c, cache), follow: c >= events.length });
    },

    stepBy(delta) {
      get().setCursor(get().cursor + delta);
      if (get().playing) {
        set({ playing: false });
        clearTimer();
      }
    },

    play() {
      const { events, cursor } = get();
      if (events.length === 0) return;
      if (cursor >= events.length) {
        set({ cursor: 0, state: EMPTY_STATE });
      }
      set({ playing: true });
      schedule();
    },

    pause() {
      clearTimer();
      set({ playing: false });
    },

    toggle() {
      if (get().playing) get().pause();
      else get().play();
    },

    setSpeed(speed) {
      set({ speed });
      if (get().playing) schedule();
    },

    restart() {
      clearTimer();
      set({ cursor: 0, state: EMPTY_STATE, playing: true });
      schedule();
    },

    jumpToEnd() {
      const { events } = get();
      clearTimer();
      set({
        playing: false,
        cursor: events.length,
        state: stateAt(events, events.length, cache),
        follow: true,
      });
    },

    jumpToEvent(match) {
      const { events } = get();
      const i = events.findIndex(match);
      if (i < 0) return false;
      get().setCursor(i + 1);
      return true;
    },

    setView(view) {
      set({ view });
    },

    selectCandidate(id) {
      set({ selectedCandidateId: id });
    },

    selectHypothesis(id) {
      set({ selectedHypothesisId: id });
    },

    ensureArtifact(artifact) {
      const { artifactPayloads, source, campaignId } = get();
      if (artifact.id in artifactPayloads) return;
      if (inflightArtifacts.has(artifact.id)) return;
      if (!campaignId) return;
      const src = source ?? staticSource();
      inflightArtifacts.add(artifact.id);
      src
        .loadArtifact(campaignId, artifact)
        .then((payload) => {
          set((s) => ({
            artifactPayloads: { ...s.artifactPayloads, [artifact.id]: payload },
          }));
        })
        .catch(() => {
          // a missing artifact must never blank the scene
          set((s) => ({
            artifactPayloads: { ...s.artifactPayloads, [artifact.id]: null },
          }));
        })
        .finally(() => inflightArtifacts.delete(artifact.id));
    },

    async requestCampaign(goal) {
      const source = get().source ?? staticSource();
      try {
        const { campaign_id } = await source.startCampaign(goal);
        await get().loadCampaign(campaign_id, { play: true });
      } catch (err) {
        if (err instanceof PublicDemoError) {
          set({ publicDemoNotice: true });
        } else {
          // no API, 404 or HTML from a static host: same deliberate answer
          set({ publicDemoNotice: true });
        }
      }
    },

    dismissNotice() {
      set({ publicDemoNotice: false });
    },

    setTour(on) {
      set({ tour: on, tourStep: on ? 0 : -1, tourCaption: on ? get().tourCaption : null });
    },

    setTourCaption(c, step) {
      set({ tourCaption: c, tourStep: step });
    },
  };
});

/** Teardown for hot reloads and route changes. */
export function disposeCampaignStore() {
  clearTimer();
  stream?.close();
  stream = null;
}
