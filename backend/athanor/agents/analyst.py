"""Analyst: SUPPORTED / REFUTED / INCONCLUSIVE, judged against the hypothesis's
own stated falsification criterion — not against whether the round went well.

Two guards sit in code around the model's judgement:

* If none of the properties the hypothesis named as decisive were actually
  measured, the verdict is forced to INCONCLUSIVE. A verdict on absent data is
  a fabrication no matter how well argued.
* The verdict string is validated against the three literals; anything else
  becomes INCONCLUSIVE rather than being guessed at.

Heuristics are written back so later rounds inherit what this round cost.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from ..contracts import Heuristic, Hypothesis, Measurement, NotebookView, Verdict
from ..llm import LLM
from .base import HONESTY, Emit, render_measurements, render_notebook, reason_then_format

SYSTEM = (
    HONESTY
    + """

You are the ANALYST. You decide whether the hypothesis under review is
SUPPORTED, REFUTED or INCONCLUSIVE, and you decide it against the
falsification criterion the Strategist wrote down before seeing any data.

How to judge:
- Re-read the falsification criterion. Apply it literally to the measurements
  actually collected. If the criterion is met, the verdict is REFUTED, and that
  is a good outcome — say so plainly and do not hedge it into
  "partially supported".
- SUPPORTED requires that the prediction held on the measurements present, not
  merely that nothing contradicted it.
- INCONCLUSIVE is the honest verdict when the decisive measurements are
  missing, failed, or too close together to separate given their confidence and
  any OOD flags. Say which specific measurement would settle it.
- A difference smaller than the method's own uncertainty is not a result. Say
  when two numbers are indistinguishable.
- Discount proxy measurements explicitly: say what the proxy does and does not
  license you to conclude.

Every item of evidence must cite a real measured number from the notebook, with
its unit and the candidate it came from. Do not round away precision, and do
not cite a number that is not in the notebook.

Heuristics: write down what the next round should do differently because of
this result. A good heuristic is an instruction, not an observation — "score
both axes, stability does not predict mobility in this family" rather than
"stability and mobility were uncorrelated". Mark a heuristic `established` only
when it follows from the physics or from more than one round; otherwise
`tentative`."""
)


class HeuristicDraft(BaseModel):
    text: str = Field(description="an instruction for later rounds")
    strength: str = Field(description="tentative or established")


class VerdictDraft(BaseModel):
    verdict: str = Field(description="exactly one of SUPPORTED, REFUTED, INCONCLUSIVE")
    reasoning: str = Field(description="how the criterion was applied to the numbers")
    evidence: list[str] = Field(
        description="short statements, each citing a measured number with its unit"
    )
    heuristics: list[HeuristicDraft]


_VERDICTS = {"SUPPORTED", "REFUTED", "INCONCLUSIVE"}


def decisive_measurements(
    hypothesis: Hypothesis, measurements: list[Measurement], candidate_ids: set[str]
) -> list[Measurement]:
    wanted = set(hypothesis.batch_plan.properties)
    return [
        m for m in measurements if m.property in wanted and m.candidate_id in candidate_ids
    ]


async def run_analyst(
    llm: LLM,
    emit: Emit,
    view: NotebookView,
    hypothesis: Hypothesis,
    *,
    round_measurements: list[Measurement],
    candidate_ids: set[str],
    failures: dict[str, str],
    skeptic_commentary: str = "",
    round_number: int = 1,
    heuristic_prefix: str = "heu",
) -> tuple[Verdict, str, list[str], list[Heuristic]]:
    """Returns `(verdict, reasoning, evidence, heuristics)`."""
    decisive = decisive_measurements(hypothesis, round_measurements, candidate_ids)

    lines = [render_notebook(view, include_candidates=True)]
    lines.append(
        "Hypothesis under test:\n"
        f"  id: {hypothesis.id}\n"
        f"  claim: {hypothesis.statement}\n"
        f"  prediction: {hypothesis.prediction}\n"
        f"  FALSIFIED IF: {hypothesis.falsification_criterion}\n"
        f"  decided by: {', '.join(hypothesis.batch_plan.properties)}"
    )
    lines.append(
        f"Measurements collected in round {round_number} "
        f"({len(round_measurements)} total, {len(decisive)} on the decisive "
        f"properties):\n" + render_measurements(round_measurements)
    )
    if failures:
        lines.append(
            "Candidates that FAILED to score (no value exists for them — reason with "
            "less data, do not estimate):\n"
            + "\n".join(f"  {cid}: {why}" for cid, why in failures.items())
        )
    if skeptic_commentary:
        lines.append(f"The Skeptic's caveats on this batch:\n  {skeptic_commentary}")

    if not decisive:
        lines.append(
            "--- your task ---\n"
            "None of the decisive properties were measured for the approved "
            "candidates, so the verdict is INCONCLUSIVE. Explain exactly which "
            "measurement is missing and what would settle the question, and write "
            "the heuristics that follow from the attempt itself."
        )
    else:
        lines.append(
            "--- your task ---\n"
            "Apply the falsification criterion literally to the measurements above "
            "and return the verdict, the reasoning, the evidence, and the "
            "heuristics for later rounds."
        )

    draft, _ = await reason_then_format(
        llm,
        emit,
        VerdictDraft,
        system=SYSTEM,
        prompt="\n\n".join(lines),
        entry_id=f"n-{hypothesis.id}-verdict",
        author="analyst",
        heading=f"Round {round_number} — verdict",
        effort="high",
    )

    verdict_text = draft.verdict.strip().upper()
    verdict: Verdict = verdict_text if verdict_text in _VERDICTS else "INCONCLUSIVE"  # type: ignore[assignment]
    if not decisive:
        verdict = "INCONCLUSIVE"

    heuristics = [
        Heuristic(
            id=f"{heuristic_prefix}-{i + 1}",
            text=h.text,
            learned_from=hypothesis.id,
            strength="established" if h.strength.strip().lower() == "established" else "tentative",
        )
        for i, h in enumerate(draft.heuristics)
    ]
    return verdict, draft.reasoning, list(draft.evidence), heuristics
