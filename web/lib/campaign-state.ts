/**
 * Pure event reducer. The UI is a pure function of the campaign event log.
 *
 * Rules this file lives by:
 *  - no mutation of the incoming state (snapshots share structure)
 *  - plain objects/arrays only, never Map/Set (so states are JSON-comparable)
 *  - no imports beyond types, so it runs under plain node for tests
 */

import type {
  Artifact,
  Candidate,
  Event,
  Heuristic,
  Hypothesis,
  Ledger,
  Measurement,
  ParetoPoint,
  Proposal,
  Spec,
  Veto,
} from "@/lib/contracts";

export type Verdict = "SUPPORTED" | "REFUTED" | "INCONCLUSIVE";
export type HypothesisStatus = "OPEN" | Verdict;
export type NotebookAuthor =
  | "strategist"
  | "skeptic"
  | "analyst"
  | "controller"
  | "system";

export interface HypothesisRecord {
  hypothesis: Hypothesis;
  status: HypothesisStatus;
  /** seq of the event that proposed it */
  proposedAt: number;
  /** seq of the verdict event, null while OPEN */
  decidedAt: number | null;
  verdictReasoning: string | null;
  evidence: string[];
  heuristics: Heuristic[];
  candidateIds: string[];
  approvedIds: string[];
  vetoes: Veto[];
  skepticCommentary: string | null;
}

export interface NotebookEntry {
  entryId: string;
  author: NotebookAuthor;
  heading: string | null;
  text: string;
  /** seq of the first chunk — stable ordering key */
  startedAt: number;
  /** seq of the most recent chunk */
  updatedAt: number;
  chunks: number;
}

export interface ScoringRun {
  candidateId: string;
  scorer: string;
  startedAt: number;
  done: boolean;
}

export interface CampaignState {
  campaignId: string | null;
  goal: string | null;
  recorded: boolean;
  spec: Spec | null;
  round: number;
  rounds: number[];
  /** ordered hypothesis ids */
  hypothesisIds: string[];
  hypotheses: Record<string, HypothesisRecord>;
  /** ordered candidate ids */
  candidateIds: string[];
  candidates: Record<string, Candidate>;
  /** candidate_id -> property -> measurement (last write wins) */
  measurements: Record<string, Record<string, Measurement>>;
  /** flat log of measurements in arrival order */
  measurementLog: Measurement[];
  vetoes: Veto[];
  /** candidate ids vetoed, for quick lookup */
  vetoedIds: string[];
  pareto: ParetoPoint[];
  embedding: Record<string, [number, number, number]>;
  notebookOrder: string[];
  notebook: Record<string, NotebookEntry>;
  heuristics: Heuristic[];
  /** ordered artifact ids */
  artifactIds: string[];
  artifacts: Record<string, Artifact>;
  /** candidate_id -> artifact ids */
  artifactsByCandidate: Record<string, string[]>;
  ledger: Ledger | null;
  proposal: Proposal | null;
  scoring: ScoringRun[];
  decisions: {
    seq: number;
    action: "continue" | "pivot" | "branch" | "converge";
    reasoning: string;
    branches: string[];
  }[];
  errors: { seq: number; stage: string; message: string; fatal: boolean }[];
  completed: boolean;
  /** seq of the last event folded in, -1 for the empty state */
  lastSeq: number;
  /** t of the last event folded in */
  lastT: number;
  eventCount: number;
}

export const EMPTY_STATE: CampaignState = {
  campaignId: null,
  goal: null,
  recorded: false,
  spec: null,
  round: 0,
  rounds: [],
  hypothesisIds: [],
  hypotheses: {},
  candidateIds: [],
  candidates: {},
  measurements: {},
  measurementLog: [],
  vetoes: [],
  vetoedIds: [],
  pareto: [],
  embedding: {},
  notebookOrder: [],
  notebook: {},
  heuristics: [],
  artifactIds: [],
  artifacts: {},
  artifactsByCandidate: {},
  ledger: null,
  proposal: null,
  scoring: [],
  decisions: [],
  errors: [],
  completed: false,
  lastSeq: -1,
  lastT: 0,
  eventCount: 0,
};

export function emptyState(): CampaignState {
  return EMPTY_STATE;
}

