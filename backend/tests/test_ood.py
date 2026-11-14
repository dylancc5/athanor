"""OOD detector: it must fire on broken inputs and stay quiet on clean ones.

A detector that cries wolf is as useless as one that never fires, so every
"fires" test here is paired with a "stays quiet" assertion on real crystal
geometry.
"""

from __future__ import annotations

import numpy as np
import pytest
from ase.build import bulk
from ase.lattice.cubic import SimpleCubic

from athanor import ood


def nacl_like() -> "object":
    """A clean, periodic, close-packed ionic crystal (rock-salt LiCl)."""
    return bulk("LiCl", crystalstructure="rocksalt", a=5.14, cubic=True)


def li3ps4_like():
    """A small Li-P-S cell: real elements, plausible (3.0 A) bond lengths.

    Spacing matters here: at a 6.0 A lattice constant this same cell is
    correctly reported as OOD, because every atom would then be further from
    its neighbour than anything in a packed MP crystal.
    """
    atoms = SimpleCubic(symbol="Li", latticeconstant=3.0, size=(2, 2, 2))
    symbols = atoms.get_chemical_symbols()
    symbols[0] = "P"
    symbols[1] = "S"
    symbols[2] = "S"
    atoms.set_chemical_symbols(symbols)
    return atoms


# --------------------------------------------------------------------------
# Element coverage
# --------------------------------------------------------------------------


def test_training_set_is_the_models_89_elements():
    # Extracted from mace_mp(...).models[0].atomic_numbers, not from memory.
    assert len(ood.MACE_MP0_ATOMIC_NUMBERS) == 89
    for z in (3, 15, 16, 17, 83, 94):  # Li, P, S, Cl, Bi, Pu
        assert z in ood.MACE_MP0_ATOMIC_NUMBERS
    for z in (84, 85, 86, 87, 88, 95):  # Po, At, Rn, Fr, Ra, Am
        assert z not in ood.MACE_MP0_ATOMIC_NUMBERS


def test_untrained_element_is_hard_ood():
    atoms = nacl_like()
    symbols = atoms.get_chemical_symbols()
    symbols[0] = "Rn"  # Z=86, absent from MPtrj
    atoms.set_chemical_symbols(symbols)

    report = ood.assess_structure(atoms)
    assert report.hard is True
    assert report.score == 1.0
    assert report.is_ood
    assert report.signals["unknown_elements"] == 1.0
    assert "Rn" in report.summary()
    assert "training set" in report.summary()


def test_clean_crystal_is_not_ood():
    report = ood.assess_structure(nacl_like())
    assert report.hard is False
    assert report.score == 0.0
    assert not report.is_ood
    assert report.reasons == []
    assert report.summary() == "No out-of-distribution signal detected."


def test_clean_lips_cell_is_not_ood():
    report = ood.assess_structure(li3ps4_like())
    assert not report.is_ood
    # Specifically: the isolated-atom check must stay quiet on a real crystal.
    assert "no neighbour within" not in report.summary()


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------


def test_two_atoms_03_angstrom_apart_is_hard_ood():
    """The headline broken case: an overlapping contact inside a real crystal."""
    atoms = nacl_like()
    positions = atoms.get_positions()
    d = atoms.get_all_distances(mic=True)
    np.fill_diagonal(d, np.inf)
    j = int(d[0].argmin())
    vec = atoms.get_distance(0, j, mic=True, vector=True)
    positions[0] = positions[j] - vec / np.linalg.norm(vec) * 0.3
    atoms.set_positions(positions)

    report = ood.assess_structure(atoms)
    assert report.hard is True
    assert report.score == 1.0
    assert report.signals["min_contact_fraction"] < ood.CLOSE_CONTACT_HARD
    text = report.summary()
    assert "0.30 A" in text  # the actual distance is quoted
    assert "covalent-radius sum" in text
    assert "repulsive wall" in text


def test_isolated_atom_beyond_the_model_cutoff_is_hard_ood():
    atoms = nacl_like()
    positions = atoms.get_positions()
    positions[0] = positions[0] + np.array([0.0, 0.0, 40.0])
    cell = atoms.cell.array.copy()
    cell[2][2] = 120.0  # open up the cell so it is genuinely alone
    atoms.set_cell(cell)
    atoms.set_positions(positions)

    report = ood.assess_structure(atoms)
    assert report.hard is True
    assert report.signals["max_nn_distance_A"] > ood.ISOLATION_CUTOFF_A
    assert "cutoff" in report.summary()


def test_single_atom_is_hard_ood():
    from ase import Atoms

    report = ood.assess_structure(Atoms("Li", positions=[[0, 0, 0]]))
    assert report.hard is True
    assert "Single-atom" in report.summary()


def test_accepts_an_atoms_dict():
    from athanor.structure import atoms_to_dict

    report = ood.assess_structure(atoms_to_dict(nacl_like()))
    assert not report.is_ood


# --------------------------------------------------------------------------
# Post-compute signals
# --------------------------------------------------------------------------


def test_unconverged_relaxation_raises_the_force_signal():
    relax = {
        "max_force": 0.6,
        "converged": False,
        "steps_taken": 120,
        "n_atoms": 8,
        "relaxation_drop_ev": 0.01,
    }
    report = ood.assess_results(relax=relax)
    assert report.score == 1.0
    assert report.is_ood
    assert report.signals["residual_force_eV_A"] == 0.6
    assert "did not converge" in report.summary()
    assert "not a\nminimum" in report.summary() or "not a minimum" in report.summary()


