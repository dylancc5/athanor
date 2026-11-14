"""Where the first candidates of a campaign come from.

Order of preference:

1. A **retrieval scorer** in the registry (duck-typed `retrieve(spec, n)`).
   That is the right home for retrieval, and as soon as it exists this module
   gets out of the way.
2. A **direct database lookup** — Materials Project for crystals, PubChem for
   molecules — seeded by chemical systems or compound names that Claude
   proposes. Claude chooses *where to look*; the structure itself always comes
   from the database.
3. Nothing. The campaign records a `CampaignError` for the stage and carries on
   with no candidates.

What this module never does is let a model write a structure. A CIF produced by
an LLM is a hallucinated crystal, and every number computed from it would be
fiction dressed as physics.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from ..contracts import Candidate, Hypothesis, Provenance, Spec
from ..llm import LLM
from ..structure import atoms_to_cif, reduced_formula
from .router import retrieval_scorer

log = logging.getLogger("athanor.seeds")

#: Upper bound on a retrieved cell, to avoid pulling down absurd structures.
#: Deliberately generous and deliberately NOT a compute budget: whether a cell
#: is too big for a CI-NEB is the scorer's call (`AtomisticScorer.neb_max_atoms`),
#: and it reports "not attempted" honestly when it is. A tight cap here instead
#: silently removes materials from the search — a 48-atom cap excluded
#: Li10GeP2S12 (50 sites) from a campaign whose hypothesis was explicitly about
#: it, which cost a round and surfaced as an inconclusive verdict with no
#: indication that the arm had never been reachable.
MAX_ATOMS = 220


class SeedQuery(BaseModel):
    """Where to look, not what to invent."""

    chemical_systems: list[str] = Field(
        description="for crystals: hyphenated element systems, e.g. 'Li-P-S'"
    )
    compound_names: list[str] = Field(
        description="for molecules: common or IUPAC names resolvable in PubChem"
    )
    reasoning: str


SEED_SYSTEM = """\
You are choosing where an autonomous discovery platform should look for its
candidates. You do not invent structures — you name real chemical systems or
real compounds that a structural database will be queried for.

For a crystalline domain, give hyphenated element systems ('Li-P-S', 'Li-Ge-P-S',
'Li-La-Zr-O') that a Materials Project query can resolve, ordered by how
promising they are. For a molecular domain, give compound names that PubChem can
resolve.

Fill in only the list that fits the domain; leave the other empty. Choose
systems that are genuinely known to contain the behaviour the goal asks for —
not aspirational ones.

