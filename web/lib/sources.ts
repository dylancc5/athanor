/**
 * Data layer. Two interchangeable sources behind one interface:
 *
 *  - `apiSource`    — FastAPI backend on :8000 (SSE replay / live stream)
 *  - `staticSource` — JSON files under `/campaigns/<id>/`, paced client-side
 *
 * The static source is what ships on the public demo, so it is the default
 * whenever the API does not answer. Nothing above this module knows which
 * one it got, except for `source.kind` (which the UI shows, honestly).
 */

import type { Artifact, Event } from "@/lib/contracts";

export const API_BASE =
  process.env.NEXT_PUBLIC_ATHANOR_API ?? "http://localhost:8000";

export interface CampaignSummary {
  id: string;
  title: string;
  goal: string;
  domain: string | null;
  /** events in the recorded log, when known */
  n_events?: number;
}

export interface StreamHandlers {
  onEvent: (event: Event) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export interface StreamHandle {
  close: () => void;
}

export interface CampaignSource {
  kind: "api" | "static";
  /** short human label for the status bar */
  label: string;
  listCampaigns: () => Promise<CampaignSummary[]>;
  /** Whole recorded log at once, or null when it can only be streamed. */
  fetchLog: (campaignId: string) => Promise<Event[] | null>;
  /** Server-paced replay of a recorded campaign, or null when unsupported. */
  subscribe: ((campaignId: string, h: StreamHandlers) => StreamHandle) | null;
  /** Live stream of a campaign that is running right now. */
  subscribeLive: ((campaignId: string, h: StreamHandlers) => StreamHandle) | null;
  loadArtifact: (campaignId: string, artifact: Artifact) => Promise<unknown>;
  /** POST a new campaign. Rejects with `PublicDemoError` on the public build. */
  startCampaign: (goal: string) => Promise<{ campaign_id: string }>;
}

export class PublicDemoError extends Error {
  constructor() {
    super("public-demo");
    this.name = "PublicDemoError";
  }
}

// --------------------------------------------------------------------------
// Shared parsing
// --------------------------------------------------------------------------

export function parseJsonl(text: string): Event[] {
  const out: Event[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Event);
    } catch {
      // a half-written final line in a live recording — skip it
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** Campaigns shipped with the static build. Kept as a fallback for when
 *  `/campaigns/index.json` is missing. */
export const FALLBACK_CAMPAIGNS: CampaignSummary[] = [
  {
    id: "fixture",
    title: "Solid-state Li conductor",
    goal:
      "Find a solid-state lithium electrolyte with a low Li migration barrier that stays stable against a lithium metal anode.",
    domain: "solid_electrolyte",
  },
  {
    id: "fixture-neb",
    title: "Solid-state Li conductor (NEB barriers)",
    goal:
      "Find a solid-state lithium electrolyte with a low Li migration barrier that stays stable against a lithium metal anode.",
    domain: "solid_electrolyte",
  },
];

// --------------------------------------------------------------------------
// Static source
// --------------------------------------------------------------------------

export function staticSource(): CampaignSource {
  return {
    kind: "static",
    label: "static replay",
    async listCampaigns() {
      try {
        const res = await fetch("/campaigns/index.json", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as unknown;
          const list = Array.isArray(data)
            ? data
            : (data as { campaigns?: unknown }).campaigns;
          if (Array.isArray(list) && list.length > 0) {
            return list as CampaignSummary[];
          }
        }
      } catch {
        // fall through
      }
      return FALLBACK_CAMPAIGNS;
    },
    async fetchLog(campaignId) {
      const res = await fetch(`/campaigns/${campaignId}/events.jsonl`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`campaign "${campaignId}" not found`);
      return parseJsonl(await res.text());
    },
    subscribe: null,
    subscribeLive: null,
    async loadArtifact(campaignId, artifact) {
      const res = await fetch(`/campaigns/${campaignId}/${artifact.uri}`, {
        cache: "force-cache",
      });
      if (!res.ok) throw new Error(`artifact ${artifact.id} not found`);
      return res.json();
    },
    async startCampaign() {
      throw new PublicDemoError();
    },
  };
}

// --------------------------------------------------------------------------
// API source
// --------------------------------------------------------------------------

/** SSE frames are `event: athanor`, so a named listener is required —
 *  `onmessage` never fires for them. */
function sseSubscribe(url: string, h: StreamHandlers): StreamHandle {
  const es = new EventSource(url);
  // EventSource auto-reconnects and the server replays from the start, so
  // dedupe on seq rather than trusting arrival order.
  let lastSeq = -1;
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      es.close();
    }
  };
  es.addEventListener("athanor", (ev) => {
    const payload = (ev as MessageEvent).data;
    let event: Event;
    try {
      event = JSON.parse(payload) as Event;
    } catch {
      return;
    }
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    h.onEvent(event);
    const type = event.body.type;
    if (type === "campaign.completed") {
      close();
      h.onDone?.();
    } else if (type === "campaign.error" && event.body.fatal) {
      close();
      h.onError?.(event.body.message);
    }
  });
  es.addEventListener("error", () => {
    if (es.readyState === EventSource.CLOSED) {
      close();
      h.onDone?.();
    }
  });
  return { close };
}

