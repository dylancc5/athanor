"""The Generator: retrieval seeds, Claude-proposed perturbations, and the
active-learning cut that decides which proposals actually get scored.

Three rules shape this file.

**Claude proposes edits, code applies them.** A perturbation arrives as
structured data — parent id, element out, element in, fraction — and ASE
performs the substitution on the parent's *real* retrieved structure. The
resulting `Provenance` records `parent_id` and a human-readable `operation`
("substitute 25% S -> Cl"), so every derived candidate is traceable back to a
database entry. For molecular domains the edit is a child SMILES, which is a
statement about connectivity rather than a fabricated set of coordinates.

**Selection happens in composition space.** When more candidates are proposed
than the batch plan allows, we keep the ones that are *chemically* farthest from
what has already been measured — farthest-point sampling on element-fraction
vectors. The tempting version of this is "far in property space", but a brand
new candidate has no properties yet, so that would mean predicting its
properties and selecting on the prediction: inventing data to decide what to
measure. Composition is something we actually know.

**Nothing is measured here.** The generator never writes a `Measurement`, even
when the database it queried happened to carry one.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable

import numpy as np
from pydantic import BaseModel, Field

from ..contracts import (
    Candidate,
    EventBody,
    Hypothesis,
    NotebookDelta,
    NotebookView,
    Provenance,
    Spec,
)
from ..llm import LLM
from ..structure import atoms_to_cif, composition, parse_structure, reduced_formula
from .seeds import retrieve_seeds

log = logging.getLogger("athanor.generator")

Emit = Callable[[EventBody], object]

PERTURB_SYSTEM = """\
You propose chemical edits to real, retrieved structures so a hypothesis can be
tested. You never write a structure: you name the parent candidate and the edit,
and the platform applies it with a real structure-manipulation library.

**Your job is to execute the hypothesis's batch design, not to explore.** The
hypothesis, its prediction, its falsification criterion and its batch strategy
are given to you. Read them as a specification and build the batch they require.
A reviewer sees this batch next and rejects, as off-spec, any candidate that
cannot inform the stated claim — however interesting that candidate is.

Two rules decide whether the batch is testable:

1. **Generate every member of every comparison the hypothesis names.** If the
   claim compares an oxide against a sulfide at fixed framework, the batch needs
   the oxide *and* the sulfide, in that framework. If it compares framework A
   against framework B at fixed chemistry, it needs both frameworks. Half a
   comparison measures nothing: the round dies whatever the numbers say. Check
   each clause of the prediction and the falsification criterion and ask which
   structures it mentions — all of them must be in the batch or already
   measured in the notebook.
2. **Change only the variable under test.** The hypothesis names the variables
   it compares. An edit that moves anything else — swapping the central cation
   when the claim is about the anion, changing the framework when the claim is
   about composition — confounds the comparison and will be rejected.

A crystalline edit is an elemental substitution on the parent lattice: which
element leaves, which element replaces it, and what fraction of its sites are
affected.

- **For a controlled comparison use complete substitution, `fraction` 1.0.** A
  claim about "the oxide versus the sulfide" is about the end members. A 50%
  mixed-anion intermediate is neither end member, so it cannot sit on either
  side of the comparison.
- Use a partial fraction only when the hypothesis is itself about composition
  dependence (a trend, a doping level, an optimum). Then give the series the
  claim needs, including the end members that anchor it.
- Keep the substituting ion's size and charge plausible for the site it enters,
  or the edit is chemistry fiction even if the code can perform it.

A molecular edit is the child's SMILES plus a description of the change in
words ("replace the ester with an amide").

