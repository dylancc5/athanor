"""The atomistic scorer and Materials Project access.

No real MACE and no real network here: `run_worker` and the MP fetch are both
faked, so these tests check the *contract* — which measurements appear, which
flags they carry, what the artifact payloads look like, and above all that an
unmeasurable property is reported as missing rather than invented. The physics
itself is validated by a real run (see the agent's report), not by pytest.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
from ase.build import bulk

from athanor import mp, ood
from athanor.contracts import Candidate, Objective, Provenance, Scorer, Spec
from athanor.scorers import atomistic, registry
from athanor.scorers.atomistic import AtomisticScorer
from athanor.structure import atoms_to_cif, atoms_to_dict

# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

SPEC = Spec(
    goal="Find a solid-state lithium electrolyte with a low Li migration barrier.",
    title="Solid-state Li conductor",
    domain="solid_electrolyte",
    objectives=[
        Objective(property="migration_barrier", label="Barrier", direction="min", unit="eV")
    ],
    seed_strategy="Materials Project near-hull Li phases",
)


def li_cl_crystal():
    """Rock-salt LiCl: clean geometry, two+ Li sites, known elements."""
    return bulk("LiCl", crystalstructure="rocksalt", a=5.14, cubic=True)


def make_candidate(atoms=None, **provenance) -> Candidate:
    atoms = li_cl_crystal() if atoms is None else atoms
    prov = {
        "source": "retrieval",
        "database": "materials_project",
        "external_id": "mp-22905",
    }
    prov.update(provenance)
    return Candidate(
        id="c-1",
        name="LiCl",
        formula="LiCl",
        structure=atoms_to_cif(atoms),
        repr_kind="cif",
        domain="solid_electrolyte",
        provenance=Provenance(**prov),
    )


def fake_entry(**over) -> mp.MPEntry:
    d = {
        "material_id": "mp-22905",
        "formula_pretty": "LiCl",
        "chemsys": "Cl-Li",
        "elements": ("Cl", "Li"),
        "n_sites": 8,
        "energy_above_hull": 0.0,
        "band_gap": 6.2731,
        "energy_per_atom": -3.5,
        "uncorrected_energy_per_atom": -3.9,
        "is_stable": True,
        "theoretical": False,
        "structure": None,
    }
    d.update(over)
    return mp.MPEntry(**d)


def fake_relax(atoms, *, n=None, converged=True, max_force=0.03, drop=0.08):
    n = n or len(atoms)
    positions = atoms_to_dict(atoms)["positions"]
    return {
        "energy_ev": -4.0 * n,
        "energy_per_atom": -4.0,
        "initial_energy_ev": -4.0 * n + drop,
        "relaxation_drop_ev": drop,
        "max_displacement_A": 0.021,
        "rms_displacement_A": 0.008,
        "relax_cell": False,
        "max_force": max_force,
        "steps_taken": 12,
        "converged": converged,
        "n_atoms": n,
        "atoms": atoms_to_dict(atoms),
        "trajectory": {
            "symbols": atoms_to_dict(atoms)["symbols"],
            "cell": atoms_to_dict(atoms)["cell"],
            "pbc": True,
            "frames": [positions, positions],
            "energies": [-4.0 * n + drop, -4.0 * n],
            "cells": None,
        },
    }


def fake_neb(atoms, *, barrier=0.28, converged=True):
    d = atoms_to_dict(atoms)
    return {
        "barrier_ev": barrier,
        "forward_barrier_ev": barrier,
        "reverse_barrier_ev": barrier - 0.01,
        "endpoint_asymmetry_ev": 0.004,
        "hop_distance_A": 3.63,
        "energies": [0.0, barrier, 0.0],
        "converged": converged,
        "n_atoms": len(atoms) - 1,
        "n_images": 9,
        "steps": 200,
        "supercell": [2, 2, 2],
        "species": "Li",
        "method": "CI-NEB, 9 images, vacancy-mediated Li hop, MACE-MP-0 (medium), fmax 0.05 eV/A",
        "path": {
            "symbols": d["symbols"],
            "cell": d["cell"],
            "pbc": True,
            "frames": [d["positions"], d["positions"], d["positions"]],
            "energies": [0.0, barrier, 0.0],
            "mobile_index": 0,
            "barrier_ev": barrier,
        },
    }


# Energies (eV/atom) for the fake Li-Cl hull. LiCl's formation energy comes out
# at -4.0 - (0.5*-2.0 + 0.5*-1.0) = -2.5 eV/atom, so LiCl sits ON the hull, and
# a candidate LiCl at the same -4.0 eV/atom must score exactly 0.0 above it.
HULL_ENERGIES = {"mp-li-GGA": -2.0, "mp-cl-GGA": -1.0, "mp-licl-GGA": -4.0}


def fake_phases():
    return {
        "phases": [
            {
                "entry_id": "mp-li-GGA",
                "material_id": "mp-li",
                "formula_pretty": "Li",
                "composition": {"Li": 1.0},
                "n_sites": 1,
                "structure": atoms_to_dict(bulk("Li", "bcc", a=3.44)),
            },
            {
                "entry_id": "mp-cl-GGA",
                "material_id": "mp-cl",
                "formula_pretty": "Cl",
                "composition": {"Cl": 1.0},
                "n_sites": 1,
                "structure": atoms_to_dict(bulk("Cl", "sc", a=3.0)),
            },
            {
                "entry_id": "mp-licl-GGA",
                "material_id": "mp-licl",
                "formula_pretty": "LiCl",
                "composition": {"Li": 4.0, "Cl": 4.0},
                "n_sites": 8,
                "structure": atoms_to_dict(li_cl_crystal()),
            },
        ],
        "skipped_large": 0,
        "skipped_no_structure": 0,
        "total": 3,
        "elements": ["Cl", "Li"],
        "max_atoms": 80,
    }


@pytest.fixture
def worker(monkeypatch):
    """Intercept every worker call; record the requests for assertions."""
    calls: list[dict] = []
    behaviour: dict[str, object] = {}

    async def fake_run_worker(name, request, *, timeout=1800.0):
        assert name == "mace"
        calls.append(request)
        op = request["op"]
        if op in behaviour and isinstance(behaviour[op], Exception):
            raise behaviour[op]
        if op == "relax_many":
            energies = behaviour.get("hull_energies", HULL_ENERGIES)
            results = []
            for item in request["structures"]:
                label = item["label"]
                if label in energies:
                    results.append(
                        {
                            "label": label,
                            "energy_per_atom": energies[label],
                            "n_atoms": len(item["atoms"]["symbols"]),
                            "converged": True,
                            "max_force": 0.01,
                        }
                    )
                else:
                    results.append({"label": label, "error": "RuntimeError: diverged"})
            return {
                "results": results,
                "n_ok": sum(1 for r in results if "energy_per_atom" in r),
                "n_failed": sum(1 for r in results if "error" in r),
            }
        from athanor.structure import dict_to_atoms

        atoms = dict_to_atoms(request["atoms"])
        if op == "relax":
            return behaviour.get("relax_result") or fake_relax(atoms)
        if op == "neb":
            return behaviour.get("neb_result") or fake_neb(atoms)
        raise AssertionError(f"unexpected op {op}")

    monkeypatch.setattr("athanor.scorers.atomistic.run_worker", fake_run_worker)
    return type("W", (), {"calls": calls, "behaviour": behaviour})()


@pytest.fixture(autouse=True)
def hull_ok(monkeypatch, tmp_path):
    """Competing phases for the fake hull, plus an isolated hull cache dir.

    Autouse so no test can silently reach the real Materials Project.
    """
    monkeypatch.setattr(atomistic, "HULL_CACHE_DIR", tmp_path / "hull")

    async def acompeting_phases(elements, *, max_atoms=80):
        return fake_phases()

    monkeypatch.setattr("athanor.mp.acompeting_phases", acompeting_phases)


@pytest.fixture
def mp_ok(monkeypatch):
    async def aget_entry(material_id, *, with_structure=True):
        return fake_entry(material_id=material_id)

    monkeypatch.setattr("athanor.mp.aget_entry", aget_entry)


# --------------------------------------------------------------------------
# Scorer shape
# --------------------------------------------------------------------------


def test_scorer_satisfies_the_protocol():
    scorer = AtomisticScorer()
    assert isinstance(scorer, Scorer)
    assert scorer.name == "mace-mp-0"
    assert scorer.domains == ("solid_electrolyte", "mof_water")
    for prop in ("energy_per_atom", "migration_barrier", "energy_above_hull"):
        assert prop in scorer.properties


def test_the_objective_vocabulary_excludes_retrieval_only_properties():
    """`properties` feeds the intake agent's objective vocabulary, and
    `pareto.rank()` drops any candidate missing an objective. So a property that
    only a retrieved candidate can have must not appear there, or every invented
    candidate silently vanishes from the frontier.

    Both excluded keys are still measured — see `extra_properties`.
    """
    scorer = AtomisticScorer()
    assert "band_gap" not in scorer.properties
    assert "energy_above_hull_dft" not in scorer.properties
    assert set(scorer.extra_properties) == {"band_gap", "energy_above_hull_dft"}
    # What remains must be computable for a candidate with no database record.
    assert "migration_barrier" in scorer.properties
    assert "energy_above_hull" in scorer.properties
    assert not set(scorer.properties) & set(scorer.extra_properties)


async def test_every_objective_property_is_measurable_for_an_invented_candidate(worker, mp_ok):
    """The guarantee behind the vocabulary split, checked end to end."""
    candidate = make_candidate(
        source="perturbation", parent_id="c-0", external_id=None, database=None
    )
    result = await AtomisticScorer().score([candidate], SPEC)
    measured = {m.property for m in result.measurements}
    missing = set(AtomisticScorer().properties) - measured
    assert not missing, f"invented candidate is missing objective-eligible {missing}"


async def test_full_solid_electrolyte_scoring(worker, mp_ok):
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    by_prop = {m.property: m for m in result.measurements}

    assert set(by_prop) == {
        "energy_per_atom",
        "relaxation_drop",
        "relaxation_displacement",
        "migration_barrier",
        "energy_above_hull",
        "energy_above_hull_dft",
        "band_gap",
    }
    assert not result.failed

    # Provenance of every number is explicit.
    assert by_prop["energy_per_atom"].source == "mace-mp-0"
    # The Pareto-eligible hull value is MACE's; MP's DFT one sits beside it.
    assert by_prop["energy_above_hull"].source == "mace-mp-0"
    assert by_prop["energy_above_hull_dft"].source == "materials_project"
    assert by_prop["band_gap"].source == "materials_project"

    e = by_prop["energy_per_atom"]
    assert e.value == -4.0
    assert e.unit == "eV/atom"
    assert e.confidence == 0.75
    assert not e.ood_flag
    assert not e.is_proxy
    assert "MACE-MP-0" in e.method and "fmax" in e.method

    # relaxation_drop is per atom, not total, so cell size cannot inflate it.
    assert by_prop["relaxation_drop"].unit == "eV/atom"
    assert by_prop["relaxation_drop"].value == pytest.approx(0.08 / 8, abs=1e-6)
    assert by_prop["relaxation_displacement"].unit == "A"
    assert by_prop["relaxation_displacement"].value == 0.021


async def test_band_gap_is_an_honest_proxy(worker, mp_ok):
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    gap = next(m for m in result.measurements if m.property == "band_gap")
    assert gap.is_proxy is True
    assert gap.value == 6.273
    # A proxy must say what it stands in for, and that GGA underestimates.
    assert "electrochemical stability window" in gap.note
    assert "underestimate" in gap.note
    assert gap.confidence < 0.95

    hull = next(m for m in result.measurements if m.property == "energy_above_hull_dft")
    assert hull.is_proxy is False
    assert hull.confidence == 0.95
    assert "not computed here" in hull.note


async def test_barrier_carries_method_and_endpoint_asymmetry(worker, mp_ok):
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    bar = next(m for m in result.measurements if m.property == "migration_barrier")
    assert bar.value == 0.28
    assert bar.unit == "eV"
    assert bar.is_proxy is False
    assert "CI-NEB" in bar.method
    assert "vacancy-mediated" in bar.method
    assert "endpoint asymmetry 0.004 eV" in bar.note
    assert "largest climb" in bar.note


async def test_unconverged_neb_sets_ood_flag(worker, mp_ok):
    worker.behaviour["neb_result"] = fake_neb(li_cl_crystal(), converged=False)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    bar = next(m for m in result.measurements if m.property == "migration_barrier")
    assert bar.ood_flag is True
    assert "did NOT converge" in bar.note
    # An unconverged band is not a bound in either direction, and must not
    # claim to be one.
    assert "may be either higher or lower" in bar.note
    assert "not a\nlocated saddle" in bar.note or "not a located saddle" in bar.note
    assert "lower bound" not in bar.note


async def test_unconverged_relaxation_flags_the_energy(worker, mp_ok):
    worker.behaviour["relax_result"] = fake_relax(
        li_cl_crystal(), converged=False, max_force=0.9
    )
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    e = next(m for m in result.measurements if m.property == "energy_per_atom")
    assert e.ood_flag is True
    assert "residual force" in e.note


async def test_energy_note_compares_against_the_gga_training_reference(worker, mp_ok, monkeypatch):
    """The reference must be raw GGA/GGA+U — what MACE-MP-0 was trained on.

    The summary endpoint's `uncorrected_energy_per_atom` is the r2SCAN value
    (2.47 eV/atom away for mp-985583), so using it would report a nonsense
    error. This test pins the correct source.
    """

    async def reference(material_id):
        return -3.95

    monkeypatch.setattr("athanor.mp.agga_reference_energy_per_atom", reference)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    e = next(m for m in result.measurements if m.property == "energy_per_atom")
    assert "raw GGA/GGA+U" in e.note
    assert "-3.950 eV/atom" in e.note
    assert "-0.050 eV/atom" in e.note  # -4.0 (MACE) - -3.95
    assert "r2SCAN" not in e.note


async def test_energy_note_is_omitted_when_there_is_no_gga_entry(worker, mp_ok, monkeypatch):
    """No GGA reference means no comparison, not a comparison to the wrong scale."""

    async def reference(material_id):
        return None

    monkeypatch.setattr("athanor.mp.agga_reference_energy_per_atom", reference)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    e = next(m for m in result.measurements if m.property == "energy_per_atom")
    assert e.note is None or "GGA" not in e.note


async def test_hull_method_names_the_actual_thermo_scheme(worker, mp_ok):
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull_dft")
    # The summary hull is the mixed scheme, not plain GGA/GGA+U.
    assert mp.MIXED_SCHEME in hull.method


@pytest.mark.parametrize(
    ("theoretical", "expected"),
    [
        (False, "Experimentally reported phase"),
        (True, "never reported experimentally"),
        (None, "does not record whether"),
    ],
)
async def test_theoretical_flag_is_three_way(worker, monkeypatch, theoretical, expected):
    """A missing flag must not be rendered as a factual claim either way."""

    async def aget_entry(material_id, *, with_structure=True):
        return fake_entry(theoretical=theoretical)

    monkeypatch.setattr("athanor.mp.aget_entry", aget_entry)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull_dft")
    assert expected in hull.note


# --------------------------------------------------------------------------
# Honesty: what must be omitted
# --------------------------------------------------------------------------


async def test_perturbed_candidate_has_no_energy_above_hull(worker):
    """The headline honesty case: no MP entry means no hull energy. Not guessed."""
    candidate = make_candidate(
        source="perturbation", parent_id="c-0", external_id=None, database=None
    )
    result = await AtomisticScorer().score([candidate], SPEC)
    props = {m.property for m in result.measurements}

    # The DFT hull distance and the band gap genuinely do not exist for it...
    assert "energy_above_hull_dft" not in props
    assert "band_gap" not in props
    # ...but it still gets a MACE hull distance, which is what keeps it
    # eligible for the Pareto frontier.
    assert "energy_above_hull" in props
    assert "energy_per_atom" in props
    assert "migration_barrier" in props

    reason = result.failed[candidate.id]
    assert "energy_above_hull_dft" in reason and "band_gap" in reason
    assert "Neither is estimated" in reason
    assert "perturbation" in reason


async def test_perturbed_child_cannot_inherit_its_parents_mp_numbers(worker, mp_ok):
    """A child that kept its parent's external_id must not get the parent's hull energy."""
    atoms = li_cl_crystal()
    symbols = atoms.get_chemical_symbols()
    symbols[1] = "Br"  # LiCl -> a Br-substituted cell; MP doc still says LiCl
    atoms.set_chemical_symbols(symbols)
    candidate = make_candidate(atoms=atoms, source="retrieval")
    candidate = candidate.model_copy(update={"formula": "Li4Cl3Br"})

    result = await AtomisticScorer().score([candidate], SPEC)
    props = {m.property for m in result.measurements}
    assert "energy_above_hull_dft" not in props
    assert "modified since retrieval" in result.failed[candidate.id]
    assert "Not transferred" in result.failed[candidate.id]


async def test_missing_mp_value_is_reported_not_defaulted(worker, monkeypatch):
    async def aget_entry(material_id, *, with_structure=True):
        return fake_entry(band_gap=None)

    monkeypatch.setattr("athanor.mp.aget_entry", aget_entry)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    props = {m.property for m in result.measurements}
    assert "band_gap" not in props
    assert "energy_above_hull_dft" in props  # the one that *is* there still lands
    assert "band_gap: mp-22905 has no band gap" in result.failed["c-1"]


async def test_mp_lookup_failure_does_not_fabricate(worker, monkeypatch):
    async def boom(material_id, *, with_structure=True):
        raise mp.MPError("503 from Materials Project")

    monkeypatch.setattr("athanor.mp.aget_entry", boom)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    props = {m.property for m in result.measurements}
    assert "energy_above_hull_dft" not in props and "band_gap" not in props
    assert "503 from Materials Project" in result.failed["c-1"]
    # The MACE hull does not depend on the candidate's own MP record.
    assert "energy_above_hull" in props
    # the MACE numbers are unaffected
    assert "energy_per_atom" in props


async def test_hard_ood_candidate_is_never_scored(worker, mp_ok):
    """An unsupported element must be reported, not sent to MACE."""
    atoms = li_cl_crystal()
    symbols = atoms.get_chemical_symbols()
    symbols[0] = "Rn"
    atoms.set_chemical_symbols(symbols)
    candidate = make_candidate(atoms=atoms)

    result = await AtomisticScorer().score([candidate], SPEC)
    assert result.measurements == []
    assert worker.calls == []  # no compute was spent
    assert "out of distribution" in result.failed["c-1"]
    assert "Rn" in result.failed["c-1"]


async def test_overlapping_atoms_are_rejected_before_compute(worker, mp_ok):
    atoms = li_cl_crystal()
    positions = atoms.get_positions()
    positions[0] = positions[1] + np.array([0.3, 0.0, 0.0])
    atoms.set_positions(positions)

    result = await AtomisticScorer().score([make_candidate(atoms=atoms)], SPEC)
    assert result.measurements == []
    assert worker.calls == []
    assert "covalent-radius sum" in result.failed["c-1"]


async def test_relaxation_failure_reports_every_dependent_property(worker, mp_ok):
    worker.behaviour["relax"] = RuntimeError("worker exited with code 1")
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    reason = result.failed["c-1"]
    for prop in ("energy_per_atom", "relaxation_drop", "migration_barrier"):
        assert prop in reason
    assert "worker exited with code 1" in reason
    # MP numbers were fetched before the relaxation, so they survive. The MACE
    # hull needs the relaxed energy, so it is correctly absent.
    assert {m.property for m in result.measurements} == {"energy_above_hull_dft", "band_gap"}


async def test_neb_failure_keeps_the_relaxation_measurements(worker, mp_ok):
    worker.behaviour["neb"] = RuntimeError("timed out after 3000s")
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    props = {m.property for m in result.measurements}
    assert "migration_barrier" not in props
    assert "energy_per_atom" in props
    assert "migration_barrier: NEB failed" in result.failed["c-1"]
    assert "timed out" in result.failed["c-1"]


async def test_oversized_neb_supercell_is_declined_not_shrunk(worker, mp_ok):
    result = await AtomisticScorer(neb_max_atoms=4).score([make_candidate()], SPEC)
    props = {m.property for m in result.measurements}
    assert "migration_barrier" not in props
    assert "energy_per_atom" in props
    reason = result.failed["c-1"]
    assert "atom budget" in reason or "-atom budget" in reason
    assert "periodic image" in reason
    assert not any(c["op"] == "neb" for c in worker.calls)


async def test_no_mobile_sublattice_is_reported(worker, mp_ok):
    # CsCl: clean geometry, known elements, but neither Cs nor Cl is a mobile
    # ion, so there is no vacancy hop to compute.
    atoms = bulk("CsCl", crystalstructure="cesiumchloride", a=4.11)
    candidate = make_candidate(atoms=atoms).model_copy(update={"formula": "CsCl"})
    result = await AtomisticScorer().score([candidate], SPEC)
    assert "no mobile-ion sublattice" in result.failed["c-1"]


async def test_unparseable_structure_is_reported(worker, mp_ok):
    candidate = make_candidate().model_copy(update={"structure": "not a cif at all"})
    result = await AtomisticScorer().score([candidate], SPEC)
    assert result.measurements == []
    assert "could not parse cif" in result.failed["c-1"]


async def test_one_bad_candidate_does_not_sink_the_batch(worker, mp_ok):
    good = make_candidate()
    bad = make_candidate().model_copy(update={"id": "c-bad", "structure": "garbage"})
    result = await AtomisticScorer().score([bad, good], SPEC)
    assert "c-bad" in result.failed
    assert {m.candidate_id for m in result.measurements} == {"c-1"}


async def test_non_finite_worker_value_raises_rather_than_being_recorded(worker, mp_ok):
    worker.behaviour["relax_result"] = fake_relax(li_cl_crystal())
    worker.behaviour["relax_result"]["energy_per_atom"] = float("nan")
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    assert not any(m.property == "energy_per_atom" for m in result.measurements)
    assert "non-finite" in result.failed["c-1"]


async def test_mof_water_domain_runs_no_neb(worker, mp_ok):
    candidate = make_candidate().model_copy(update={"domain": "mof_water"})
    result = await AtomisticScorer().score([candidate], SPEC)
    props = {m.property for m in result.measurements}
    assert "migration_barrier" not in props
    assert "energy_per_atom" in props
    assert not any(c["op"] == "neb" for c in worker.calls)


# --------------------------------------------------------------------------
# MACE convex hull
# --------------------------------------------------------------------------


async def test_a_phase_on_the_hull_scores_zero(worker, mp_ok):
    """Sanity check on the hull maths, through the real pymatgen PhaseDiagram.

    The fake system puts LiCl on the hull at -4.0 eV/atom, and the candidate is
    LiCl relaxing to the same -4.0, so its distance above the hull is exactly 0.
    """
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull")
    assert hull.value == pytest.approx(0.0, abs=1e-4)
    assert hull.source == "mace-mp-0"
    assert hull.confidence == atomistic.MACE_HULL_CONFIDENCE
    assert hull.confidence < 0.95  # strictly below MP's DFT confidence
    assert hull.unit == "eV/atom"
    assert hull.is_proxy is False


async def test_hull_method_says_it_is_not_dft(worker, mp_ok):
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull")
    assert "MACE-MP-0 energies" in hull.method
    assert "NOT a DFT hull distance" in hull.method
    assert "Cl-Li" in hull.method
    # and the note warns against cross-comparing the two hull numbers
    assert "must not be compared directly" in hull.note


async def test_a_phase_above_the_hull_scores_positive(worker, mp_ok):
    """A candidate 0.2 eV/atom less stable than the hull phase must say so."""
    worker.behaviour["relax_result"] = fake_relax(li_cl_crystal())
    worker.behaviour["relax_result"]["energy_per_atom"] = -3.8
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull")
    assert hull.value == pytest.approx(0.2, abs=1e-3)


async def test_a_known_phase_is_never_reported_below_the_hull(worker, mp_ok):
    """A database phase cannot be a discovery.

    If its own entry is missing from the hull it can come out negative, and
    reporting that would put an existing Materials Project material at the top
    of the frontier as something newly discovered. Clamp, and say why.
    """
    worker.behaviour["relax_result"] = fake_relax(li_cl_crystal())
    worker.behaviour["relax_result"]["energy_per_atom"] = -4.3
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull")
    assert hull.value == 0.0
    assert "-0.3000 eV/atom and has been reported as 0.0" in hull.note
    assert "cannot be more stable than the hull of known phases" in hull.note


async def test_a_novel_candidate_below_the_hull_is_not_clamped(worker, mp_ok):
    """For an invented candidate a negative distance is the discovery signal,
    so it survives — but it must be labelled a lead, not a result."""
    worker.behaviour["relax_result"] = fake_relax(li_cl_crystal())
    worker.behaviour["relax_result"]["energy_per_atom"] = -4.3
    candidate = make_candidate(
        source="perturbation", parent_id="c-0", external_id=None, database=None
    )
    result = await AtomisticScorer().score([candidate], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull")
    assert hull.value == pytest.approx(-0.3, abs=1e-3)
    assert "Not clamped" in hull.note
    assert "lead requiring DFT confirmation" in hull.note
    assert "hull is complete" in hull.note


async def test_the_hull_is_built_once_and_reused(worker, mp_ok):
    """The hull is the expensive part, so it must not be rebuilt per candidate."""
    a = make_candidate()
    b = make_candidate().model_copy(update={"id": "c-2"})
    c = make_candidate().model_copy(update={"id": "c-3"})
    result = await AtomisticScorer().score([a, b, c], SPEC)
    assert len([m for m in result.measurements if m.property == "energy_above_hull"]) == 3
    assert sum(1 for call in worker.calls if call["op"] == "relax_many") == 1


async def test_the_hull_is_reused_across_score_calls_via_disk_cache(worker, mp_ok):
    scorer = AtomisticScorer()
    await scorer.score([make_candidate()], SPEC)
    builds = sum(1 for c in worker.calls if c["op"] == "relax_many")
    # A fresh scorer with an empty memory cache must still find it on disk.
    fresh = AtomisticScorer()
    await fresh.score([make_candidate()], SPEC)
    assert sum(1 for c in worker.calls if c["op"] == "relax_many") == builds


async def test_hull_retrieval_failure_is_reported_not_guessed(worker, mp_ok, monkeypatch):
    async def boom(elements, *, max_atoms=80):
        raise mp.MPError("chemsys query failed")

    monkeypatch.setattr("athanor.mp.acompeting_phases", boom)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    props = {m.property for m in result.measurements}
    assert "energy_above_hull" not in props
    assert "could not build a MACE convex hull" in result.failed["c-1"]
    assert "Not estimated" in result.failed["c-1"]
    # everything else still landed
    assert "energy_per_atom" in props


async def test_a_system_missing_an_element_entirely_has_no_hull(worker, mp_ok, monkeypatch):
    """A hull needs a reference for every element in the candidate.

    Here nothing containing Cl can be relaxed, so the Li-Cl hull is undefined.
    The candidate must get no `energy_above_hull` at all rather than a value
    computed against an incomplete phase diagram.
    """

    async def only_lithium(elements, *, max_atoms=80):
        phases = fake_phases()
        phases["phases"] = [p for p in phases["phases"] if p["material_id"] == "mp-li"]
        return phases

    monkeypatch.setattr("athanor.mp.acompeting_phases", only_lithium)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    props = {m.property for m in result.measurements}
    assert "energy_above_hull" not in props
    reason = result.failed["c-1"]
    assert "convex hull is undefined" in reason
    assert "Cl" in reason
    assert "Not estimated" in reason


async def test_a_phase_that_cannot_be_relaxed_removes_its_element_coverage(worker, mp_ok):
    """Same guard, but triggered by a relaxation failure rather than a missing entry."""
    worker.behaviour["hull_energies"] = {"mp-li-GGA": -2.0}  # Cl and LiCl both fail
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    assert "energy_above_hull" not in {m.property for m in result.measurements}
    assert "convex hull is undefined" in result.failed["c-1"]


async def test_a_phase_that_fails_to_relax_is_excluded_and_disclosed(worker, mp_ok):
    """LiCl drops out of its own hull, so the candidate would score negative.

    This is exactly the false-discovery case: the candidate IS LiCl. It must be
    clamped to zero and the missing phase disclosed.
    """
    worker.behaviour["hull_energies"] = {"mp-li-GGA": -2.0, "mp-cl-GGA": -1.0}  # LiCl missing
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull")
    assert "failed to relax and were excluded" in hull.note
    assert hull.value == 0.0
    assert "its own entry is not among the phases" in hull.note


async def test_an_unconverged_hull_phase_is_disclosed(worker, mp_ok, monkeypatch):
    """An unconverged phase energy is an upper bound, which lifts the hull."""
    real = worker  # keep the fixture alive

    async def fake_run_worker(name, request, *, timeout=1800.0):
        real.calls.append(request)
        if request["op"] == "relax_many":
            return {
                "results": [
                    {
                        "label": item["label"],
                        "energy_per_atom": HULL_ENERGIES[item["label"]],
                        "n_atoms": len(item["atoms"]["symbols"]),
                        "converged": item["label"] != "mp-licl-GGA",
                        "max_force": 0.4,
                    }
                    for item in request["structures"]
                ],
                "n_ok": 3,
                "n_failed": 0,
            }
        from athanor.structure import dict_to_atoms

        atoms = dict_to_atoms(request["atoms"])
        if request["op"] == "relax":
            return fake_relax(atoms)
        return fake_neb(atoms)

    monkeypatch.setattr("athanor.scorers.atomistic.run_worker", fake_run_worker)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull")
    assert "did not reach fmax" in hull.note
    assert "upper bounds" in hull.note


async def test_the_hull_is_skipped_for_mof_water(worker, mp_ok):
    """A MOF is a metastable framework; a dense-phase hull distance is not its
    stability metric, and its chemical system would be hundreds of relaxations."""
    candidate = make_candidate().model_copy(update={"domain": "mof_water"})
    result = await AtomisticScorer().score([candidate], SPEC)
    assert "energy_above_hull" not in {m.property for m in result.measurements}
    assert "not the relevant" in result.failed["c-1"]
    assert not any(c["op"] == "relax_many" for c in worker.calls)


async def test_too_many_competing_phases_is_refused_not_truncated(worker, mp_ok, monkeypatch):
    async def many(elements, *, max_atoms=80):
        phases = fake_phases()
        base = phases["phases"][0]
        phases["phases"] = phases["phases"] + [
            {**base, "entry_id": f"extra-{i}", "material_id": f"extra-{i}"} for i in range(500)
        ]
        return phases

    monkeypatch.setattr("athanor.mp.acompeting_phases", many)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    assert "energy_above_hull" not in {m.property for m in result.measurements}
    reason = result.failed["c-1"]
    assert "phase budget" in reason or "-phase budget" in reason
    assert "truncating" in reason


async def test_skipped_large_phases_are_disclosed(worker, mp_ok, monkeypatch):
    async def with_skips(elements, *, max_atoms=80):
        phases = fake_phases()
        phases["skipped_large"] = 4
        return phases

    monkeypatch.setattr("athanor.mp.acompeting_phases", with_skips)
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    hull = next(m for m in result.measurements if m.property == "energy_above_hull")
    assert "4 phase(s) larger than" in hull.note
    assert "underestimate" in hull.note


async def test_hull_can_be_disabled(worker, mp_ok):
    result = await AtomisticScorer(use_mace_hull=False).score([make_candidate()], SPEC)
    props = {m.property for m in result.measurements}
    assert "energy_above_hull" not in props
    assert "energy_above_hull_dft" in props
    assert "MACE hull construction disabled" in result.failed["c-1"]


def test_hull_cache_key_includes_the_relaxation_settings():
    builder_a = atomistic.HullBuilder(None, fmax=0.05, steps=120, max_atoms=80)
    builder_b = atomistic.HullBuilder(None, fmax=0.01, steps=120, max_atoms=80)
    builder_c = atomistic.HullBuilder(None, fmax=0.05, steps=120, max_atoms=40)
    els = ("Cl", "Li")
    assert builder_a._path(els) != builder_b._path(els)
    assert builder_a._path(els) != builder_c._path(els)
    assert builder_a._path(els) == atomistic.HullBuilder(None)._path(els)


def test_hull_roundtrips_through_its_cache_format():
    hull = atomistic.SystemHull(
        elements=("Cl", "Li"),
        phases=(
            atomistic.PhaseEnergy("mp-li", "Li", {"Li": 1.0}, 1, -2.0),
            atomistic.PhaseEnergy("mp-cl", "Cl", {"Cl": 1.0}, 1, -1.0),
        ),
        skipped_large=1,
        skipped_failed=2,
        fmax=0.05,
        steps=120,
        max_atoms=80,
        seconds=12.5,
    )
    assert atomistic.SystemHull.from_json(hull.to_json()) == hull


def test_hull_energies_place_a_known_stable_phase_at_zero():
    """Direct check of the pymatgen wiring, independent of the scorer."""
    hull = atomistic.SystemHull(
        elements=("Cl", "Li"),
        phases=(
            atomistic.PhaseEnergy("mp-cl", "Cl", {"Cl": 1.0}, 1, -1.0),
            atomistic.PhaseEnergy("mp-li", "Li", {"Li": 1.0}, 1, -2.0),
            atomistic.PhaseEnergy("mp-licl", "LiCl", {"Li": 4.0, "Cl": 4.0}, 8, -4.0),
        ),
        skipped_large=0,
        skipped_failed=0,
        fmax=0.05,
        steps=120,
        max_atoms=80,
        seconds=1.0,
    )
    assert hull.e_above_hull({"Li": 4.0, "Cl": 4.0}, -4.0) == pytest.approx(0.0, abs=1e-6)
    assert hull.e_above_hull({"Li": 1.0}, -2.0) == pytest.approx(0.0, abs=1e-6)
    assert hull.e_above_hull({"Li": 4.0, "Cl": 4.0}, -3.5) == pytest.approx(0.5, abs=1e-6)


# --------------------------------------------------------------------------
# Artifacts
# --------------------------------------------------------------------------


async def test_artifact_payloads_match_the_contract_docstring(worker, mp_ok):
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    by_kind = {art.kind: (art, payload) for art, payload in result.artifacts}
    assert set(by_kind) == {"relaxation_trajectory", "neb_path"}

    art, payload = by_kind["relaxation_trajectory"]
    # Exactly the keys the Artifact docstring specifies, no extras.
    assert set(payload) == {"symbols", "cell", "pbc", "frames", "energies"}
    assert len(payload["frames"]) == len(payload["energies"])
    assert len(payload["frames"][0]) == len(payload["symbols"])
    assert art.candidate_id == "c-1"
    assert art.uri == "artifacts/a-relax-c-1.json"

    art, payload = by_kind["neb_path"]
    assert set(payload) == {
        "symbols",
        "cell",
        "pbc",
        "frames",
        "energies",
        "mobile_index",
        "barrier_ev",
    }
    assert isinstance(payload["mobile_index"], int)
    assert art.uri == "artifacts/a-neb-c-1.json"


async def test_artifact_barrier_matches_the_measurement(worker, mp_ok):
    """The 3D viewer must not label a barrier no measurement reported."""
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    bar = next(m for m in result.measurements if m.property == "migration_barrier")
    _, payload = next((a, p) for a, p in result.artifacts if a.kind == "neb_path")
    assert payload["barrier_ev"] == pytest.approx(bar.value, abs=1e-3)


async def test_artifact_payloads_are_json_serializable(worker, mp_ok):
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    for _, payload in result.artifacts:
        json.dumps(payload)  # must not raise on numpy scalars


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------


def test_registry_returns_the_atomistic_scorer():
    names = [s.name for s in registry.all_scorers()]
    assert "mace-mp-0" in names


def test_registry_skips_a_broken_scorer(monkeypatch, caplog):
    def boom():
        raise ImportError("tblite is not installed in this environment")

    monkeypatch.setattr(registry, "BUILDERS", [("atomistic", registry._atomistic), ("bad", boom)])
    with caplog.at_level("ERROR"):
        scorers = registry.all_scorers()
    assert [s.name for s in scorers] == ["mace-mp-0"]
    assert "unavailable" in caplog.text  # logged, not swallowed


def test_scorers_for_domain_filters():
    assert "mace-mp-0" in [s.name for s in registry.scorers_for_domain("solid_electrolyte")]
    assert "mace-mp-0" in [s.name for s in registry.scorers_for_domain("mof_water")]
    assert "mace-mp-0" not in [s.name for s in registry.scorers_for_domain("drug_stability")]


def test_a_framework_domain_is_not_offered_solid_electrolyte_objectives():
    """`property_vocabulary` unions `properties` per domain without narrowing,
    so a scorer serving MOFs must not advertise the ionic-conductor properties
    it declines to compute for them — an objective nothing measures empties the
    frontier for that domain."""
    mof = [s for s in registry.scorers_for_domain("mof_water") if s.name == "mace-mp-0"]
    assert mof, "MACE should still serve mof_water for relaxation energies"
    for prop in AtomisticScorer.SOLID_ONLY:
        assert prop not in mof[0].properties
    # ...while the solid-electrolyte instance keeps them.
    solid = next(
        s for s in registry.scorers_for_domain("solid_electrolyte") if s.name == "mace-mp-0"
    )
    for prop in AtomisticScorer.SOLID_ONLY:
        assert prop in solid.properties
    # Relaxation energies are genuinely computable in both.
    assert "energy_per_atom" in mof[0].properties


# --------------------------------------------------------------------------
# Materials Project cache
# --------------------------------------------------------------------------


@pytest.fixture
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(mp, "CACHE_DIR", tmp_path / "mp")
    mp.CACHE_STATS.update(hits=0, misses=0)
    return tmp_path / "mp"


def test_cache_hit_is_identical_to_the_miss_that_filled_it(cache_dir):
    calls = {"n": 0}

    def compute():
        calls["n"] += 1
        # numpy scalars are exactly what pymatgen hands back, and are the
        # reason the miss path must normalize through JSON.
        return {"e": np.float64(0.0020123456), "n": np.int64(30), "id": "mp-676361"}

    miss = mp._cached("entry", {"q": 1}, compute)
    hit = mp._cached("entry", {"q": 1}, compute)

    assert calls["n"] == 1  # the second call never hit the network
    assert mp.CACHE_STATS == {"hits": 1, "misses": 1}
    assert miss == hit
    assert json.dumps(miss, sort_keys=True) == json.dumps(hit, sort_keys=True)
    # Type identity, not just value equality: a float64 must not survive a miss.
    assert [type(v).__name__ for v in miss.values()] == [type(v).__name__ for v in hit.values()]
    assert type(miss["e"]) is float and type(miss["n"]) is int


def test_cache_key_depends_on_the_query(cache_dir):
    mp._cached("entry", {"q": 1}, lambda: {"v": 1})
    mp._cached("entry", {"q": 2}, lambda: {"v": 2})
    assert mp._cached("entry", {"q": 1}, lambda: {"v": 99}) == {"v": 1}
    assert mp._cached("entry", {"q": 2}, lambda: {"v": 99}) == {"v": 2}
    assert len(list(cache_dir.glob("*.json"))) == 2


def test_cache_key_is_order_independent(cache_dir):
    a = mp._cache_key("search", {"elements": ["Li", "S"], "limit": 3})
    b = mp._cache_key("search", {"limit": 3, "elements": ["Li", "S"]})
    assert a == b
    assert a != mp._cache_key("search", {"elements": ["Li", "P"], "limit": 3})


def test_a_stale_schema_entry_is_refetched(cache_dir):
    mp._cached("entry", {"q": 1}, lambda: {"v": 1})
    path = next(cache_dir.glob("*.json"))
    entry = json.loads(path.read_text())
    entry["schema"] = mp.CACHE_SCHEMA + 1000
    path.write_text(json.dumps(entry))
    assert mp._cached("entry", {"q": 1}, lambda: {"v": 2}) == {"v": 2}


def test_corrupt_cache_entry_raises_rather_than_returning_junk(cache_dir):
    mp._cached("entry", {"q": 1}, lambda: {"v": 1})
    next(cache_dir.glob("*.json")).write_text("{not json")
    with pytest.raises(mp.MPError, match="corrupt cache"):
        mp._cached("entry", {"q": 1}, lambda: {"v": 1})


def test_a_failed_fetch_writes_nothing(cache_dir):
    with pytest.raises(mp.MPError):
        mp._cached("entry", {"q": 1}, lambda: (_ for _ in ()).throw(mp.MPError("down")))
    assert list(cache_dir.glob("*")) == []


def test_entry_roundtrips_through_json():
    entry = fake_entry()
    assert mp.MPEntry.from_json(entry.to_json()) == entry


def test_entry_without_a_structure_raises_rather_than_inventing_one():
    with pytest.raises(mp.MPError, match="without a structure"):
        fake_entry().atoms()


def test_entry_atoms_roundtrip():
    atoms = li_cl_crystal()
    entry = fake_entry(structure=atoms_to_dict(atoms))
    assert entry.atoms().get_chemical_symbols() == atoms.get_chemical_symbols()


def test_search_requires_a_chemical_system():
    with pytest.raises(ValueError, match="chemsys or elements"):
        mp.search_near_hull()


def test_get_entry_rejects_an_empty_id():
    with pytest.raises(ValueError, match="material_id is empty"):
        mp.get_entry("  ")


def test_missing_api_key_is_an_explicit_error(monkeypatch):
    monkeypatch.delenv("MP_API_KEY", raising=False)
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    with pytest.raises(mp.MPError, match="MP_API_KEY"):
        mp.api_key()


# --------------------------------------------------------------------------
# OOD wiring
# --------------------------------------------------------------------------


async def test_ood_reasons_reach_the_measurement_notes(worker, mp_ok):
    """The detector must not be decorative: its reasons land on the numbers."""
    worker.behaviour["relax_result"] = fake_relax(
        li_cl_crystal(), converged=False, max_force=0.75
    )
    result = await AtomisticScorer().score([make_candidate()], SPEC)
    e = next(m for m in result.measurements if m.property == "energy_per_atom")
    assert e.ood_flag is True
    report = ood.assess_results(relax=worker.behaviour["relax_result"])
    assert report.reasons
    assert report.reasons[0][:40] in e.note
