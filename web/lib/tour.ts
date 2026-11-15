/**
 * Guided tour script (`?tour=1`).
 *
 * Beats are keyed on event *types* and on derived state, never on seq numbers
 * or literal measured values — the campaigns get re-recorded and both of those
 * change. Every caption interpolates from the state it is describing, so the
 * narration cannot drift out of sync with what is on screen.
 */

import type { Event } from "@/lib/contracts";
import type { CampaignState } from "@/lib/campaign-state";
import { hypothesisList } from "@/lib/campaign-state";
import { fmtCpuHours, fmtDuration } from "@/lib/format";
import type { ViewName } from "@/lib/views";

export interface TourBeat {
  id: string;
  /** fires the first time the event just consumed matches */
  match: (event: Event, state: CampaignState) => boolean;
  title: string;
  body: (state: CampaignState, event: Event) => string;
  /** switch the 3D viewer to this view when the beat fires */
  view?: ViewName;
  /** scroll this panel into view */
  focus?: string;
  /** hold the replay here so the viewer can read and look */
  dwellMs: number;
}

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?]*[.!?]/);
  return (m ? m[0] : text).trim();
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const TOUR: TourBeat[] = [
  {
    id: "goal",
    match: (e) => e.body.type === "campaign.started",
    title: "A goal, in one sentence",
    body: (s) =>
      `A researcher states what they want found in plain language: "${s.goal ?? ""}" Nothing else is specified — not the candidates, not the properties, not how many rounds it will take.`,
    focus: "panel-goal",
    dwellMs: 6500,
  },
  {
    id: "spec",
    match: (e) => e.body.type === "spec.created",
    title: "The goal becomes a measurable spec",
    body: (s) => {
      const objectives = s.spec?.objectives ?? [];
      const described = objectives
        .map(
          (o) =>
            `${o.direction === "min" ? "minimize" : o.direction === "max" ? "maximize" : "hit"} ${o.label.toLowerCase()} (${o.unit})`,
        )
        .join(", ");
      const constraints = s.spec?.constraints?.length ?? 0;
      return `The sentence is parsed into ${plural(objectives.length, "objective")} with real units and directions — ${described} — plus ${plural(constraints, "hard constraint")}. From here on the system is optimizing something specific enough to be wrong about.`;
    },
    focus: "panel-goal",
    dwellMs: 8000,
  },
  {
    id: "hypothesis",
    match: (e) => e.body.type === "hypothesis.proposed",
    title: "A falsifiable claim, not a search",
    body: (s) => {
      const h = hypothesisList(s).at(-1);
      if (!h) return "";
      return `The strategist commits to a claim before seeing any data: "${h.hypothesis.statement}" It states in advance what would kill it — ${h.hypothesis.falsification_criterion.replace(/^If /, "if ")} That criterion is the whole point: it is written down before the numbers arrive, so it cannot be softened afterwards.`;
    },
    view: "tree",
    focus: "panel-hypotheses",
    dwellMs: 11000,
  },
  {
    id: "skeptic",
    match: (e) => e.body.type === "skeptic.reviewed",
    title: "A skeptic screens the batch first",
    body: (s, e) => {
      if (e.body.type !== "skeptic.reviewed") return "";
      const vetoed = e.body.vetoes.length;
      const approved = e.body.approved_ids.length;
      const base = `A separate agent reviews every candidate before any compute is spent, and rejects what is out of distribution, implausible or unsynthesizable. ${plural(approved, "candidate")} approved, ${vetoed} vetoed.`;
      return `${base} ${firstSentence(e.body.commentary)}`;
    },
    focus: "panel-measurements",
    dwellMs: 8500,
  },
  {
    id: "measurements",
    match: (e, s) => e.body.type === "measurement.recorded" && s.measurementLog.length >= 3,
    title: "Numbers from physics, with their limits attached",
    body: (s) => {
      const ood = s.measurementLog.filter((m) => m.ood_flag).length;
      const proxy = s.measurementLog.filter((m) => m.is_proxy).length;
      const computed = [
        ...new Set(
          s.measurementLog
            .filter((m) => m.source !== "materials_project")
            .map((m) => m.source),
        ),
      ];
      const retrieved = [
        ...new Set(
          s.measurementLog
            .filter((m) => m.source === "materials_project")
            .map((m) => m.source),
        ),
      ];
      const where = retrieved.length
        ? `computed here by ${computed.join(", ")}, and retrieved from ${retrieved.join(", ")} where a value already exists`
        : `computed here by ${computed.join(", ")}`;
      return `Candidates are scored against physics — ${where} — rather than guessed at by a language model. Every value carries a confidence, the method behind it, and a flag when it is a proxy or an extrapolation: ${proxy} proxy and ${ood} out-of-distribution so far. The flags stay visible, because a screen that hides its own weak numbers cannot be checked.`;
    },
    focus: "panel-measurements",
    dwellMs: 10000,
  },
  {
    id: "structure",
    match: (e) =>
      e.body.type === "artifact.created" &&
      e.body.artifact.kind === "relaxation_trajectory",
    title: "Every number traces back to a structure",
    body: (s, e) => {
      if (e.body.type !== "artifact.created") return "";
      const name = s.candidates[e.body.artifact.candidate_id]?.name ?? "the candidate";
      return `This is ${name} as the model actually relaxed it — the same atoms the energy was computed from. The campaign keeps the trajectory, so a claim can always be followed back to the geometry behind it.`;
    },
    view: "structure",
    focus: "panel-viewer",
    dwellMs: 7500,
  },
  {
    id: "neb",
    match: (e) => e.body.type === "artifact.created" && e.body.artifact.kind === "neb_path",
    title: "The lithium hop itself",
    body: () =>
      "The migration barrier is not a lookup — it is the energy along this path, with one ion pushed through the lattice frame by frame. The highlighted atom traces the hop it has to make for the material to conduct.",
    view: "trajectory",
    focus: "panel-viewer",
    dwellMs: 8500,
  },
  {
    id: "pareto",
    match: (e) => e.body.type === "pareto.updated",
    title: "No single best answer, so a frontier",
    body: (s, e) => {
      if (e.body.type !== "pareto.updated") return "";
      const frontier = e.body.points.filter((p) => p.rank === 0).length;
      const objectives = (s.spec?.objectives ?? []).map((o) => o.label.toLowerCase());
      return `The objectives trade against each other — ${objectives.join(" against ")} — so there is no single winner. ${plural(frontier, "candidate")} sit on the Pareto frontier: each is the best available at something, and none of them dominates the others.`;
    },
    view: "pareto",
    focus: "panel-pareto",
    dwellMs: 9000,
  },
  {
    id: "verdict",
    match: (e) => e.body.type === "analyst.verdict",
    title: "The system refutes its own idea",
    body: (s, e) => {
      if (e.body.type !== "analyst.verdict") return "";
      const h = s.hypotheses[e.body.hypothesis_id];
      const statement = h ? h.hypothesis.statement : "the hypothesis";
      if (e.body.verdict === "REFUTED") {
        return `This is the moment that matters. The analyst holds the hypothesis to the criterion written down before the data existed, and it fails: "${statement}" — refuted. ${firstSentence(e.body.reasoning)} The card goes dark but stays readable, evidence attached, because a refuted claim is a result, not an error. A system that only ever confirmed itself would tell you nothing.`;
      }
      return `The analyst applies the criterion that was fixed in advance. Verdict: ${e.body.verdict.toLowerCase()}. ${firstSentence(e.body.reasoning)}`;
    },
    view: "tree",
    focus: "panel-hypotheses",
    dwellMs: 15000,
  },
  {
    id: "heuristics",
    match: (e, s) => e.body.type === "analyst.verdict" && s.heuristics.length > 0,
    title: "And gets smarter because of it",
    body: (s) => {
      const learned = s.heuristics.at(-1);
      return `Being wrong is converted into something reusable. ${plural(s.heuristics.length, "heuristic")} written back into the notebook, carried into every later round${learned ? `: "${learned.text}"` : ""} The next hypothesis is not allowed to repeat this mistake.`;
    },
    focus: "panel-notebook",
    dwellMs: 11000,
  },
  {
    id: "controller",
    match: (e) => e.body.type === "controller.decision",
    title: "The campaign decides what to do next",
    body: (s, e) => {
      if (e.body.type !== "controller.decision") return "";
      return `A controller decides where the campaign goes next — continue, pivot, branch or converge — and it chose to ${e.body.action}. ${firstSentence(e.body.reasoning)}`;
    },
    focus: "panel-notebook",
    dwellMs: 8500,
  },
  {
    id: "ledger",
    match: (e) => e.body.type === "ledger.updated",
    title: "What it cost, and what it would have cost",
    body: (s, e) => {
      if (e.body.type !== "ledger.updated") return "";
      const l = e.body.ledger;
      const dft = l.est_dft_cpu_hours ?? 0;
      const wall = l.wall_seconds ?? s.lastT;
      return `${plural(l.candidates_generated ?? 0, "candidate")} screened and ${plural(l.measurements ?? 0, "measurement")} taken in ${fmtDuration(wall)} on one machine. The same screen with DFT would have cost roughly ${fmtCpuHours(dft)} CPU-hours — which is the difference between a question you can ask on a Thursday and one you write a grant for.`;
    },
    focus: "panel-ledger",
    dwellMs: 10000,
  },
  {
    id: "proposal",
    match: (e) => e.body.type === "proposal.created",
    title: "It ends at the bench, not at a plot",
    body: (s, e) => {
      if (e.body.type !== "proposal.created") return "";
      const p = e.body.proposal;
      return `The campaign closes with something a lab can act on: "${p.title}" — ${plural(p.synthesis_route.length, "synthesis step")}, ${plural(p.validation_protocol.length, "validation measurement")}, ${plural(p.falsification_criteria.length, "stated result")} that would prove the whole thing wrong, and ${plural(p.caveats.length, "caveat")} about what the models cannot see. It is a testable claim handed back to a human.`;
    },
    focus: "panel-proposal",
    dwellMs: 13000,
  },
  {
    id: "done",
    match: (e) => e.body.type === "campaign.completed",
    title: "The whole run is a replayable log",
    body: (s) =>
      `${s.eventCount} events, start to finish. The interface is a pure function of that log, so you can scrub back to any moment and see exactly what the system knew and believed at the time — including the hypothesis it had not yet refuted.`,
    focus: "panel-hypotheses",
    dwellMs: 11000,
  },
];

/**
 * The tour's beats grouped into the acts a viewer follows: what was asked,
 * what it guessed, who pushed back, what it measured, what it concluded, and
 * what it hands back.
 */
export const CHAPTERS: { title: string; beats: string[] }[] = [
  { title: "Goal", beats: ["goal", "spec"] },
  { title: "Hypothesis", beats: ["hypothesis"] },
  { title: "Skeptic", beats: ["skeptic"] },
  { title: "Measure", beats: ["measurements", "structure", "neb", "pareto"] },
  { title: "Verdict", beats: ["verdict", "heuristics", "controller"] },
  { title: "Result", beats: ["ledger", "proposal", "done"] },
];

export function chapterOf(beatId: string | undefined): number {
  if (!beatId) return -1;
  return CHAPTERS.findIndex((c) => c.beats.includes(beatId));
}