Say for each edit which way the measurement should move if the claim holds, and
which member of which comparison the candidate is."""


class CrystalEdit(BaseModel):
    parent_id: str = Field(description="id of an existing candidate to edit")
    element_out: str = Field(description="element symbol being replaced")
    element_in: str = Field(description="element symbol replacing it")
    fraction: float = Field(description="fraction of that element's sites, 0 to 1")
    rationale: str


class MolecularEdit(BaseModel):
    parent_id: str
    child_smiles: str = Field(description="SMILES of the edited molecule")
    operation: str = Field(description="the change in words")
    rationale: str


class EditBatch(BaseModel):
    crystal_edits: list[CrystalEdit]
    molecular_edits: list[MolecularEdit]
    commentary: str


# --------------------------------------------------------------------------
# Composition space
# --------------------------------------------------------------------------


def composition_vector(cand: Candidate) -> dict[str, float]:
    """Element -> fraction of atoms. Empty if the structure will not parse."""
    try:
        atoms = parse_structure(cand.structure, cand.repr_kind)
    except Exception as exc:  # noqa: BLE001 — unparseable means no coordinates
        log.warning("cannot parse %s for composition: %s", cand.id, exc)
        return {}
    comp = composition(atoms)
    total = sum(comp.values()) or 1
    return {el: n / total for el, n in comp.items()}


def _distance(a: dict[str, float], b: dict[str, float]) -> float:
    keys = set(a) | set(b)
    return math.sqrt(sum((a.get(k, 0.0) - b.get(k, 0.0)) ** 2 for k in keys))


def select_informative(
    proposals: list[Candidate], measured: list[Candidate], k: int
) -> tuple[list[Candidate], str]:
    """Farthest-point selection in composition space; returns the batch and a note.

    Deterministic: ties break on candidate id.
    """
    if k >= len(proposals):
        return list(proposals), ""
    vectors = {c.id: composition_vector(c) for c in proposals}
    reference = [composition_vector(c) for c in measured]
    reference = [v for v in reference if v]

    chosen: list[Candidate] = []
    remaining = sorted(proposals, key=lambda c: c.id)
    while remaining and len(chosen) < k:
        anchors = reference + [vectors[c.id] for c in chosen]

        def spread(cand: Candidate, anchors: list = anchors) -> tuple[float, str]:
            v = vectors[cand.id]
            if not v or not anchors:
                return (0.0, cand.id)
            return (min(_distance(v, a) for a in anchors), cand.id)

        best = max(remaining, key=spread)
        chosen.append(best)
        remaining.remove(best)

    note = (
        f"{len(proposals)} candidates were proposed but the batch plan allows "
        f"{k}, so the batch keeps the {k} that sit farthest from the "
        f"{len(reference)} already-measured composition(s) in element-fraction "
        f"space — the cut maximizes what the round can tell us rather than "
        f"re-measuring near-duplicates. Selection is on composition, not on "
        f"predicted properties: an unmeasured candidate has no properties, and "
        f"selecting on a prediction would mean inventing the data we are about "
        f"to go and measure."
    )
    return chosen, note


# --------------------------------------------------------------------------
# Perturbations
# --------------------------------------------------------------------------


def _mean_covalent_radius(symbols: list[str]) -> float:
    """Mean covalent radius of a symbol list, used to rescale a substituted cell."""
    from ase.data import atomic_numbers, covalent_radii

    radii = [
        float(covalent_radii[atomic_numbers[s]])
        for s in symbols
        if s in atomic_numbers and covalent_radii[atomic_numbers[s]] > 0
    ]
    return sum(radii) / len(radii) if radii else 0.0


def apply_substitution(
    parent: Candidate, element_out: str, element_in: str, fraction: float, child_id: str
) -> Candidate:
    """Substitute a fraction of `element_out` sites with `element_in`, using ASE.

    Sites are chosen by ascending index so the same edit always produces the
    same structure, which is what makes a recorded campaign replay identically.
    """
    atoms = parse_structure(parent.structure, parent.repr_kind)
    symbols = [str(s) for s in atoms.get_chemical_symbols()]
    indices = [i for i, s in enumerate(symbols) if s == element_out]
    if not indices:
        raise ValueError(f"{parent.id} contains no {element_out} to substitute")
    fraction = min(max(fraction, 0.0), 1.0)
    count = max(1, round(fraction * len(indices)))
    count = min(count, len(indices))
    before = _mean_covalent_radius(symbols)
    for i in indices[:count]:
        symbols[i] = element_in
    atoms.set_chemical_symbols(symbols)

    # Rescale the cell for the new ion size. Swapping species in place leaves the
    # lattice at the parent's dimensions, which is fine for similar radii and
    # catastrophic otherwise: a full O -> S substitution on an oxide cell put P
    # and S 1.54 A apart (0.73x the covalent-radius sum), and MACE returned a
    # 4.3e8 eV barrier on the overlapping geometry. The campaign flagged it OOD
    # and voided it rather than reporting it — honest, but the round was still
    # wasted. An isotropic scale by the ratio of mean covalent radii preserves
    # the packing fraction and hands the scorer a sane starting point; the
    # scorer's own relaxation does the rest, so this is a starting guess, not a
    # claim about the relaxed structure.
    after = _mean_covalent_radius(symbols)
    scale = 1.0
    if np.any(atoms.pbc) and before > 0 and after > 0:
        scale = after / before
        if abs(scale - 1.0) > 0.02:
            atoms.set_cell(atoms.cell.array * scale, scale_atoms=True)

    actual = count / len(indices)
    operation = (
        f"substitute {actual * 100:.0f}% {element_out} -> {element_in} "
        f"({count} of {len(indices)} sites)"
    )
    if abs(scale - 1.0) > 0.02:
        operation += f", cell rescaled x{scale:.3f} for the new ion radius"
    return Candidate(
        id=child_id,
        name=reduced_formula(atoms),
        formula=reduced_formula(atoms),
        structure=atoms_to_cif(atoms),
        repr_kind="cif",
        domain=parent.domain,
        provenance=Provenance(
            source="perturbation",
            database=parent.provenance.database,
            parent_id=parent.id,
            operation=operation,
        ),
    )


def _molecular_child(parent: Candidate, smiles: str, operation: str, child_id: str) -> Candidate:
    from ..structure import smiles_to_atoms

    atoms = smiles_to_atoms(smiles)  # raises if RDKit cannot parse it
    return Candidate(
        id=child_id,
        name=f"{parent.name} analogue",
        formula=reduced_formula(atoms),
        structure=smiles,
        repr_kind="smiles",
        domain=parent.domain,
        provenance=Provenance(
            source="perturbation",
            parent_id=parent.id,
            operation=operation,
        ),
    )


# --------------------------------------------------------------------------
# The Generator
# --------------------------------------------------------------------------


class ClaudeGenerator:
    """Satisfies the `Generator` protocol in `contracts.py`."""

    def __init__(self, llm: LLM, emit: Emit):
        self.llm = llm
        self.emit = emit
        self._serial = 0

    def _next_id(self, prefix: str) -> str:
        self._serial += 1
        return f"{prefix}-{self._serial}"

    def _note(self, entry_id: str, heading: str, text: str) -> None:
        self.emit(
            NotebookDelta(entry_id=entry_id, author="system", heading=heading, text=text)
        )

    async def propose(
        self,
        spec: Spec,
        hypothesis: Hypothesis,
        notebook: NotebookView,
        feedback: str = "",
    ) -> list[Candidate]:
        """Build the batch for `hypothesis`.

        `feedback` is the Skeptic's reasoning about a batch it just rejected.
        When it is set this is a repair pass: the whole batch must come from
        corrected edits, so retrieval is skipped and the notebook entry says
        plainly that the reviewer sent the batch back.
        """
        n = hypothesis.batch_plan.n_candidates
        repair = bool(feedback)
        entry_id = f"n-{hypothesis.id}-generator-repair" if repair else f"n-{hypothesis.id}-generator"
        first_round = not notebook.candidates and not repair

        # Retrieval runs every round, not just the first. A hypothesis whose
        # falsification criterion names a material the campaign has not seen
        # can only be tested if that material can still enter the batch;
        # restricting retrieval to round 1 makes every such hypothesis
        # inconclusive by construction, and makes a learned heuristic like
        # "put LGPS in the batch explicitly" impossible to act on.
        retrieved: list[Candidate] = []
        where = ""
        if not repair:
            # A repair pass must answer the reviewer's specific objections, and a
            # fresh database query would just re-add candidates it already saw.
            try:
                retrieved, where = await retrieve_seeds(self.llm, spec, n, hypothesis)
            except Exception as exc:  # perturbation may still carry a later round
                log.info("retrieval produced nothing this round: %s", exc)
                if first_round:
                    raise

        known = {c.structure.strip() for c in notebook.candidates.values()}
        retrieved = [c for c in retrieved if c.structure.strip() not in known]

        # Perturbation is available in EVERY round, including the first, using
        # whatever parents exist by now — the ones just retrieved included.
        #
        # Gating this on "not the first round" was subtly wrong and cost a real
        # campaign its round 1: the Strategist's batch strategy asked for the
        # sulfide side of a controlled pair to be built by 100% O -> S
        # substitution on the oxide it had just retrieved, and because the
        # generator could only retrieve, an unrelated Li3PS4 polymorph came back
        # instead. The two barriers were then not a controlled comparison, the
        # Skeptic said so, and the verdict was INCONCLUSIVE on arrival. A
        # hypothesis whose own batch plan names a derived structure has to be
        # able to get one in the round that proposes it.
        parents = dict(notebook.candidates)
        for cand in retrieved:
            parents[cand.id] = cand

        perturbed: list[Candidate] = []
        commentary = ""
        if parents:
            perturbed, commentary = await self._perturb(
                spec, hypothesis, notebook, feedback=feedback, parents=parents
            )

        proposals = retrieved + perturbed
        if not proposals:
            self._note(
                entry_id,
                "Candidate generation — nothing viable",
                "Retrieval returned nothing new and every proposed edit failed to "
                "apply to a real parent structure, so this round has no new "
                "candidates. No structure was invented to fill the gap.",
            )
            return []

        measured_ids = {m.candidate_id for m in notebook.measurements}
        measured = [c for cid, c in notebook.candidates.items() if cid in measured_ids]
        chosen, selection_note = select_informative(proposals, measured, n)
        for cand in chosen:
            cand.hypothesis_id = hypothesis.id

        if repair:
            heading = "Candidate generation — corrected batch"
            text = (
                f"The Skeptic rejected the previous batch for this hypothesis, so the "
                f"batch was rebuilt against its objections rather than scored anyway. "
                f"{commentary.strip()} {len(chosen)} corrected candidate(s), each "
                f"applied to a real retrieved parent with ASE and carrying its parent "
                f"and operation in provenance."
            )
        else:
            kept_retrieved = [c for c in chosen if c.provenance.source == "retrieval"]
            kept_perturbed = [c for c in chosen if c.provenance.source == "perturbation"]
            how = " and ".join(
                x
                for x in (
                    "retrieval" if kept_retrieved else "",
                    "perturbation" if kept_perturbed else "",
                )
                if x
            )
            heading = f"Candidate generation — {how or 'retrieval'}"
            parts = []
            if kept_retrieved:
                parts.append(
                    f"{len(kept_retrieved)} candidate(s) retrieved: {where}. The query "
                    f"was written against this round's hypothesis, so the batch can "
                    f"reach the materials its falsification criterion names. Structures "
                    f"come from the database as retrieved; nothing here was written by a "
                    f"language model."
                )
            if kept_perturbed:
                ops = "; ".join(
                    f"{c.id} = {c.provenance.operation} on {c.provenance.parent_id}"
                    for c in kept_perturbed
                )
                parts.append(
                    f"{commentary.strip()} {len(kept_perturbed)} candidate(s) derived "
                    f"from a real parent structure with ASE ({ops}), which is what lets "
                    f"a controlled comparison be built in the same round the hypothesis "
                    f"asks for it."
                )
            text = " ".join(parts)
        if selection_note:
            text += " " + selection_note
        self._note(entry_id, heading, text)
        return chosen

    async def _perturb(
        self,
        spec: Spec,
        hypothesis: Hypothesis,
        notebook: NotebookView,
        feedback: str = "",
        parents: dict[str, Candidate] | None = None,
    ) -> tuple[list[Candidate], str]:
        """Claude proposes edits; this code applies them with ASE.

        `feedback` carries the Skeptic's vetoes from a batch it rejected, so the
        repair pass is told exactly what was wrong instead of guessing again.
        `parents` is what may be edited — the notebook's candidates plus any
        retrieved moments ago in this same round.
        """
        available = dict(notebook.candidates) if parents is None else parents
        from ..agents.base import render_notebook

        # Over-propose so the active-learning cut has something to choose from.
        want = max(hypothesis.batch_plan.n_candidates * 2, hypothesis.batch_plan.n_candidates + 2)
        parts = [
            render_notebook(notebook),
            "Parent structures you may edit this round (use these ids):\n"
            + "\n".join(
                f"  {c.id}  {c.name} ({c.formula or 'formula unknown'})  {c.repr_kind}"
                for c in available.values()
            ),
            (
                "Hypothesis under test — read this as the specification for the batch:\n"
                f"  claim: {hypothesis.statement}\n"
                f"  rationale: {hypothesis.rationale}\n"
                f"  prediction: {hypothesis.prediction}\n"
                f"  FALSIFIED IF: {hypothesis.falsification_criterion}\n"
                f"  batch strategy (execute this): {hypothesis.batch_plan.strategy}\n"
                f"  decided by these measurements: "
                f"{', '.join(hypothesis.batch_plan.properties)}\n"
                f"  batch size: {hypothesis.batch_plan.n_candidates}"
            ),
        ]
        if feedback:
            parts.append(
                "A previous batch for this same hypothesis was REJECTED by the "
                "reviewer. Read the reasons and fix them; do not re-propose a "
                "rejected candidate unchanged:\n" + feedback
            )
        parts.append(
            f"--- your task ---\n"
            f"Propose about {want} edits, so the "
            f"{hypothesis.batch_plan.n_candidates} most informative can be chosen. "
            f"Before you list them, work out which structures each clause of the "
            f"prediction and the falsification criterion refers to, and make sure "
            f"every member of every comparison is either in your list or already "
            f"measured in the notebook above. Use crystal_edits for cif parents and "
            f"molecular_edits for smiles parents; leave the other list empty."
        )
        batch = await self.llm.structured(
            EditBatch,
            system=PERTURB_SYSTEM,
            prompt="\n\n".join(parts),
            effort="high",
            max_tokens=16000,
        )

        out: list[Candidate] = []
        for edit in batch.crystal_edits:
            parent = available.get(edit.parent_id)
            if parent is None or parent.repr_kind != "cif":
                continue
            try:
                out.append(
                    apply_substitution(
                        parent,
                        edit.element_out.strip(),
                        edit.element_in.strip(),
                        edit.fraction,
                        self._next_id(f"c-{hypothesis.id}"),
                    )
                )
            except Exception as exc:  # noqa: BLE001 — a failed edit is dropped, not faked
                log.info("dropping edit on %s: %s", edit.parent_id, exc)

        for edit in batch.molecular_edits:
            parent = available.get(edit.parent_id)
            if parent is None or parent.repr_kind != "smiles":
                continue
            try:
                out.append(
                    _molecular_child(
                        parent,
                        edit.child_smiles.strip(),
                        edit.operation,
                        self._next_id(f"c-{hypothesis.id}"),
                    )
                )
            except Exception as exc:  # noqa: BLE001
                log.info("dropping molecular edit on %s: %s", edit.parent_id, exc)

        # Drop edits that reproduced an existing candidate exactly.
        known = {c.structure.strip() for c in available.values()}
        deduped = [c for c in out if c.structure.strip() not in known]
        return deduped, batch.commentary
