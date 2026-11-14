"""Scorer tests for molecules and porous frameworks.

Worker calls are stubbed in most tests so the suite stays fast and
deterministic; one test at the end runs a real GFN2-xTB calculation through the
worker protocol, because a mocked physics layer proves nothing about the
physics. The rest of the file is mostly about *honesty invariants*: a failure
must land in `ScoreResult.failed` rather than becoming a number, every proxy
must say so and explain itself, and no measurement may be non-finite.
"""

from __future__ import annotations

import math

import pytest

from athanor.contracts import (
    Candidate,
    Objective,
    Provenance,
    ScoreResult,
    Scorer,
    Spec,
)
from athanor.scorers import molecular
from athanor.scorers.molecular import (
    Gfn2XtbScorer,
    Odac23Scorer,
    RdkitScorer,
    RetrievalScorer,
)

PARACETAMOL = "CC(=O)NC1=CC=C(C=C1)O"

# A tiny but real periodic molecular crystal: two H2 molecules in a box.
MINI_CIF = """data_test
_cell_length_a 8.0
_cell_length_b 8.0
_cell_length_c 8.0
_cell_angle_alpha 90.0
_cell_angle_beta 90.0
_cell_angle_gamma 90.0
_symmetry_space_group_name_H-M 'P 1'
loop_
_atom_site_label
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
H1 0.0 0.0 0.0
H2 0.0925 0.0 0.0
"""


def spec_for(domain: str, prop: str) -> Spec:
    return Spec(
        goal="test",
        title="test",
        domain=domain,  # type: ignore[arg-type]
        objectives=[
            Objective(property=prop, label=prop, direction="min", unit="eV")
        ],
        seed_strategy="test",
    )


def molecule_candidate(cid: str = "c-1", smiles: str = PARACETAMOL) -> Candidate:
    return Candidate(
        id=cid,
        name="paracetamol",
        structure=smiles,
        repr_kind="smiles",
        domain="drug_stability",
        provenance=Provenance(source="retrieval", database="pubchem", external_id="1983"),
    )


def crystal_candidate(cid: str = "c-x", cif: str = MINI_CIF) -> Candidate:
    return Candidate(
        id=cid,
        name="mini crystal",
        structure=cif,
        repr_kind="cif",
        domain="drug_stability",
        provenance=Provenance(source="retrieval", database="cod", external_id="1"),
    )


# --------------------------------------------------------------------------
# Protocol conformance and registration
# --------------------------------------------------------------------------


ALL = [Gfn2XtbScorer(), Odac23Scorer(), RdkitScorer(), RetrievalScorer()]


@pytest.mark.parametrize("scorer", ALL, ids=lambda s: s.name)
def test_satisfies_the_scorer_protocol(scorer):
    assert isinstance(scorer, Scorer)
    assert scorer.name and isinstance(scorer.name, str)
    assert scorer.domains and all(
        d in ("solid_electrolyte", "mof_water", "drug_stability") for d in scorer.domains
    )
    assert scorer.properties


def test_scorers_are_in_the_shared_registry():
    from athanor.scorers.registry import all_scorers

    names = {s.name for s in all_scorers()}
    assert {"gfn2-xtb", "odac23", "rdkit", "retrieval"} <= names


def test_no_scorer_claims_to_predict_binding_affinity():
    """This project does no docking and no affinity prediction, by design."""
    for scorer in ALL:
        assert "binding_affinity" not in scorer.properties


def test_retrieval_scorer_exposes_the_seeding_hook():
    """`loop/seeds.py` duck-types on this."""
    assert callable(getattr(RetrievalScorer(), "retrieve", None))


# --------------------------------------------------------------------------
# Failure handling: the central honesty requirement
# --------------------------------------------------------------------------


async def test_unparseable_structure_fails_and_yields_no_number():
    bad = Candidate(
        id="c-bad",
        name="garbage",
        structure="this is not a cif",
        repr_kind="cif",
        domain="drug_stability",
        provenance=Provenance(source="user"),
    )
    result = await Gfn2XtbScorer().score([bad], spec_for("drug_stability", "lattice_energy"))
    assert "c-bad" in result.failed
    assert result.measurements == []


