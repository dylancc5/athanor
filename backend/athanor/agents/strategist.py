"""Strategist: the notebook so far becomes the next falsifiable hypothesis.

The hypothesis is only worth testing if it can lose. The prompt therefore
insists on a numeric prediction and a falsification criterion stated as a
measurable threshold, and the code checks afterwards that the criterion is
decided by properties the campaign can actually measure — a criterion resting
on an unmeasurable property is unfalsifiable in practice, however confident it
sounds.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from ..contracts import BatchPlan, Hypothesis, NotebookView
from ..llm import LLM
from .base import HONESTY, Emit, render_notebook, reason_then_format

SYSTEM = (
    HONESTY
    + """

You are the STRATEGIST. Each round you propose exactly one hypothesis and the
batch of candidates that would test it.

A hypothesis earns its place only if it can lose:
- `statement` is one specific, mechanistic claim — not a goal, not a plan, and
  not "candidate X will be good". Name the chemistry and the mechanism.
- `prediction` says what the measurements will show if the claim holds, with
  numbers and units, in terms of the properties this campaign can measure.
- `falsification_criterion` states the measurable outcome that kills the claim.
  It must be a threshold or an ordering that the planned batch really could
  produce. "The result is unclear" is not a falsification criterion.

Pick the claim whose death would teach the most, and prefer the cheapest such
claim first. Read the standing heuristics from earlier rounds and obey them. If
a claim has already been refuted, do not propose it again in another costume —
build on what the refutation revealed instead.

Your notebook entry is read by a human scientist. Say what you believe, why you
believe it, and what would change your mind."""
)


class BatchPlanDraft(BaseModel):
    n_candidates: int = Field(description="how many candidates to test, 2 to 8")
    strategy: str = Field(description="how candidates will be chosen, one or two sentences")
    properties: list[str] = Field(description="property keys that decide the hypothesis")


class HypothesisDraft(BaseModel):
    statement: str
    rationale: str
    prediction: str
    falsification_criterion: str
    batch_plan: BatchPlanDraft
    builds_on_hypothesis_id: str = Field(
        description="id of the earlier hypothesis this grew out of, or an empty string"
    )


async def run_strategist(
    llm: LLM,
    emit: Emit,
    view: NotebookView,
    *,
    round_number: int,
    hypothesis_id: str,
    branch: str = "main",
    max_candidates: int = 8,
) -> Hypothesis:
    prompt = (
        f"{render_notebook(view)}\n\n"
        f"--- your task ---\n"
        f"This is round {round_number} on branch {branch}. Propose the next "
        f"hypothesis and its batch plan. The batch may contain at most "
        f"{max_candidates} candidates. The properties that decide it must be "
        f"drawn from this campaign's objectives: "
        f"{', '.join(o.property for o in view.spec.objectives)}."
    )
    heading = f"Round {round_number} — hypothesis"
    draft, _ = await reason_then_format(
        llm,
        emit,
        HypothesisDraft,
        system=SYSTEM,
        prompt=prompt,
        entry_id=f"n-{hypothesis_id}",
        author="strategist",
        heading=heading,
        effort="high",
    )

    objective_properties = [o.property for o in view.spec.objectives]
    decisive = [p for p in draft.batch_plan.properties if p in objective_properties]
    if not decisive:
        # Falling back to every objective keeps the hypothesis testable rather
        # than letting it rest on a property nothing measures.
        decisive = objective_properties

    known_ids = {h.id for h in view.hypotheses}
    parent = draft.builds_on_hypothesis_id.strip() or None
    if parent not in known_ids:
        parent = None

    return Hypothesis(
        id=hypothesis_id,
        parent_id=parent,
        round=round_number,
        branch=branch,
        statement=draft.statement,
        rationale=draft.rationale,
        prediction=draft.prediction,
        falsification_criterion=draft.falsification_criterion,
        batch_plan=BatchPlan(
            n_candidates=max(1, min(int(draft.batch_plan.n_candidates), max_candidates)),
            strategy=draft.batch_plan.strategy,
            properties=decisive,
        ),
    )
