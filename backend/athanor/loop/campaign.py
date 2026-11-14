"""The campaign orchestrator.

One campaign is one append-only event log. The loop is:

    intake -> spec.created
    for each round:
        round.started
        strategist  -> hypothesis.proposed
        generator   -> candidates.generated
        skeptic     -> skeptic.reviewed
        route+score -> scoring.started / measurement.recorded / artifact.created
                       pareto.updated, embedding.updated
        analyst     -> analyst.verdict
        controller  -> controller.decision
    proposal.created
    campaign.completed

with `notebook.delta` streaming throughout and `ledger.updated` at each stage
boundary.

Every stage runs inside `_guard`, which turns a failure into a `CampaignError`
event and lets the campaign continue where that is meaningful. The exceptions
are the two stages nothing downstream can proceed without — intake, and a round
with no hypothesis — which are fatal for the round or the campaign.

Nothing in here ever substitutes a value for a measurement that failed. A
scorer failure is recorded as a failure, the Analyst is told which candidates
have no data, and the verdict is forced to INCONCLUSIVE when the decisive
properties were never measured.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from .. import contracts as C
from ..agents.analyst import run_analyst
from ..agents.controller import run_controller
from ..agents.intake import run_intake
from ..agents.proposal import run_proposal
from ..agents.skeptic import run_skeptic
from ..agents.strategist import run_strategist
from ..eventlog import EventLog
from ..llm import LLM
from ..pareto import rank
from .generator import ClaudeGenerator, composition_vector
from .notebook import build_notebook
from .router import Router

log = logging.getLogger("athanor.campaign")

T = TypeVar("T")

#: Rough CPU-hours a single DFT relaxation + NEB of this size would cost. Used
#: only for the "what this would have cost" counter, and labelled as an estimate
#: wherever it is shown.
DFT_CPU_HOURS_PER_CANDIDATE = 420.0


@dataclass
class CampaignConfig:
    rounds: int = 3
    max_candidates: int = 6


def embed_candidates(
    candidates: list[C.Candidate],
) -> dict[str, tuple[float, float, float]]:
    """3D coordinates for the chemical-space flythrough.

    Composition space, not property space: every candidate has a composition,
    while an unmeasured candidate has no properties, and plotting it at the
    origin would read as "measured, and zero". Three principal components of
    the element-fraction matrix when there is enough data, the three most
    common element fractions otherwise.
    """
    vectors = {c.id: composition_vector(c) for c in candidates}
    vectors = {cid: v for cid, v in vectors.items() if v}
    if not vectors:
        return {}
    elements = sorted({el for v in vectors.values() for el in v})
    ids = sorted(vectors)
    matrix = [[vectors[cid].get(el, 0.0) for el in elements] for cid in ids]

    if len(ids) >= 4 and len(elements) >= 3:
        try:
            import numpy as np
            from sklearn.decomposition import PCA

            arr = np.asarray(matrix, dtype=float)
            comps = PCA(n_components=3, random_state=0).fit_transform(arr)
            # Fix the sign per axis so repeated runs agree.
            for axis in range(3):
                column = comps[:, axis]
                if column[int(np.argmax(np.abs(column)))] < 0:
                    comps[:, axis] = -column
            return {
                cid: (float(comps[i, 0]), float(comps[i, 1]), float(comps[i, 2]))
                for i, cid in enumerate(ids)
            }
        except Exception as exc:  # noqa: BLE001 — fall through to the simple projection
            log.info("PCA embedding unavailable (%s); using element fractions", exc)

    axes = sorted(
        elements, key=lambda el: (-sum(v.get(el, 0.0) for v in vectors.values()), el)
    )[:3]
    while len(axes) < 3:
        axes.append("")
    return {
        cid: tuple(float(vectors[cid].get(ax, 0.0)) for ax in axes)  # type: ignore[misc]
        for cid in ids
    }


class Campaign:
    """Runs one campaign, writing everything it does to an `EventLog`."""

    def __init__(
        self,
        event_log: EventLog,
        *,
        llm: LLM | None = None,
        router: Router | None = None,
        config: CampaignConfig | None = None,
    ):
        self.log = event_log
        self.config = config or CampaignConfig()
        self.ledger = C.Ledger()
        self.llm = llm or LLM(on_usage=self._on_usage)
        if self.llm.on_usage is None:
            self.llm.on_usage = self._on_usage
        self.router = router if router is not None else Router()
        self.generator = ClaudeGenerator(self.llm, self.emit)
        self._t0 = time.monotonic()

    # ------------------------------------------------------------- plumbing

    def emit(self, body: C.EventBody) -> C.Event:
        return self.log.emit(body)

    def _on_usage(self, input_tokens: int, output_tokens: int) -> None:
        self.ledger.llm_calls += 1
        self.ledger.llm_input_tokens += input_tokens
        self.ledger.llm_output_tokens += output_tokens

    def _emit_ledger(self) -> None:
        self.ledger.wall_seconds = round(time.monotonic() - self._t0, 1)
        self.ledger.est_dft_cpu_hours = round(
            self.ledger.candidates_scored * DFT_CPU_HOURS_PER_CANDIDATE, 1
        )
        self.emit(C.LedgerUpdated(ledger=self.ledger.model_copy()))

    def _error(self, stage: str, message: str, *, fatal: bool = False) -> None:
        log.warning("campaign stage %s failed: %s", stage, message)
        self.emit(C.CampaignError(stage=stage, message=message, fatal=fatal))

    async def _guard(
        self, stage: str, work: Callable[[], Awaitable[T]], fallback: T
    ) -> T:
        """Run a stage; on failure record a non-fatal `CampaignError`."""
        try:
            return await work()
        except Exception as exc:  # noqa: BLE001 — every stage failure is recorded
            self._error(stage, f"{type(exc).__name__}: {exc}")
            return fallback

    def _note(self, entry_id: str, heading: str | None, text: str) -> None:
        self.emit(
            C.NotebookDelta(entry_id=entry_id, author="system", heading=heading, text=text)
        )

    # ------------------------------------------------------------------ run

    async def run(self, goal: str) -> None:
        self.emit(C.CampaignStarted(goal=goal))
        try:
            spec = await run_intake(self.llm, goal)
        except Exception as exc:  # noqa: BLE001 — without a spec there is no campaign
            self._error("intake", f"{type(exc).__name__}: {exc}", fatal=True)
            self.log.close()
            return
        self.emit(C.SpecCreated(spec=spec))
        self._note(
            "n-intake",
            "Campaign specification",
            f"Parsed the goal into a {spec.domain} campaign with "
            f"{len(spec.objectives)} objective(s): "
            + ", ".join(f"{o.property} ({o.direction}, {o.unit})" for o in spec.objectives)
            + (
                f" and {len(spec.constraints)} hard constraint(s)."
                if spec.constraints
                else " and no hard constraints."
            )
            + (
                ""
                if self.router.scorers
                else " No scorers are registered in this process, so this round will "
                "record no measurements — the campaign reports that rather than "
                "filling the gap."
            ),
        )
        self._emit_ledger()

        rounds_run = 0
        branch = "main"
        for round_number in range(1, self.config.rounds + 1):
            rounds_run = round_number
            decision = await self._round(round_number, branch)
            if decision is None or decision.action == "converge":
                break
            if decision.action == "branch" and decision.branches:
                branch = decision.branches[0]
                self._note(
                    f"n-r{round_number}-branch",
                    "Branching",
                    f"The Controller opened {len(decision.branches)} branches "
                    f"({', '.join(decision.branches)}). They are explored one at a "
                    f"time, starting with {branch}.",
                )

        await self._closing(rounds_run)

    # ---------------------------------------------------------------- round

    async def _round(self, round_number: int, branch: str) -> C.ControllerDecision | None:
        self.emit(C.RoundStarted(round=round_number))
        view = build_notebook(self.log.events)
        spec = view.spec
        hypothesis_id = f"h{round_number}" if branch == "main" else f"h{round_number}-{branch}"

        hypothesis = await self._guard(
            "strategist",
            lambda: run_strategist(
                self.llm,
                self.emit,
                view,
                round_number=round_number,
                hypothesis_id=hypothesis_id,
                branch=branch,
                max_candidates=self.config.max_candidates,
            ),
            None,
        )
        if hypothesis is None:
            # No hypothesis means nothing to test; end the round, not the campaign.
            return None
        self.emit(C.HypothesisProposed(hypothesis=hypothesis))

        candidates = await self._guard(
            "generator",
            lambda: self.generator.propose(spec, hypothesis, view),
            [],
        )
        self.emit(
            C.CandidatesGenerated(hypothesis_id=hypothesis.id, candidates=candidates)
        )
        self.ledger.candidates_generated += len(candidates)
        self._emit_ledger()

        approved_ids: list[str] = [c.id for c in candidates]
        commentary = ""
        if candidates:
            view = build_notebook(self.log.events)
            reviewed = await self._guard(
                "skeptic",
                lambda: run_skeptic(
                    self.llm,
                    self.emit,
                    view,
                    candidates,
                    hypothesis_id=hypothesis.id,
                    round_number=round_number,
                ),
                None,
            )
            if reviewed is not None:
                approved_ids, vetoes, commentary = reviewed
            else:
                vetoes = []
                commentary = (
                    "The Skeptic failed to run, so nothing was vetoed. Treat this "
                    "batch as unreviewed."
                )
            self.emit(
                C.SkepticReviewed(
                    hypothesis_id=hypothesis.id,
                    approved_ids=approved_ids,
                    vetoes=vetoes,
                    commentary=commentary,
                )
            )
            self.ledger.candidates_vetoed += len(vetoes)

        approved = [c for c in candidates if c.id in set(approved_ids)]
        measurements, failures = await self._score(approved, spec)
        self._emit_ledger()

        all_candidates = list(build_notebook(self.log.events).candidates.values())
        points = embed_candidates(all_candidates)
        if points:
            self.emit(C.EmbeddingUpdated(points=points))

        view = build_notebook(self.log.events)
        pareto = rank(view.measurements, spec.objectives)
        self.emit(C.ParetoUpdated(points=pareto))

        verdict_result = await self._guard(
            "analyst",
            lambda: run_analyst(
                self.llm,
                self.emit,
                build_notebook(self.log.events),
                hypothesis,
                round_measurements=measurements,
                candidate_ids={c.id for c in approved},
                failures=failures,
                skeptic_commentary=commentary,
                round_number=round_number,
                heuristic_prefix=f"heu-{hypothesis.id}",
            ),
            None,
        )
        if verdict_result is None:
            return None
        verdict, reasoning, evidence, heuristics = verdict_result
        self.emit(
            C.AnalystVerdict(
                hypothesis_id=hypothesis.id,
                verdict=verdict,
                reasoning=reasoning,
                evidence=evidence,
                heuristics=heuristics,
            )
        )

        rounds_remaining = self.config.rounds - round_number
        decision = await self._guard(
            "controller",
            lambda: run_controller(
                self.llm,
                self.emit,
                build_notebook(self.log.events),
                hypothesis,
                verdict,
                round_number=round_number,
                rounds_remaining=rounds_remaining,
            ),
            C.ControllerDecision(
                action="converge" if rounds_remaining <= 0 else "continue",
                reasoning="The Controller failed to run; defaulting to the "
                "conservative move.",
            ),
        )
        self.emit(decision)
        self._emit_ledger()
        return decision

    # -------------------------------------------------------------- scoring

    async def _score(
        self, candidates: list[C.Candidate], spec: C.Spec
    ) -> tuple[list[C.Measurement], dict[str, str]]:
        """Run every routed scorer. Returns the measurements and the failures."""
        measurements: list[C.Measurement] = []
        failures: dict[str, str] = {}
        if not candidates:
            return measurements, failures

        plan = self.router.plan(candidates, spec)
        if not plan:
            unrouted = ", ".join(c.id for c in candidates)
            self._error(
                "routing",
                f"no registered scorer measures this campaign's objectives for "
                f"domain {spec.domain!r}; {len(candidates)} candidate(s) go unmeasured "
                f"({unrouted})",
            )
            for cand in candidates:
                failures[cand.id] = "no scorer available for this domain and objective set"
            return measurements, failures

        scored_ids: set[str] = set()
        for scorer_name, batch in plan.items():
            scorer: Any = self.router.by_name(scorer_name)
            for cand in batch:
                self.emit(C.ScoringStarted(candidate_id=cand.id, scorer=scorer_name))
            started = time.monotonic()
            result = await self._guard(
                f"scoring:{scorer_name}",
                lambda s=scorer, b=batch: s.score(b, spec),  # type: ignore[misc]
                None,
            )
            self.ledger.scorer_seconds = round(
                self.ledger.scorer_seconds + (time.monotonic() - started), 2
            )
            if result is None:
                for cand in batch:
                    failures.setdefault(cand.id, f"scorer {scorer_name} raised")
                continue

            for m in result.measurements:
                measurements.append(m)
                self.emit(C.MeasurementRecorded(measurement=m))
                self.ledger.measurements += 1
                scored_ids.add(m.candidate_id)
            for artifact, payload in result.artifacts:
                try:
                    self.log.emit_artifact(artifact, payload)
                except Exception as exc:  # noqa: BLE001 — a lost visual is not a lost result
                    self._error(
                        f"artifact:{scorer_name}", f"{type(exc).__name__}: {exc}"
                    )
            for cid, reason in result.failed.items():
                failures[cid] = f"{scorer_name}: {reason}"

        self.ledger.candidates_scored += len(scored_ids)
        return measurements, failures

    # -------------------------------------------------------------- closing

    async def _closing(self, rounds_run: int) -> None:
        view = build_notebook(self.log.events)
        proposal = await self._guard(
            "proposal", lambda: run_proposal(self.llm, self.emit, view), None
        )
        if proposal is not None:
            self.emit(C.ProposalCreated(proposal=proposal))
        self._emit_ledger()
        self.emit(C.CampaignCompleted(rounds=rounds_run))
        self.log.close()