async def test_smiles_candidate_cannot_have_a_lattice_energy(monkeypatch):
    """A molecule with no crystal must fail, not get an invented packing."""
    async def fake_worker(name, request, **kwargs):
        assert request["op"] == "gap", "no lattice energy may be attempted"
        return {"homo_lumo_gap_ev": 3.69, "homo_ev": -10.1, "lumo_ev": -6.4, "method": "x"}

    monkeypatch.setattr(molecular, "run_worker", fake_worker)
    result = await Gfn2XtbScorer().score(
        [molecule_candidate()], spec_for("drug_stability", "lattice_energy")
    )
    assert "c-1" in result.failed
    assert "not a polymorph" in result.failed["c-1"]
    # The gap still came through: one failure must not suppress other work.
    assert {m.property for m in result.measurements} == {
        "homo_lumo_gap",
        "degradation_susceptibility",
    }


async def test_worker_exception_lands_in_failed_not_in_a_default(monkeypatch):
    async def boom(name, request, **kwargs):
        raise RuntimeError("tblite segfaulted")

    monkeypatch.setattr(molecular, "run_worker", boom)
    result = await Gfn2XtbScorer().score(
        [crystal_candidate()], spec_for("drug_stability", "lattice_energy")
    )
    assert result.measurements == []
    assert "tblite segfaulted" in result.failed["c-x"]


async def test_non_finite_energy_is_rejected(monkeypatch):
    async def nan_worker(name, request, **kwargs):
        if request["op"] == "lattice_energy":
            return {"lattice_energy_ev_per_molecule": float("nan"), "converged": True}
        raise RuntimeError("no gap")

    monkeypatch.setattr(molecular, "run_worker", nan_worker)
    result = await Gfn2XtbScorer().score(
        [crystal_candidate()], spec_for("drug_stability", "lattice_energy")
    )
    assert result.measurements == []
    assert "non-finite" in result.failed["c-x"]


async def test_odac_rejects_a_non_periodic_candidate():
    cand = Candidate(
        id="c-m",
        name="water",
        structure="O",
        repr_kind="smiles",
        domain="mof_water",
        provenance=Provenance(source="user"),
    )
    result = await Odac23Scorer().score([cand], spec_for("mof_water", "water_adsorption_energy"))
    assert "c-m" in result.failed
    assert result.measurements == []


# --------------------------------------------------------------------------
# Relative polymorph energy
# --------------------------------------------------------------------------


def _fake_lattice(values: dict[str, float], smiles: str = "CCO"):
    async def worker(name, request, **kwargs):
        if request["op"] != "lattice_energy":
            raise RuntimeError("only lattice energy here")
        n = len(request["atoms"]["symbols"])
        return {
            "lattice_energy_ev_per_molecule": values[n],
            "gas_reference_smiles": smiles,
            "converged": True,
            "z_total": 2,
            "supercell": [1, 1, 1],
            "method": "fake",
            "crystal_packing": {
                "symbols": ["H"], "cell": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "positions": [[0, 0, 0]], "molecules": [[0]],
            },
        }

    return worker


async def test_relative_polymorph_energy_needs_two_polymorphs(monkeypatch):
    monkeypatch.setattr(molecular, "run_worker", _fake_lattice({2: -1.0}))
    result = await Gfn2XtbScorer().score(
        [crystal_candidate("c-only")], spec_for("drug_stability", "lattice_energy")
    )
    props = {m.property for m in result.measurements}
    assert "lattice_energy" in props
    assert "relative_polymorph_energy" not in props, (
        "a relative energy with nothing to be relative to is meaningless"
    )