def test_settled_relaxation_is_quiet():
    relax = {
        "max_force": 0.04,
        "converged": True,
        "steps_taken": 30,
        "n_atoms": 8,
        "relaxation_drop_ev": 0.08,  # 0.01 eV/atom
    }
    report = ood.assess_results(relax=relax)
    assert report.score == 0.0
    assert not report.is_ood


def test_big_relaxation_drop_flags_a_far_from_equilibrium_input():
    relax = {
        "max_force": 0.03,
        "converged": True,
        "steps_taken": 90,
        "n_atoms": 10,
        "relaxation_drop_ev": 4.0,  # 0.40 eV/atom
    }
    report = ood.assess_results(relax=relax)
    assert report.signals["relaxation_drop_eV_atom"] == 0.4
    assert report.score == 1.0
    assert "eV/atom" in report.summary()


def test_unconverged_neb_is_flagged():
    neb = {"converged": False, "steps": 200, "path": {}}
    report = ood.assess_results(neb=neb)
    assert report.is_ood
    assert "did not converge" in report.summary()
    assert "located" in report.summary()


def test_neb_stretch_is_measured_from_the_path_frames():
    """A saddle geometry stretches the mobile ion's bonds; that is the signal."""
    symbols = ["Li", "S", "S"]
    cell = [[20.0, 0, 0], [0, 20.0, 0], [0, 0, 20.0]]
    # Image 0: Li bonded to S at 2.4 A. Image 1: Li midway, 4.0 A from each S.
    frames = [
        [[0.0, 0, 0], [2.4, 0, 0], [8.0, 0, 0]],
        [[4.0, 0, 0], [2.4, 0, 0], [8.0, 0, 0]],
    ]
    neb = {
        "converged": True,
        "path": {
            "symbols": symbols,
            "cell": cell,
            "pbc": True,
            "frames": frames,
            "energies": [0.0, 1.0],
            "mobile_index": 0,
        },
    }
    report = ood.assess_results(neb=neb)
    # Saddle NN distance 1.6 A? no: at image 1 Li is 1.6 from S1 and 4.0 from S2
    # -> nearest is 1.6, endpoint nearest is 2.4 -> ratio 0.667, a compression.
    assert report.signals["saddle_stretch_ratio"] == pytest.approx(1.6 / 2.4, abs=1e-3)
    assert "path_min_contact_fraction" in report.signals


def test_neb_stretch_fires_when_the_ion_is_pulled_long():
    symbols = ["Li", "S"]
    frames = [[[0.0, 0, 0], [2.4, 0, 0]], [[-1.4, 0, 0], [2.4, 0, 0]]]
    neb = {
        "converged": True,
        "path": {
            "symbols": symbols,
            "cell": [[30.0, 0, 0], [0, 30.0, 0], [0, 0, 30.0]],
            "pbc": True,
            "frames": frames,
            "energies": [0.0, 1.0],
            "mobile_index": 0,
        },
    }
    report = ood.assess_results(neb=neb)
    assert report.signals["saddle_stretch_ratio"] == pytest.approx(3.8 / 2.4, abs=1e-3)
    assert report.score > 0.0
    assert "saddle" in report.summary()
    assert "relaxation trajectories" in report.summary()


def test_squeezed_neb_image_is_hard_ood():
    symbols = ["Li", "S"]
    frames = [[[0.0, 0, 0], [2.4, 0, 0]], [[2.1, 0, 0], [2.4, 0, 0]]]
    neb = {
        "converged": True,
        "path": {
            "symbols": symbols,
            "cell": [[30.0, 0, 0], [0, 30.0, 0], [0, 0, 30.0]],
            "pbc": True,
            "frames": frames,
            "energies": [0.0, 1.0],
            "mobile_index": 0,
        },
    }
    report = ood.assess_results(neb=neb)
    assert report.hard is True
    assert report.signals["path_min_contact_fraction"] < ood.CLOSE_CONTACT_HARD


def test_empty_neb_payload_yields_no_signal_rather_than_an_error():
    stretch = ood._neb_stretch({"path": {}})
    assert stretch == {"saddle_stretch_ratio": None, "path_min_contact_fraction": None}


# --------------------------------------------------------------------------
# Combination / registry
# --------------------------------------------------------------------------


def test_merge_takes_the_worst_signal_and_keeps_every_reason():
    a = ood.OODReport(scorer="mace-mp-0", score=0.2, reasons=["mild"], signals={"x": 1.0})
    b = ood.OODReport(scorer="mace-mp-0", score=0.9, hard=True, reasons=["bad"], signals={"y": 2.0})
    merged = ood.merge([a, b])
    assert merged.score == 0.9
    assert merged.hard is True
    assert merged.reasons == ["mild", "bad"]
    assert merged.signals == {"x": 1.0, "y": 2.0}


def test_merge_of_nothing_is_clean():
    assert ood.merge([], scorer="mace-mp-0").score == 0.0


def test_unknown_scorer_raises_rather_than_looking_clean():
    with pytest.raises(KeyError):
        ood.for_scorer("no-such-scorer")
    assert ood.for_scorer("mace-mp-0").scorer == "mace-mp-0"


def test_detector_satisfies_the_protocol():
    assert isinstance(ood.for_scorer("mace-mp-0"), ood.OODDetector)


def test_score_is_always_a_valid_probability():
    for atoms in (nacl_like(), li3ps4_like()):
        report = ood.assess_structure(atoms)
        assert 0.0 <= report.score <= 1.0
