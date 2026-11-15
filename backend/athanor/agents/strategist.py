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
from .base import HONESTY, Emit, reason_then_format, render_notebook

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

**The claim must be decidable within the batch you are given.** You are told the
maximum batch size, and every candidate costs a real calculation — on the order
of minutes each — so a round cannot afford more. A claim needing a four-way
controlled comparison cannot be settled by a three-candidate batch: it comes
back inconclusive for want of arithmetic, which teaches nothing and wastes the
round. So choose the sharpest claim whose falsification criterion can be
*decided* by the batch you can actually afford, and write a prediction whose
threshold that batch can test. If the interesting claim genuinely needs more
arms than the budget allows, test the one sub-comparison that is decidable now
and say in the rationale which further arm a later round would need. Narrowing
the claim to fit the evidence you can gather is experimental design; writing a
claim you cannot test is not.

The batch plan is an instruction, not a description. A separate agent builds the
batch from `batch_plan.strategy` alone and cannot see your reasoning, so write
the strategy as something executable: name the comparisons, name both members of
each one, and name the substitution or framework change that produces each
member from a structure in the notebook. "Explore anion substitutions" is not a
strategy; "score the full sulfide (100% O -> S on <parent>) against the full
oxide in the same framework" is. If your claim needs a controlled comparison,
say so explicitly and say what is held fixed — a batch that contains only one
side of your comparison cannot decide your claim however good the numbers are,
and the reviewer will reject partial substitutions that sit on neither side.

Pick the claim whose death would teach the most, and prefer the cheapest such
claim first. Read the standing heuristics from earlier rounds and obey them. If
a claim has already been refuted, do not propose it again in another costume —
build on what the refutation revealed instead.

Your notebook entry is read by a human scientist. Say what you believe, why you
believe it, and what would change your mind."""
)


class BatchPlanDraft(BaseModel):
    n_candidates: int = Field(description="how many candidates to test, 2 to 8")
    strategy: str = Field(
        description=(
            "executable instructions for building the batch: the comparisons, both "
            "members of each, and the edit that produces each member from a parent "
            "in the notebook"
        )
    )
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
        f"hypothesis and its batch plan.\n\n"
        f"HARD BUDGET: the batch may contain at most {max_candidates} "
        f"candidate(s), and each one costs minutes of real calculation. Your "
        f"falsification criterion must be decidable from at most "
        f"{max_candidates} measured candidate(s) plus whatever is already "
        f"measured in the notebook above. Count the arms your criterion needs "
        f"before you commit to it: if it needs more than that, narrow the claim "
        f"until it fits and note the further arm in the rationale.\n\n"
        f"The properties that decide it must be drawn from this campaign's "
        f"objectives: {', '.join(o.property for o in view.spec.objectives)}."
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
