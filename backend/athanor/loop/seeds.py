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
import os

from pydantic import BaseModel, Field

from ..contracts import Candidate, Provenance, Spec
from ..llm import LLM
from ..structure import atoms_to_cif, reduced_formula
from .router import retrieval_scorer

log = logging.getLogger("athanor.seeds")

MAX_ATOMS = 48  # keep a NEB supercell tractable on a laptop CPU


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
first candidates. You do not invent structures — you name real chemical systems
or real compounds that a structural database will be queried for.

For a crystalline domain, give hyphenated element systems ('Li-P-S', 'Li-La-Zr-O')
that a Materials Project query can resolve, ordered by how promising they are.
For a molecular domain, give compound names that PubChem can resolve.

Fill in only the list that fits the domain; leave the other empty. Choose
systems that are genuinely known to contain the behaviour the goal asks for —
not aspirational ones."""


async def propose_seed_query(llm: LLM, spec: Spec, n: int) -> SeedQuery:
    from ..agents.base import render_spec

    kind = "molecular" if spec.domain == "drug_stability" else "crystalline"
    return await llm.structured(
        SeedQuery,
        system=SEED_SYSTEM,
        prompt=(
            f"{render_spec(spec)}\n\n"
            f"--- your task ---\n"
            f"This is a {kind} domain. Name enough chemical systems or compounds to "
            f"yield about {n} distinct seed candidates."
        ),
        effort="high",
        max_tokens=8000,
    )


def _mp_seeds(chemical_systems: list[str], n: int, domain: str) -> list[Candidate]:
    """Near-hull phases from Materials Project, smallest cells first."""
    from mp_api.client import MPRester
    from pymatgen.io.ase import AseAtomsAdaptor

    key = os.environ.get("MP_API_KEY")
    if not key:
        raise RuntimeError("MP_API_KEY is not set, so Materials Project cannot be queried")

    found: list[dict] = []
    with MPRester(key) as mpr:
        for chemsys in chemical_systems[:6]:
            try:
                docs = mpr.materials.summary.search(
                    chemsys=chemsys,
                    fields=["material_id", "formula_pretty", "energy_above_hull", "structure"],
                )
            except Exception as exc:  # noqa: BLE001 — one bad system must not end the query
                log.warning("Materials Project query failed for %s: %s", chemsys, exc)
                continue
            docs = [d for d in docs if len(d.structure) <= MAX_ATOMS]
            docs.sort(key=lambda d: (float(d.energy_above_hull), len(d.structure)))
            for d in docs[:2]:
                found.append(
                    {
                        "mp_id": str(d.material_id),
                        "formula": d.formula_pretty,
                        "hull": float(d.energy_above_hull),
                        "atoms": AseAtomsAdaptor.get_atoms(d.structure),
                    }
                )

    seen: set[str] = set()
    unique: list[dict] = []
    for s in sorted(found, key=lambda s: (s["hull"], s["mp_id"])):
        if s["mp_id"] not in seen:
            seen.add(s["mp_id"])
            unique.append(s)

    out: list[Candidate] = []
    for s in unique[:n]:
        atoms = s["atoms"]
        out.append(
            Candidate(
                id=f"c-{s['mp_id']}",
                name=s["formula"],
                formula=reduced_formula(atoms),
                structure=atoms_to_cif(atoms),
                repr_kind="cif",
                domain=domain,  # type: ignore[arg-type]
                provenance=Provenance(
                    source="retrieval",
                    database="materials_project",
                    external_id=s["mp_id"],
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


async def retrieve_seeds(llm: LLM, spec: Spec, n: int) -> tuple[list[Candidate], str]:
    """Return `(candidates, a sentence saying where they came from)`.

    Raises if no honest source exists for the domain — the caller turns that
    into a non-fatal `CampaignError` rather than fabricating candidates.
    """
    scorer = retrieval_scorer()
    if scorer is not None:
        candidates = list(await scorer.retrieve(spec, n))
        return candidates[:n], f"retrieved from the registry's {scorer.name} scorer"

    query = await propose_seed_query(llm, spec, n)
    if spec.domain == "drug_stability":
        if not query.compound_names:
            raise RuntimeError("no compound names proposed, so PubChem cannot be queried")
        seeds = _pubchem_seeds(query.compound_names, n, spec.domain)
        where = (
            "canonical SMILES retrieved from PubChem for "
            f"{len(seeds)} of the proposed compounds"
        )
    elif spec.domain == "solid_electrolyte":
        if not query.chemical_systems:
            raise RuntimeError("no chemical systems proposed, so Materials Project cannot be queried")
        seeds = _mp_seeds(query.chemical_systems, n, spec.domain)
        where = (
            "near-hull phases retrieved from Materials Project in "
            f"{', '.join(query.chemical_systems[:6])}"
        )
    else:
        raise RuntimeError(
            f"no retrieval source is available for domain {spec.domain!r}; register a "
            "retrieval scorer exposing `retrieve(spec, n)`"
        )

    if not seeds:
        raise RuntimeError("the retrieval query returned no usable structures")
    return seeds, where