export function apiSource(base = API_BASE): CampaignSource {
  return {
    kind: "api",
    label: "live backend",
    async listCampaigns() {
      const res = await fetch(`${base}/api/campaigns`, { cache: "no-store" });
      if (!res.ok) throw new Error("api unavailable");
      const data = (await res.json()) as unknown;
      const list = Array.isArray(data)
        ? data
        : (data as { campaigns?: unknown }).campaigns;
      if (!Array.isArray(list)) throw new Error("api returned no campaign list");
      return list as CampaignSummary[];
    },
    async fetchLog() {
      // The API streams; the store follows the stream tail instead.
      return null;
    },
    subscribe(campaignId, h) {
      return sseSubscribe(
        `${base}/api/replay/${encodeURIComponent(campaignId)}?speed=1.0`,
        h,
      );
    },
    subscribeLive(campaignId, h) {
      return sseSubscribe(
        `${base}/api/campaigns/${encodeURIComponent(campaignId)}/events`,
        h,
      );
    },
    async loadArtifact(campaignId, artifact) {
      const res = await fetch(
        `${base}/api/campaigns/${encodeURIComponent(campaignId)}/artifacts/${encodeURIComponent(artifact.id)}`,
      );
      if (!res.ok) throw new Error(`artifact ${artifact.id} not found`);
      return res.json();
    },
    async startCampaign(goal) {
      const res = await fetch(`${base}/api/campaigns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      if (res.status === 403) throw new PublicDemoError();
      if (!res.ok) throw new Error(`campaign refused (${res.status})`);
      return (await res.json()) as { campaign_id: string };
    },
  };
}

// --------------------------------------------------------------------------
// Auto-detection
// --------------------------------------------------------------------------

/**
 * Should we even look for a backend? On the public deployment there is none,
 * and a https page requesting http://localhost:8000 can trip Chrome's
 * local-network-access prompt — which judges would see. So probe only when an
 * API base was configured explicitly, or when we are running on localhost.
 */
export function shouldProbeApi(): boolean {
  if (process.env.NEXT_PUBLIC_ATHANOR_API) return true;
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Try the API with a short timeout; fall back to static on anything odd.
 * On a static host a same-origin `/api/...` can return the 404 HTML page, so
 * a successful parse is required, not just a 200.
 */
export async function detectSource(timeoutMs = 1500): Promise<CampaignSource> {
  if (!shouldProbeApi()) return staticSource();
  const api = apiSource();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/campaigns`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error("not ok");
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) throw new Error("not json");
    const data = (await res.json()) as unknown;
    const list = Array.isArray(data)
      ? data
      : (data as { campaigns?: unknown }).campaigns;
    if (!Array.isArray(list)) throw new Error("no list");
    return api;
  } catch {
    return staticSource();
  } finally {
    clearTimeout(timer);
  }
}