async def test_relative_polymorph_energy_is_zero_for_the_most_stable(monkeypatch):
    # Two "polymorphs" distinguished by atom count, same molecule.
    four_atom = MINI_CIF.replace(
        "H2 0.0925 0.0 0.0",
        "H2 0.0925 0.0 0.0\nH3 0.0 0.5 0.0\nH4 0.0925 0.5 0.0",
    )
    monkeypatch.setattr(molecular, "run_worker", _fake_lattice({2: -1.5, 4: -1.0}))
    result = await Gfn2XtbScorer().score(
        [crystal_candidate("c-stable"), crystal_candidate("c-meta", four_atom)],
        spec_for("drug_stability", "lattice_energy"),
    )
    rel = {m.candidate_id: m for m in result.measurements if m.property == "relative_polymorph_energy"}
    assert rel["c-stable"].value == pytest.approx(0.0)
    assert rel["c-meta"].value == pytest.approx(0.5 * molecular.EV_PER_KJ_MOL, rel=1e-6)
    assert rel["c-meta"].unit == "kJ/mol"
    # The reference must be named, so the number cannot be read out of context.
    assert "c-stable" in rel["c-meta"].note


# --------------------------------------------------------------------------
# ODAC: adsorption energy and the regeneration proxy
# --------------------------------------------------------------------------

FAKE_ADSORPTION = {
    "adsorption_energy_ev": -0.62,
    "host_energy_ev": -0.4,
    "n_placements_screened": 16,
    "n_relaxed": 3,
    "method": "fake odac",
    "adsorption_sites": {
        "symbols": ["C"], "cell": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        "positions": [[0, 0, 0]],
        "guests": [{"symbols": ["O", "H", "H"], "positions": [[0, 0, 0]] * 3, "energy_ev": -0.62}],
    },
    "trajectory": {
        "symbols": ["C"], "cell": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "pbc": True,
        "frames": [[[0, 0, 0]]], "energies": [-0.62],
    },
}


@pytest.fixture
def mof_candidate():
    from ase.build import nanotube

    from athanor.structure import atoms_to_cif

    tube = nanotube(10, 10, length=2)
    tube.center(vacuum=1.5, axis=(0, 1))
    tube.pbc = True
    return Candidate(
        id="c-mof",
        name="test framework",
        structure=atoms_to_cif(tube),
        repr_kind="cif",
        domain="mof_water",
        provenance=Provenance(source="retrieval", database="odac_promising_mof", external_id="X"),
    )


async def test_adsorption_energy_and_pore_geometry(monkeypatch, mof_candidate):
    async def worker(name, request, **kwargs):
        assert name == "odac" and request["op"] == "adsorption"
        return dict(FAKE_ADSORPTION)

    monkeypatch.setattr(molecular, "run_worker", worker)
    result = await Odac23Scorer(grid_spacing=0.9).score(
        [mof_candidate], spec_for("mof_water", "water_adsorption_energy")
    )
    by_prop = {m.property: m for m in result.measurements}

    ads = by_prop["water_adsorption_energy"]
    assert ads.value == pytest.approx(-0.62)
    assert ads.unit == "eV"
    assert ads.is_proxy is False  # it is the quantity actually computed
    assert "NOT water uptake" in ads.note
    # The accuracy claim must be a measured tendency, not a bound: validation
    # showed individual frameworks binding more strongly than the reference.
    assert "under-bind" in ads.note.lower()
    assert "not a bound" in ads.note.lower()
    assert "in-distribution" in ads.note.lower()

    # Geometry came through too, and is not a proxy.
    assert 0.0 <= by_prop["void_fraction"].value <= 1.0
    assert by_prop["pore_diameter"].value > 0
    assert by_prop["surface_area"].value > 0
    assert by_prop["void_fraction"].is_proxy is False
    assert "NOT a helium void fraction" in by_prop["void_fraction"].note

    kinds = {a.kind for a, _ in result.artifacts}
    assert {"void_grid", "adsorption_sites", "relaxation_trajectory"} <= kinds


