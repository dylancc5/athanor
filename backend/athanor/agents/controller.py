"""Controller: continue, pivot, branch, or converge.

Cheap but load-bearing — it is what makes the campaign multi-round rather than
a loop that runs a fixed number of times. It is told how many rounds remain so
it can converge deliberately instead of being cut off.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from ..contracts import ControllerDecision, Hypothesis, NotebookView, Verdict
from ..llm import LLM
from .base import HONESTY, Emit, render_notebook, reason_then_format

SYSTEM = (
    HONESTY
    + """

You are the CONTROLLER. After each verdict you choose what the campaign does
next:

- `continue` — the current line of attack is working; press on with a related
  hypothesis in the same direction.
- `pivot` — the last claim was refuted or went nowhere; the refutation itself
  points somewhere better. Say where.
- `branch` — two genuinely different lines are both worth testing and the
  evidence cannot choose between them. Name each branch. Use this sparingly:
  every branch costs a full round of compute.
- `converge` — stop exploring and spend the remaining effort on the closing
  proposal. Choose this when the frontier has stopped moving, when the
  remaining uncertainty can only be settled in a lab, or when the rounds are
  nearly spent.

A refuted hypothesis is not a reason to retreat to a safer claim. It is
information: say what it ruled out and what that makes worth testing."""
)


class DecisionDraft(BaseModel):
    action: Literal["continue", "pivot", "branch", "converge"]
    reasoning: str
    branch_names: list[str] = Field(
        description="short names, only for action=branch; otherwise an empty list"
    )


async def run_controller(
    llm: LLM,
    emit: Emit,
    view: NotebookView,
    hypothesis: Hypothesis,
    verdict: Verdict,
    *,
    round_number: int,
    rounds_remaining: int,
) -> ControllerDecision:
    prompt = (
        f"{render_notebook(view, include_candidates=False)}\n\n"
        f"Round {round_number} just closed. Hypothesis {hypothesis.id} "
        f"({hypothesis.statement}) came back {verdict}.\n\n"
        f"--- your task ---\n"
        f"{rounds_remaining} round(s) of compute remain after this one. Decide what "
        f"the campaign does next. If no rounds remain, converge."
    )
    draft, _ = await reason_then_format(
        llm,
        emit,
        DecisionDraft,
        system=SYSTEM,
        prompt=prompt,
        entry_id=f"n-{hypothesis.id}-controller",
        author="controller",
        heading=f"Round {round_number} — next move",
        effort="high",
        prose_max_tokens=16000,
    )

    action = draft.action
    branches = [b.strip() for b in draft.branch_names if b.strip()] if action == "branch" else []
    if rounds_remaining <= 0:
        action = "converge"
        branches = []
    if action == "branch" and len(branches) < 2:
        action = "continue"  # a branch with fewer than two arms is just continuing
        branches = []
    return ControllerDecision(action=action, reasoning=draft.reasoning, branches=branches)
