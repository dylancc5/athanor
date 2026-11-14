"""Proposal: the closing experimental proposal.

This is the campaign's actual deliverable — the thing a scientist could take
into a lab on Monday. It needs a synthesis route, a validation protocol, the
criteria that would falsify the proposal itself, and caveats that name the
capability boundary honestly rather than burying it.

The caveats are not boilerplate. A proposal that quietly implies the models
predicted grain-boundary resistance or shelf life is worse than no proposal, so
the capability boundary is stated in the prompt and a backstop caveat is
appended in code if the model's own list does not mention it.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from ..contracts import NotebookView, Proposal
from ..llm import LLM
from .base import HONESTY, Emit, reason_then_format, render_notebook

SYSTEM = (
    HONESTY
    + """

You are writing the campaign's closing EXPERIMENTAL PROPOSAL: what a lab should
do next, and what result would prove the campaign wrong.

- `summary` states what the campaign established and what it failed to
  establish. Lead with the refutations — they are the most reliable thing here.
- `synthesis_route` is ordered, concrete steps a synthetic chemist could follow:
  real precursors, real conditions, real equipment. No "optimize conditions".
- `validation_protocol` is the measurements that would test the prediction, each
  naming the technique and what it would show.
- `falsification_criteria` are thresholds on those measurements that would
  refute the proposal. State numbers. If the proposal cannot be falsified by
  the protocol you just wrote, the protocol is wrong — fix it.
- `caveats` name the capability boundary without euphemism: the atomistic
  models reach a few hundred atoms over picoseconds, so they say nothing about
  bulk mechanical properties, long-timescale kinetics or degradation,
  grain-boundary and microstructural effects, device-level performance, cost,
  or manufacturability. Also name every proxy the campaign leaned on, every OOD
  flag, and anything the measurements could not separate.

Recommend candidates only from the ones measured in this campaign, and cite the
measured numbers that justify the choice."""
)

_BOUNDARY_HINTS = (
    "picosecond",
    "few hundred atoms",
    "grain",
    "microstructure",
    "device",
    "manufactur",
    "long-timescale",
    "long timescale",
)

_BACKSTOP = (
    "The atomistic models used here reach a few hundred atoms over picoseconds. "
    "They do not predict bulk mechanical properties, long-timescale kinetics or "
    "degradation, grain-boundary and microstructural behaviour, device-level "
    "performance, or manufacturability — and any of those can decide whether "
    "this material is usable."
)


class ProposalDraft(BaseModel):
    title: str
    summary: str
    lead_candidate_ids: list[str] = Field(description="ids from the notebook, best first")
    synthesis_route: list[str]
    validation_protocol: list[str]
    falsification_criteria: list[str]
    caveats: list[str]


async def run_proposal(
    llm: LLM,
    emit: Emit,
    view: NotebookView,
    *,
    entry_id: str = "n-proposal",
) -> Proposal:
    frontier = [p.candidate_id for p in view.pareto if p.rank == 0]
    measured = sorted({m.candidate_id for m in view.measurements})
    prompt = (
        f"{render_notebook(view)}\n\n"
        f"--- your task ---\n"
        f"Write the closing proposal for this campaign.\n"
        f"Candidates on the current Pareto frontier: "
        f"{', '.join(frontier) if frontier else '(none — no candidate has a complete set of objective measurements)'}.\n"
        f"Candidates with at least one measurement: "
        f"{', '.join(measured) if measured else '(none)'}.\n"
        f"Recommend only from those. If nothing was measured, say so in the summary "
        f"and propose the experiment that would produce the missing data."
    )
    draft, _ = await reason_then_format(
        llm,
        emit,
        ProposalDraft,
        system=SYSTEM,
        prompt=prompt,
        entry_id=entry_id,
        author="analyst",
        heading="Closing proposal",
        effort="high",
        prose_max_tokens=32000,
    )

    known = set(view.candidates)
    leads = [cid for cid in draft.lead_candidate_ids if cid in known]
    if not leads:
        leads = frontier or measured

    caveats = [c for c in draft.caveats if c.strip()]
    blob = " ".join(caveats).lower()
    if not any(hint in blob for hint in _BOUNDARY_HINTS):
        caveats.append(_BACKSTOP)

    return Proposal(
        title=draft.title,
        summary=draft.summary,
        lead_candidate_ids=leads,
        synthesis_route=[s for s in draft.synthesis_route if s.strip()],
        validation_protocol=[s for s in draft.validation_protocol if s.strip()],
        falsification_criteria=[s for s in draft.falsification_criteria if s.strip()],
        caveats=caveats,
    )