async def test_regeneration_energy_is_a_labelled_proxy(monkeypatch, mof_candidate):
    async def worker(name, request, **kwargs):
        return dict(FAKE_ADSORPTION)

    monkeypatch.setattr(molecular, "run_worker", worker)
    result = await Odac23Scorer(grid_spacing=0.9).score(
        [mof_candidate], spec_for("mof_water", "regeneration_energy")
    )
    regen = next(m for m in result.measurements if m.property == "regeneration_energy")

    assert regen.is_proxy is True
    assert regen.unit == "kJ/mol"
    # Sign-flipped magnitude of the binding energy, in kJ/mol.
    assert regen.value == pytest.approx(0.62 * molecular.EV_PER_KJ_MOL, rel=1e-4)
    assert regen.confidence < 0.4
    note = regen.note.lower()
    for required in ("isosteric", "loading", "entrop", "sensible heat"):
        assert required in note, f"proxy note must explain it omits {required}"


async def test_adsorption_note_discloses_weak_ranking_and_bimodal_error(
    monkeypatch, mof_candidate
):
    """The measured rank correlation is poor; the note must not hide it.

    A screening campaign's whole purpose is to order candidates, so a scorer
    whose ordering was validated at Spearman 0.19 has to say so where the
    number is read, not only in a report.
    """
    async def worker(name, request, **kwargs):
        return dict(FAKE_ADSORPTION)

    monkeypatch.setattr(molecular, "run_worker", worker)
    result = await Odac23Scorer(grid_spacing=0.9).score(
        [mof_candidate], spec_for("mof_water", "water_adsorption_energy")
    )
    note = next(
        m.note for m in result.measurements if m.property == "water_adsorption_energy"
    )
    assert "RANKING IS UNRELIABLE" in note
    assert f"{molecular.ODAC_SPEARMAN:.2f}" in note
    assert "BIMODAL" in note
    # The regeneration proxy inherits the problem and must not claim ranking.
    regen = next(m for m in result.measurements if m.property == "regeneration_energy")
    assert "not a reliable way to rank" in regen.note.lower()


async def test_h_free_framework_is_flagged_out_of_distribution(monkeypatch):
    """The seed frameworks ship with no hydrogen; that changes the water site."""
    from ase import Atoms

    from athanor.structure import atoms_to_cif

    # Al/O/C framework with no H at all, in a roomy cell.
    skeleton = Atoms(
        "AlO4C4",
        positions=[
            [0, 0, 0], [2.0, 0, 0], [0, 2.0, 0], [0, 0, 2.0], [-2.0, 0, 0],
            [4.0, 0, 0], [0, 4.0, 0], [0, 0, 4.0], [-4.0, 0, 0],
        ],
        cell=[14.0, 14.0, 14.0],
        pbc=True,
    )
    cand = Candidate(
        id="c-noh",
        name="H-free framework",
        structure=atoms_to_cif(skeleton),
        repr_kind="cif",
        domain="mof_water",
        provenance=Provenance(source="retrieval", database="odac_promising_mof", external_id="X"),
    )

    async def worker(name, request, **kwargs):
        return dict(FAKE_ADSORPTION)

    monkeypatch.setattr(molecular, "run_worker", worker)
    result = await Odac23Scorer(grid_spacing=1.0).score(
        [cand], spec_for("mof_water", "water_adsorption_energy")
    )
    ads = next(m for m in result.measurements if m.property == "water_adsorption_energy")
    assert ads.ood_flag is True
    assert "no hydrogen" in ads.note.lower()
    assert ads.confidence < 0.5


async def test_no_scorer_ever_emits_water_uptake(monkeypatch, mof_candidate):
    async def worker(name, request, **kwargs):
        return dict(FAKE_ADSORPTION)

    monkeypatch.setattr(molecular, "run_worker", worker)
    result = await Odac23Scorer(grid_spacing=0.9).score(
        [mof_candidate], spec_for("mof_water", "water_adsorption_energy")
    )
    assert "water_uptake" not in {m.property for m in result.measurements}
    assert "water_uptake" not in Odac23Scorer().properties


async def test_pore_failure_does_not_block_adsorption(monkeypatch, mof_candidate):
    """A geometry failure is recorded separately from the energy."""
    from athanor import pores

    def boom(*a, **k):
        raise pores.PoreError("grid too large")

    monkeypatch.setattr(pores, "analyze", boom)

    async def worker(name, request, **kwargs):
        return dict(FAKE_ADSORPTION)

    monkeypatch.setattr(molecular, "run_worker", worker)
    result = await Odac23Scorer(grid_spacing=0.9).score(
        [mof_candidate], spec_for("mof_water", "water_adsorption_energy")
    )
    assert "c-mof:pores" in result.failed
    assert any(m.property == "water_adsorption_energy" for m in result.measurements)