When a hypothesis is given, the query exists to test THAT hypothesis, and this
is the step where it succeeds or fails. Every arm the hypothesis names must be
reachable from the systems you list: if the claim compares two specific
materials, list the chemical system of each one, including the elements that
only one of them contains. A query that cannot return the materials the
falsification criterion is written about guarantees an inconclusive round, no
matter how good the rest of the campaign is."""


async def propose_seed_query(
    llm: LLM, spec: Spec, n: int, hypothesis: Hypothesis | None = None
) -> SeedQuery:
    """Ask Claude which chemical systems to query.

    The hypothesis is passed in deliberately. Without it the query can only
    reflect the spec, and a hypothesis whose falsification criterion names
    particular materials gets a batch that cannot test it — which is an
    inconclusive verdict decided before any compute was spent.
    """
    from ..agents.base import render_spec

    kind = "molecular" if spec.domain == "drug_stability" else "crystalline"
    parts = [render_spec(spec)]
    if hypothesis is not None:
        parts.append(
            "The hypothesis this batch must be able to test:\n"
            f"  claim: {hypothesis.statement}\n"
            f"  prediction: {hypothesis.prediction}\n"
            f"  FALSIFIED IF: {hypothesis.falsification_criterion}\n"
            f"  batch strategy: {hypothesis.batch_plan.strategy}"
        )
    parts.append(
        f"--- your task ---\n"
        f"This is a {kind} domain. Name enough chemical systems or compounds to "
        f"yield about {n} distinct candidates"
        + (
            ", and make sure every material named in the claim, the prediction and "
            "the falsification criterion is reachable from the systems you list."
            if hypothesis is not None
            else "."
        )
    )
    return await llm.structured(
        SeedQuery,
        system=SEED_SYSTEM,
        prompt="\n\n".join(parts),
        effort="high",
        max_tokens=8000,
    )


def _stability_key(entry) -> tuple[float, str]:
    """Most stable first; ties broken on id so a recorded campaign replays."""
    hull = entry.energy_above_hull
    return (hull if hull is not None else 1e9, entry.material_id)


async def _mp_seeds(
    chemical_systems: list[str], n: int, domain: str, spec: Spec
) -> list[Candidate]:
    """Near-hull phases from Materials Project, via the shared cached helper.

    `athanor.mp` does the filtering server-side, caches to disk and orders
    deterministically, which is what makes a recorded campaign replayable.
    """
    from .. import mp

    excluded: list[str] = []
    for constraint in spec.constraints:
        if constraint.property == "elements" and constraint.op == "not_in":
            value = constraint.value
            if isinstance(value, list):
                excluded.extend(str(v) for v in value)

    per_system: list[list] = []
    seen: set[str] = set()
    for chemsys in chemical_systems[:6]:
        try:
            found = await mp.asearch_near_hull(
                chemsys=chemsys,
                exclude_elements=excluded or None,
                max_atoms=MAX_ATOMS,
                limit=3,
                with_structures=True,
            )
        except Exception as exc:  # noqa: BLE001 — one bad system must not end the query
            log.warning("Materials Project query failed for %s: %s", chemsys, exc)
            continue
        usable = []
        for entry in found:
            if entry.material_id not in seen and entry.structure is not None:
                seen.add(entry.material_id)
                usable.append(entry)
        usable.sort(key=_stability_key)
        if usable:
            per_system.append(usable)

    # Round-robin across the systems, not a single global sort by stability.
    # The systems are the arms of the hypothesis, and one arm is usually nearer
    # the hull than the other: a global sort fills the whole batch from the
    # stable arm and silently drops the comparison the falsification criterion
    # is written about. Taking the best of each system first guarantees every
    # arm is represented, and only then are the remaining slots filled by
    # stability.
    entries: list = []
    for rank in range(max((len(x) for x in per_system), default=0)):
        tier = [group[rank] for group in per_system if rank < len(group)]
        tier.sort(key=_stability_key)
        entries.extend(tier)

    out: list[Candidate] = []
    for entry in entries[:n]:
        atoms = entry.atoms()
        out.append(
            Candidate(
                id=f"c-{entry.material_id}",
                name=entry.formula_pretty,
                formula=reduced_formula(atoms),
                structure=atoms_to_cif(atoms),
                repr_kind="cif",
                domain=domain,  # type: ignore[arg-type]
                provenance=Provenance(
                    source="retrieval",
                    database="materials_project",
                    external_id=entry.material_id,
                ),
            )
        )
    return out


def _pubchem_seeds(names: list[str], n: int, domain: str) -> list[Candidate]:
    """Canonical SMILES for named compounds, straight from PubChem."""
    import pubchempy

    out: list[Candidate] = []
    seen: set[str] = set()
    for name in names[:12]:
        if len(out) >= n:
            break
        try:
            hits = pubchempy.get_compounds(name, "name")
        except Exception as exc:  # noqa: BLE001
            log.warning("PubChem lookup failed for %r: %s", name, exc)
            continue
        if not hits:
            continue
        compound = hits[0]
        # PubChem has renamed these fields over time; take whichever exists.
        smiles = next(
            (
                getattr(compound, attr, None)
                for attr in ("canonical_smiles", "connectivity_smiles", "isomeric_smiles", "smiles")
                if getattr(compound, attr, None)
            ),
            None,
        )
        cid = getattr(compound, "cid", None)
        if not smiles or cid is None or str(cid) in seen:
            continue
        seen.add(str(cid))
        out.append(
            Candidate(
                id=f"c-cid{cid}",
                name=name,
                formula=getattr(compound, "molecular_formula", None),
                structure=smiles,
                repr_kind="smiles",
                domain=domain,  # type: ignore[arg-type]
                provenance=Provenance(
                    source="retrieval",
                    database="pubchem",
                    external_id=f"CID{cid}",
                ),
            )
        )
    return out


async def retrieve_seeds(
    llm: LLM, spec: Spec, n: int, hypothesis: Hypothesis | None = None
) -> tuple[list[Candidate], str]:
    """Return `(candidates, a sentence saying where they came from)`.

    Raises if no honest source exists for the domain — the caller turns that
    into a non-fatal `CampaignError` rather than fabricating candidates.
    """
    scorer = retrieval_scorer(spec.domain)
    if scorer is not None:
        candidates = list(await scorer.retrieve(spec, n))
        return candidates[:n], f"retrieved from the registry's {scorer.name} scorer"

    query = await propose_seed_query(llm, spec, n, hypothesis)
    if spec.domain == "drug_stability":
        if not query.compound_names:
            raise RuntimeError("no compound names proposed, so PubChem cannot be queried")
        seeds = _pubchem_seeds(query.compound_names, n, spec.domain)
        where = (
            "canonical SMILES retrieved from PubChem for "
            f"{len(seeds)} of the proposed compounds"
        )
    elif spec.domain in ("solid_electrolyte", "mof_water"):
        if not query.chemical_systems:
            raise RuntimeError(
                "no chemical systems proposed, so Materials Project cannot be queried"
            )
        seeds = await _mp_seeds(query.chemical_systems, n, spec.domain, spec)
        where = (
            "near-hull phases retrieved from Materials Project in "
            f"{', '.join(query.chemical_systems[:6])}"
        )
        if spec.domain == "mof_water":
            where += (
                " — note that Materials Project covers inorganic frameworks far better "
                "than metal-organic ones, so this seed set is a weak sample of the real "
                "MOF space and the campaign should be read accordingly"
            )
    else:
        raise RuntimeError(
            f"no retrieval source is available for domain {spec.domain!r}; register a "
            "retrieval scorer exposing `retrieve(spec, n)`"
        )

    if not seeds:
        raise RuntimeError("the retrieval query returned no usable structures")
    return seeds, where
