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

A crystalline edit is an elemental substitution on the parent lattice: which
element leaves, which element replaces it, and what fraction of its sites are
affected. Keep fractions physically reasonable (0.1 to 0.5 for aliovalent
substitutions) and keep the substituting ion's size and charge plausible for the
site it enters, or the edit is chemistry fiction even if the code can perform it.

A molecular edit is the child's SMILES plus a description of the change in
words ("replace the ester with an amide").

Every edit must be chosen because it discriminates the hypothesis under test —
say in one clause which way the measurement should move if the claim holds."""


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
    for i in indices[:count]:
        symbols[i] = element_in
    atoms.set_chemical_symbols(symbols)

    actual = count / len(indices)
    operation = (
        f"substitute {actual * 100:.0f}% {element_out} -> {element_in} "
        f"({count} of {len(indices)} sites)"
    )
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
        self, spec: Spec, hypothesis: Hypothesis, notebook: NotebookView
    ) -> list[Candidate]:
        n = hypothesis.batch_plan.n_candidates
        entry_id = f"n-{hypothesis.id}-generator"
        first_round = not notebook.candidates

        # Retrieval runs every round, not just the first. A hypothesis whose
        # falsification criterion names a material the campaign has not seen
        # can only be tested if that material can still enter the batch;
        # restricting retrieval to round 1 makes every such hypothesis
        # inconclusive by construction, and makes a learned heuristic like
        # "put LGPS in the batch explicitly" impossible to act on.
        retrieved: list[Candidate] = []
        where = ""
        try:
            retrieved, where = await retrieve_seeds(self.llm, spec, n, hypothesis)
        except Exception as exc:  # perturbation may still carry a later round
            log.info("retrieval produced nothing this round: %s", exc)
            if first_round:
                raise

        known = {c.structure.strip() for c in notebook.candidates.values()}
        retrieved = [c for c in retrieved if c.structure.strip() not in known]

        perturbed: list[Candidate] = []
        commentary = ""
        if not first_round:
            perturbed, commentary = await self._perturb(spec, hypothesis, notebook)

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

        if first_round:
            heading = "Candidate generation — retrieval"
            text = (
                f"Seeded the campaign with {len(chosen)} candidate(s): {where}. "
                f"The query was written against this round's hypothesis, so the batch "
                f"can reach the materials its falsification criterion names. "
                f"Structures come from the database as retrieved; nothing here was "
                f"written by a language model."
            )
        else:
            heading = "Candidate generation — retrieval and perturbation"
            parts = []
            if retrieved:
                parts.append(f"Retrieved {len(retrieved)} further candidate(s): {where}.")
            if perturbed:
                parts.append(
                    f"{commentary.strip()} Applied {len(perturbed)} edit(s) to retrieved "
                    f"parent structures with ASE; the parent and the exact operation are "
                    f"recorded on each candidate's provenance."
                )
            text = " ".join(parts)
        if selection_note:
            text += " " + selection_note
        self._note(entry_id, heading, text)
        return chosen

    async def _perturb(
        self, spec: Spec, hypothesis: Hypothesis, notebook: NotebookView
    ) -> tuple[list[Candidate], str]:
        from ..agents.base import render_notebook

        # Over-propose so the active-learning cut has something to choose from.
        want = max(hypothesis.batch_plan.n_candidates * 2, hypothesis.batch_plan.n_candidates + 2)
        prompt = (
            f"{render_notebook(notebook)}\n\n"
            f"Hypothesis under test:\n"
            f"  {hypothesis.statement}\n"
            f"  prediction: {hypothesis.prediction}\n"
            f"  falsified if: {hypothesis.falsification_criterion}\n"
            f"  batch strategy: {hypothesis.batch_plan.strategy}\n\n"
            f"--- your task ---\n"
            f"Propose about {want} edits to the candidates above, so the "
            f"{hypothesis.batch_plan.n_candidates} most informative can be chosen. "
            f"Use crystal_edits for cif parents and molecular_edits for smiles "
            f"parents; leave the other list empty."
        )
        batch = await self.llm.structured(
            EditBatch, system=PERTURB_SYSTEM, prompt=prompt, effort="high", max_tokens=16000
        )

        out: list[Candidate] = []
        for edit in batch.crystal_edits:
            parent = notebook.candidates.get(edit.parent_id)
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
            parent = notebook.candidates.get(edit.parent_id)
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
        known = {c.structure.strip() for c in notebook.candidates.values()}
        deduped = [c for c in out if c.structure.strip() not in known]
        return deduped, batch.commentary