/** Fold one event into the state. Pure: never mutates `state`. */
export function reduceEvent(state: CampaignState, event: Event): CampaignState {
  const base: CampaignState = {
    ...state,
    campaignId: state.campaignId ?? event.campaign_id,
    lastSeq: event.seq,
    lastT: event.t,
    eventCount: state.eventCount + 1,
  };
  const body = event.body;

  switch (body.type) {
    case "campaign.started":
      return { ...base, goal: body.goal, recorded: body.recorded ?? false };

    case "spec.created":
      return { ...base, spec: body.spec };

    case "round.started":
      return {
        ...base,
        round: body.round,
        rounds: base.rounds.includes(body.round)
          ? base.rounds
          : [...base.rounds, body.round],
      };

    case "hypothesis.proposed": {
      const h = body.hypothesis;
      const record: HypothesisRecord = {
        hypothesis: h,
        status: "OPEN",
        proposedAt: event.seq,
        decidedAt: null,
        verdictReasoning: null,
        evidence: [],
        heuristics: [],
        candidateIds: [],
        approvedIds: [],
        vetoes: [],
        skepticCommentary: null,
      };
      return {
        ...base,
        hypothesisIds: base.hypothesisIds.includes(h.id)
          ? base.hypothesisIds
          : [...base.hypothesisIds, h.id],
        hypotheses: { ...base.hypotheses, [h.id]: record },
      };
    }

    case "candidates.generated": {
      const candidates = { ...base.candidates };
      const ids = [...base.candidateIds];
      for (const c of body.candidates) {
        if (!(c.id in candidates)) ids.push(c.id);
        candidates[c.id] = c;
      }
      const hyp = base.hypotheses[body.hypothesis_id];
      const hypotheses = hyp
        ? {
            ...base.hypotheses,
            [body.hypothesis_id]: {
              ...hyp,
              candidateIds: dedupe([
                ...hyp.candidateIds,
                ...body.candidates.map((c) => c.id),
              ]),
            },
          }
        : base.hypotheses;
      return { ...base, candidates, candidateIds: ids, hypotheses };
    }

    case "skeptic.reviewed": {
      const hyp = base.hypotheses[body.hypothesis_id];
      const hypotheses = hyp
        ? {
            ...base.hypotheses,
            [body.hypothesis_id]: {
              ...hyp,
              approvedIds: body.approved_ids,
              vetoes: body.vetoes,
              skepticCommentary: body.commentary,
            },
          }
        : base.hypotheses;
      return {
        ...base,
        hypotheses,
        vetoes: [...base.vetoes, ...body.vetoes],
        vetoedIds: dedupe([
          ...base.vetoedIds,
          ...body.vetoes.map((v) => v.candidate_id),
        ]),
      };
    }

    case "scoring.started":
      return {
        ...base,
        scoring: [
          ...base.scoring.filter((s) => s.candidateId !== body.candidate_id),
          {
            candidateId: body.candidate_id,
            scorer: body.scorer,
            startedAt: event.seq,
            done: false,
          },
        ],
      };

    case "measurement.recorded": {
      const m = body.measurement;
      const forCandidate = base.measurements[m.candidate_id] ?? {};
      return {
        ...base,
        measurements: {
          ...base.measurements,
          [m.candidate_id]: { ...forCandidate, [m.property]: m },
        },
        measurementLog: [...base.measurementLog, m],
        scoring: base.scoring.map((s) =>
          s.candidateId === m.candidate_id ? { ...s, done: true } : s,
        ),
      };
    }

    case "artifact.created": {
      const a = body.artifact;
      const byCandidate = base.artifactsByCandidate[a.candidate_id] ?? [];
      return {
        ...base,
        artifactIds: base.artifactIds.includes(a.id)
          ? base.artifactIds
          : [...base.artifactIds, a.id],
        artifacts: { ...base.artifacts, [a.id]: a },
        artifactsByCandidate: {
          ...base.artifactsByCandidate,
          [a.candidate_id]: dedupe([...byCandidate, a.id]),
        },
      };
    }

    case "embedding.updated": {
      const points: Record<string, [number, number, number]> = {
        ...base.embedding,
      };
      for (const [id, xyz] of Object.entries(
        body.points as unknown as Record<string, [number, number, number]>,
      )) {
        points[id] = xyz;
      }
      return { ...base, embedding: points };
    }

    case "pareto.updated":
      return { ...base, pareto: body.points };

    case "analyst.verdict": {
      const hyp = base.hypotheses[body.hypothesis_id];
      const hypotheses = hyp
        ? {
            ...base.hypotheses,
            [body.hypothesis_id]: {
              ...hyp,
              status: body.verdict,
              decidedAt: event.seq,
              verdictReasoning: body.reasoning,
              evidence: body.evidence,
              heuristics: body.heuristics,
            },
          }
        : base.hypotheses;
      const known = base.heuristics.map((h) => h.id);
      return {
        ...base,
        hypotheses,
        heuristics: [
          ...base.heuristics,
          ...body.heuristics.filter((h) => !known.includes(h.id)),
        ],
      };
    }

    case "notebook.delta": {
      const prev = base.notebook[body.entry_id];
      const entry: NotebookEntry = prev
        ? {
            ...prev,
            // the first non-null heading wins; later chunks carry null
            heading: prev.heading ?? body.heading ?? null,
            text: prev.text + body.text,
            updatedAt: event.seq,
            chunks: prev.chunks + 1,
          }
        : {
            entryId: body.entry_id,
            author: body.author,
            heading: body.heading ?? null,
            text: body.text,
            startedAt: event.seq,
            updatedAt: event.seq,
            chunks: 1,
          };
      return {
        ...base,
        notebookOrder: prev
          ? base.notebookOrder
          : [...base.notebookOrder, body.entry_id],
        notebook: { ...base.notebook, [body.entry_id]: entry },
      };
    }

    case "controller.decision":
      return {
        ...base,
        decisions: [
          ...base.decisions,
          {
            seq: event.seq,
            action: body.action,
            reasoning: body.reasoning,
            branches: body.branches ?? [],
          },
        ],
      };

    case "ledger.updated":
      return { ...base, ledger: body.ledger };

    case "proposal.created":
      return { ...base, proposal: body.proposal };

    case "campaign.completed":
      return { ...base, completed: true, round: Math.max(base.round, body.rounds) };

    case "campaign.error":
      return {
        ...base,
        errors: [
          ...base.errors,
          {
            seq: event.seq,
            stage: body.stage,
            message: body.message,
            fatal: body.fatal,
          },
        ],
      };

    default:
      return base;
  }
}

