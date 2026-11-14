"""Skeptic: refuses to let the campaign waste compute on bad candidates.

A skeptic that approves everything is a bug, so the prompt names the five veto
categories concretely and demands the reviewer commit to one per rejection.

Note the ordering constraint: the Skeptic runs *before* scoring, so it cannot
see the `ood_flag`s the scorers will raise. What it can judge is whether a
candidate is outside the physics model's competence by construction, chemically
implausible, unsynthesizable, a duplicate, or off-spec. Exact duplicates are
detected deterministically in code first and handed to it, because that is a
string comparison, not a judgement call.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from ..contracts import Candidate, NotebookView, Veto
from ..llm import LLM
from .base import HONESTY, Emit, reason_then_format, render_candidate, render_notebook

SYSTEM = (
    HONESTY
    + """

You are the SKEPTIC. You review proposed candidates before any compute is spent
on them, and you veto the ones that should not be scored.

Veto categories — choose exactly one per vetoed candidate:
- `ood` — outside what the physics model can be trusted on: elements or
  bonding it was not trained for, a cell far larger than a few hundred atoms,
  a property that needs timescales beyond picoseconds, or a structure type the
  method does not treat (e.g. a disordered or amorphous phase scored as if it
  were an ordered crystal).
- `implausible` — the chemistry is wrong: impossible oxidation states, an
  unreasonable coordination environment, a composition that would not hold
  together.
- `unsynthesizable` — no plausible route exists at reasonable conditions, or
  the substitution would obviously not be accommodated by the lattice.
- `duplicate` — the same material as another candidate in this batch or an
  already-measured one, in a different guise.
- `off_spec` — violates a stated constraint, or cannot inform the hypothesis
  under review.

You are not here to be agreeable. Veto what deserves a veto, and approve what
does not: a veto you cannot justify from the structure, the provenance or the
spec costs the campaign a real candidate. If the batch is genuinely sound, say
so and approve it — but say what specifically you checked.

Your commentary must include anything the Analyst will need later: which
measurements on this batch should be read as upper bounds, which are proxies,
and where you expect the model to be extrapolating."""
)


class VetoDraft(BaseModel):
    candidate_id: str
    category: str = Field(
        description="one of: ood, implausible, unsynthesizable, duplicate, off_spec"
    )
    reason: str = Field(description="specific and checkable, one or two sentences")


class ReviewDraft(BaseModel):
    vetoed: list[VetoDraft] = Field(description="empty if nothing deserves a veto")
    commentary: str = Field(description="what you checked, and caveats for the Analyst")


_CATEGORIES = {"ood", "implausible", "unsynthesizable", "duplicate", "off_spec"}


def find_duplicates(
    candidates: list[Candidate], known: dict[str, Candidate]
) -> dict[str, str]:
    """candidate_id -> the id it duplicates. Exact structure/formula matches only."""
    seen: dict[tuple[str, str], str] = {}
    for cid, cand in known.items():
        if cid not in {c.id for c in candidates}:
            seen.setdefault((cand.formula or cand.name, cand.structure.strip()), cid)
    dupes: dict[str, str] = {}
    for cand in candidates:
        key = (cand.formula or cand.name, cand.structure.strip())
        if key in seen:
            dupes[cand.id] = seen[key]
        else:
            seen[key] = cand.id
    return dupes


async def run_skeptic(
    llm: LLM,
    emit: Emit,
    view: NotebookView,
    candidates: list[Candidate],
    *,
    hypothesis_id: str,
    round_number: int,
) -> tuple[list[str], list[Veto], str]:
    """Returns `(approved_ids, vetoes, commentary)`."""
    ids = [c.id for c in candidates]
    hypothesis = next((h for h in view.hypotheses if h.id == hypothesis_id), None)
    duplicates = find_duplicates(candidates, view.candidates)

    lines = [render_notebook(view, include_candidates=False)]
    if hypothesis is not None:
        lines.append(
            "Hypothesis under review:\n"
            f"  {hypothesis.statement}\n"
            f"  prediction: {hypothesis.prediction}\n"
            f"  falsified if: {hypothesis.falsification_criterion}"
        )
    lines.append(
        "Candidates proposed for this batch:\n"
        + "\n".join(render_candidate(c) for c in candidates)
    )
    if duplicates:
        lines.append(
            "Exact duplicates already detected in code (veto these as `duplicate` "
            "unless you have a reason not to):\n"
            + "\n".join(f"  {k} duplicates {v}" for k, v in duplicates.items())
        )
    lines.append(
        "--- your task ---\n"
        f"Review these {len(candidates)} candidates. Veto by id "
        f"(valid ids: {', '.join(ids)}) with one category each, and leave the rest "
        "approved. Then write the commentary the Analyst will read."
    )

    draft, _ = await reason_then_format(
        llm,
        emit,
        ReviewDraft,
        system=SYSTEM,
        prompt="\n\n".join(lines),
        entry_id=f"n-{hypothesis_id}-skeptic",
        author="skeptic",
        heading=f"Round {round_number} — skeptic review",
        effort="high",
    )

    vetoes: list[Veto] = []
    vetoed_ids: set[str] = set()
    for v in draft.vetoed:
        if v.candidate_id not in ids or v.candidate_id in vetoed_ids:
            continue  # unknown or repeated id — a veto must name a real candidate
        category = v.category.strip().lower()
        if category not in _CATEGORIES:
            category = "off_spec"
        vetoed_ids.add(v.candidate_id)
        vetoes.append(
            Veto(candidate_id=v.candidate_id, category=category, reason=v.reason)  # type: ignore[arg-type]
        )

    # Code-detected duplicates stand even if the reviewer overlooked them.
    for cid, original in duplicates.items():
        if cid not in vetoed_ids:
            vetoed_ids.add(cid)
            vetoes.append(
                Veto(
                    candidate_id=cid,
                    category="duplicate",
                    reason=f"Identical structure and composition to {original}, "
                    "already in the campaign.",
                )
            )

    approved = [cid for cid in ids if cid not in vetoed_ids]
    return approved, vetoes, draft.commentary