# --------------------------------------------------------------------------
# RDKit
# --------------------------------------------------------------------------


async def test_rdkit_descriptors_on_a_real_molecule():
    result = await RdkitScorer().score(
        [molecule_candidate()], spec_for("drug_stability", "solubility_logs")
    )
    assert result.failed == {}
    by_prop = {m.property: m for m in result.measurements}

    assert by_prop["molecular_weight"].value == pytest.approx(151.165, abs=0.01)
    assert by_prop["tpsa"].value == pytest.approx(49.33, abs=0.1)
    assert by_prop["rotatable_bonds"].value == pytest.approx(1.0)
    # Exact graph arithmetic is not a proxy; cLogP is.
    assert by_prop["molecular_weight"].is_proxy is False
    assert by_prop["logp"].is_proxy is True


async def test_solubility_is_marked_as_a_proxy_and_explains_the_polymorph_blindness():
    result = await RdkitScorer().score(
        [molecule_candidate()], spec_for("drug_stability", "solubility_logs")
    )
    sol = next(m for m in result.measurements if m.property == "solubility_logs")
    assert sol.is_proxy is True
    assert sol.confidence <= 0.35
    assert "Delaney" in str(sol.method)
    note = sol.note.lower()
    assert "polymorph" in note, "must say it cannot rank polymorphs"
    assert "not a solubility measurement" in note


async def test_synthetic_accessibility_is_a_proxy_in_range():
    result = await RdkitScorer().score(
        [molecule_candidate()], spec_for("drug_stability", "synthetic_accessibility")
    )
    sa = next(m for m in result.measurements if m.property == "synthetic_accessibility")
    assert 1.0 <= sa.value <= 10.0
    assert sa.is_proxy is True


async def test_rdkit_bad_smiles_fails_cleanly():
    bad = molecule_candidate("c-bad", "not))a((smiles")
    result = await RdkitScorer().score([bad], spec_for("drug_stability", "logp"))
    assert "c-bad" in result.failed
    assert result.measurements == []


# --------------------------------------------------------------------------
# Cross-cutting invariants
# --------------------------------------------------------------------------


async def test_every_proxy_explains_itself(monkeypatch, mof_candidate):
    async def worker(name, request, **kwargs):
        if request["op"] == "adsorption":
            return dict(FAKE_ADSORPTION)
        raise RuntimeError("n/a")

    monkeypatch.setattr(molecular, "run_worker", worker)
    results: list[ScoreResult] = [
        await Odac23Scorer(grid_spacing=0.9).score(
            [mof_candidate], spec_for("mof_water", "regeneration_energy")
        ),
        await RdkitScorer().score(
            [molecule_candidate()], spec_for("drug_stability", "solubility_logs")
        ),
    ]
    seen_proxy = False
    for result in results:
        for m in result.measurements:
            assert math.isfinite(m.value), f"{m.property} is not finite"
            assert 0.0 <= m.confidence <= 1.0
            if m.is_proxy:
                seen_proxy = True
                assert m.note and len(m.note) > 80, (
                    f"{m.property}: a proxy must say what it stands for and why it "
                    f"is imperfect"
                )
                assert "proxy" in m.note.lower()
    assert seen_proxy


# --------------------------------------------------------------------------
# One real calculation through the real worker
# --------------------------------------------------------------------------