/** Fold a whole log, or a prefix of it, always starting from the empty state. */
export function reduceEvents(
  events: readonly Event[],
  upToExclusive = events.length,
): CampaignState {
  return foldRange(events, 0, upToExclusive, EMPTY_STATE);
}

/**
 * Fold `events[start..end)` onto `from`. The explicit range is what makes
 * keyframe seeking possible — `from` must already account for `events[0..start)`.
 */
export function foldRange(
  events: readonly Event[],
  start: number,
  end: number,
  from: CampaignState,
): CampaignState {
  let s = from;
  const stop = Math.min(end, events.length);
  for (let i = Math.max(0, start); i < stop; i++) s = reduceEvent(s, events[i]);
  return s;
}

// --------------------------------------------------------------------------
// Snapshot cache — makes scrubbing cheap in both directions
// --------------------------------------------------------------------------

export interface SnapshotCache {
  /** states at indices 0, stride, 2*stride, ... (index = events consumed) */
  keyframes: CampaignState[];
  stride: number;
  /** identity of the log the cache was built against */
  token: unknown;
}

export function createSnapshotCache(stride = 8): SnapshotCache {
  return { keyframes: [EMPTY_STATE], stride, token: null };
}

/**
 * State after consuming `count` events (so `count` is a count, not an index).
 * Uses/extends the keyframe cache. Pure with respect to the returned state;
 * the cache is a memo and is reset when the log identity changes.
 */
export function stateAt(
  events: readonly Event[],
  count: number,
  cache?: SnapshotCache,
): CampaignState {
  const n = Math.max(0, Math.min(count, events.length));
  if (!cache) return reduceEvents(events, n);

  if (cache.token !== events) {
    cache.token = events;
    cache.keyframes = [EMPTY_STATE];
  }

  const { stride } = cache;
  const wantKf = Math.floor(n / stride);
  // extend keyframes up to the one we need
  while (cache.keyframes.length <= wantKf) {
    const have = cache.keyframes.length - 1; // last keyframe index
    const from = cache.keyframes[have];
    const start = have * stride;
    let s = from;
    for (let i = start; i < start + stride && i < events.length; i++) {
      s = reduceEvent(s, events[i]);
    }
    cache.keyframes.push(s);
    if (start + stride >= events.length) break;
  }
  const kf = Math.min(wantKf, cache.keyframes.length - 1);
  return foldRange(events, kf * stride, n, cache.keyframes[kf]);
}

// --------------------------------------------------------------------------
// Derived selectors (pure, used by panels)
// --------------------------------------------------------------------------

function dedupe(xs: string[]): string[] {
  const out: string[] = [];
  for (const x of xs) if (!out.includes(x)) out.push(x);
  return out;
}

export function hypothesisList(state: CampaignState): HypothesisRecord[] {
  return state.hypothesisIds
    .map((id) => state.hypotheses[id])
    .filter((h): h is HypothesisRecord => Boolean(h));
}

export function verdictCounts(state: CampaignState): Record<HypothesisStatus, number> {
  const counts: Record<HypothesisStatus, number> = {
    OPEN: 0,
    SUPPORTED: 0,
    REFUTED: 0,
    INCONCLUSIVE: 0,
  };
  for (const h of hypothesisList(state)) counts[h.status] += 1;
  return counts;
}

export function notebookEntries(state: CampaignState): NotebookEntry[] {
  return state.notebookOrder
    .map((id) => state.notebook[id])
    .filter((e): e is NotebookEntry => Boolean(e));
}

/** Every property that has at least one measurement, objectives first. */
export function measuredProperties(state: CampaignState): string[] {
  const fromSpec = (state.spec?.objectives ?? []).map((o) => o.property);
  const seen: string[] = [];
  for (const m of state.measurementLog) if (!seen.includes(m.property)) seen.push(m.property);
  return dedupe([...fromSpec.filter((p) => seen.includes(p)), ...seen]);
}

export function paretoRankMap(state: CampaignState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of state.pareto) out[p.candidate_id] = p.rank;
  return out;
}

export function candidateLabels(state: CampaignState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of state.candidateIds) out[id] = state.candidates[id]?.name ?? id;
  return out;
}

export function latestArtifactOfKind(
  state: CampaignState,
  kind: Artifact["kind"],
  candidateId?: string | null,
): Artifact | null {
  for (let i = state.artifactIds.length - 1; i >= 0; i--) {
    const a = state.artifacts[state.artifactIds[i]];
    if (!a || a.kind !== kind) continue;
    if (candidateId && a.candidate_id !== candidateId) continue;
    return a;
  }
  return null;
}