async def test_crystal_candidate_gets_a_gap_from_the_gas_reference(monkeypatch):
    """Campaign 3's seeds are all CIFs, so the gap must reach them too.

    A periodic cell's Gamma-point orbitals are not the molecular gap, so the
    gap comes from the relaxed gas-phase reference that the lattice-energy
    calculation already builds.
    """
    async def worker(name, request, **kwargs):
        assert request["op"] == "lattice_energy"
        return {
            "lattice_energy_ev_per_molecule": -1.14,
            "gas_reference_smiles": "[NH3+]CC(=O)[O-]",
            "gas_reference_zwitterionic": True,
            "homo_lumo_gap_ev": 4.755,
            "homo_ev": -11.0,
            "lumo_ev": -6.245,
            "converged": True,
            "z_total": 16,
            "supercell": [2, 2, 2],
            "method": "fake",
        }

    monkeypatch.setattr(molecular, "run_worker", worker)
    result = await Gfn2XtbScorer().score(
        [crystal_candidate("c-gly")], spec_for("drug_stability", "lattice_energy")
    )
    by_prop = {m.property: m for m in result.measurements}
    assert by_prop["homo_lumo_gap"].value == pytest.approx(4.755)
    assert "SAME value" in by_prop["homo_lumo_gap"].note
    assert by_prop["degradation_susceptibility"].is_proxy is True

    # A zwitterionic gas reference makes the absolute lattice energy unreliable,
    # and the note has to say so.
    assert "ZWITTERION" in by_prop["lattice_energy"].note


async def test_rdkit_gets_the_right_molecule_out_of_a_real_cif():
    """A molecule split across the cell boundary must be unwrapped, not
    bond-perceived as a flat XYZ of the whole cell (which fails outright)."""
    from athanor import retrieval

    expected = {"4513002": 75.07, "2104364": 151.16, "7126911": 180.16}
    for cod_id, mw in expected.items():
        record = retrieval.fetch("cod", cod_id)
        cand = Candidate(
            id=f"c-{cod_id}",
            name=f"COD {cod_id}",
            structure=str(record.structure),
            repr_kind="cif",
            domain="drug_stability",
            provenance=Provenance(source="retrieval", database="cod", external_id=cod_id),
        )
        result = await RdkitScorer().score(
            [cand], spec_for("drug_stability", "molecular_weight")
        )
        assert result.failed == {}, result.failed
        got = next(m for m in result.measurements if m.property == "molecular_weight")
        assert got.value == pytest.approx(mw, abs=0.05)


async def test_relative_polymorph_note_states_the_resolution_limit(monkeypatch):
    four_atom = MINI_CIF.replace(
        "H2 0.0925 0.0 0.0",
        "H2 0.0925 0.0 0.0\nH3 0.0 0.5 0.0\nH4 0.0925 0.5 0.0",
    )
    monkeypatch.setattr(molecular, "run_worker", _fake_lattice({2: -1.5, 4: -1.0}))
    result = await Gfn2XtbScorer().score(
        [crystal_candidate("c-a"), crystal_candidate("c-b", four_atom)],
        spec_for("drug_stability", "lattice_energy"),
    )
    rel = next(m for m in result.measurements if m.property == "relative_polymorph_energy")
    assert rel.confidence <= 0.35, "an inverted ordering cannot be high confidence"
    note = rel.note.lower()
    assert "resolution limit" in note
    assert "inverted" in note


async def test_real_gfn2_xtb_water_energy_through_the_worker():
    """Guards the worker protocol and the physics together.

    GFN2-xTB on H2O is -137.9678 eV; a drift here means the environment or the
    method changed, which would invalidate every polymorph comparison.
    """
    from ase.build import molecule as ase_molecule

    from athanor.structure import atoms_to_dict
    from athanor.workers.base import run_worker

    payload = atoms_to_dict(ase_molecule("H2O"))
    energy = await run_worker("xtb", {"op": "energy", "atoms": payload}, timeout=300)
    assert energy["energy_ev"] == pytest.approx(-137.9678, abs=1e-3)

    gap = await run_worker("xtb", {"op": "gap", "atoms": payload}, timeout=300)
    assert gap["homo_lumo_gap_ev"] > 0
    assert gap["homo_ev"] < gap["lumo_ev"]
    # Determinism: the same request must give the same number.
    again = await run_worker("xtb", {"op": "energy", "atoms": payload}, timeout=300)
    assert again["energy_ev"] == energy["energy_ev"]
