"""Pore geometry tests.

The load-bearing test here is `test_fcc_void_fraction_matches_analytic`: for
non-overlapping hard spheres on an FCC lattice the void fraction is known in
closed form, and checking the *conventional cubic* cell against the *primitive
rhombohedral* cell of the same crystal proves two things at once — that the
geometry is right, and that a non-orthogonal cell gets the same answer as its
orthogonal equivalent.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from ase import Atoms
from ase.build import bulk, nanotube

from athanor import pores


@pytest.fixture
def unit_radius(monkeypatch):
    """Pin Cu's vdW radius so the analytic comparison is exact."""
    table = dict(pores.VDW_RADII)
    table["Cu"] = 1.2
    monkeypatch.setattr(pores, "VDW_RADII", table)
    return 1.2


def test_fcc_void_fraction_matches_analytic(unit_radius):
    a = 6.0
    r = unit_radius
    # 4 spheres per conventional cubic cell, none overlapping at a=6, r=1.2
    # (nearest-neighbour distance a/sqrt(2) = 4.24 > 2r).
    analytic = 1.0 - 4.0 * (4.0 / 3.0) * math.pi * r**3 / a**3

    cubic = pores.analyze(bulk("Cu", "fcc", a=a, cubic=True), probe_radius=0.0, spacing=0.08)
    primitive = pores.analyze(bulk("Cu", "fcc", a=a), probe_radius=0.0, spacing=0.08)

    assert cubic.n_atoms == 4
    assert primitive.n_atoms == 1
    assert cubic.void_fraction == pytest.approx(analytic, abs=2e-3)
    # The real point: a sheared 1-atom cell must agree with the cubic 4-atom one.
    assert primitive.void_fraction == pytest.approx(analytic, abs=2e-3)
    assert primitive.void_fraction == pytest.approx(cubic.void_fraction, abs=3e-3)


def test_fcc_largest_included_sphere_is_the_octahedral_hole(unit_radius):
    """At a=6 the octahedral hole sits 3.0 A from its nearest atoms."""
    analysis = pores.analyze(
        bulk("Cu", "fcc", a=6.0, cubic=True), probe_radius=0.0, spacing=0.08
    )
    assert analysis.pore_diameter_A == pytest.approx(2.0 * (3.0 - 1.2), abs=0.05)


def test_dense_metal_has_no_accessible_void_and_right_density():
    """Real fcc copper: nothing fits, and the density must come out right."""
    analysis = pores.analyze(
        bulk("Cu", "fcc", a=3.61, cubic=True),
        probe_radius=pores.HELIUM_PROBE_RADIUS,
        spacing=0.12,
    )
    assert analysis.void_fraction == 0.0
    assert analysis.pore_diameter_A == 0.0
    # Independent check on the volume/mass arithmetic: Cu is 8.96 g/cm3.
    assert analysis.density_g_cm3 == pytest.approx(8.96, abs=0.05)


def test_nanotube_pore_diameter_matches_its_geometry():
    """A (10,10) tube's interior is 2*(R - r_vdW(C)) across."""
    tube = nanotube(10, 10, length=3)
    tube.center(vacuum=1.0, axis=(0, 1))
    tube.pbc = True
    xy = tube.get_positions()[:, :2]
    radius = float(np.linalg.norm(xy - xy.mean(axis=0), axis=1).mean())
    expected = 2.0 * (radius - pores.VDW_RADII["C"])

    analysis = pores.analyze(tube, probe_radius=0.0, spacing=0.2)
    # Grid-limited: a 0.2 A grid can overshoot by about sqrt(3)/2 * spacing.
    assert analysis.pore_diameter_A == pytest.approx(expected, abs=0.25)
    assert 0.3 < analysis.void_fraction < 0.7
    assert analysis.accessible_surface_area_m2_g > 0


def test_perpendicular_widths_are_not_edge_lengths():
    """For a sheared cell the face separation is smaller than the edge length."""
    cell = np.array([[10.0, 0.0, 0.0], [5.0, 10.0, 0.0], [0.0, 0.0, 10.0]])
    widths = pores.perpendicular_widths(cell)
    lengths = np.linalg.norm(cell, axis=1)
    # The b edge is sqrt(125) long but its faces are only 10 apart.
    assert widths[1] < lengths[1]
    assert widths[1] == pytest.approx(1000.0 / 100.0)
    # The a edge is 10 long, yet the shear puts its faces 8.94 apart:
    # V / |b x c| = 1000 / sqrt(12500). Using the edge length here would
    # under-replicate the cell and miss the nearest periodic image.
    assert widths[0] == pytest.approx(1000.0 / math.sqrt(12500.0))
    assert widths[0] < lengths[0]


def test_void_grid_payload_matches_the_artifact_contract():
    tube = nanotube(6, 6, length=2)
    tube.center(vacuum=2.0, axis=(0, 1))
    tube.pbc = True
    payload = pores.void_grid_payload(tube, spacing=0.8)

    for key in ("cell", "shape", "values", "void_fraction", "pore_diameter_A"):
        assert key in payload

    shape = payload["shape"]
    assert len(shape) == 3
    assert len(payload["values"]) == shape[0] * shape[1] * shape[2]
    values = np.asarray(payload["values"], dtype=float)
    assert np.all(np.isfinite(values)), "a NaN here breaks the frontend's JSON.parse"
    assert values.min() >= 0.0 and values.max() <= 1.0
    assert values.max() == pytest.approx(1.0)  # normalized to the most open point
    assert np.asarray(payload["cell"]).shape == (3, 3)
    assert payload["order"] == "C"
    assert 0.0 <= payload["void_fraction"] <= 1.0


def test_grid_points_are_periodic_not_half_offset():
    cell = np.eye(3) * 4.0
    points = pores.grid_points(cell, (4, 4, 4))
    assert len(points) == 64
    # First point at the origin (fractional 0), not at half a cell step.
    assert np.allclose(points[0], [0.0, 0.0, 0.0])
    # C order: the third index varies fastest.
    assert np.allclose(points[1], [0.0, 0.0, 1.0])


def test_wall_sites_are_snugger_than_open_sites():
    """Wall preference must not just return the roomiest points."""
    tube = nanotube(10, 10, length=3)
    tube.center(vacuum=1.0, axis=(0, 1))
    tube.pbc = True
    wall = pores.candidate_sites(tube, n_sites=3, spacing=0.4, prefer="wall")
    openest = pores.candidate_sites(tube, n_sites=3, spacing=0.4, prefer="open")
    assert wall and openest
    assert min(s["clearance_A"] for s in wall) < max(
        s["clearance_A"] for s in openest
    )
    # Every site must still be roomy enough for the guest it was chosen for.
    assert all(s["clearance_A"] >= pores.WATER_PROBE_RADIUS for s in wall)


def test_sites_are_deterministic():
    tube = nanotube(6, 6, length=2)
    tube.center(vacuum=2.0, axis=(0, 1))
    tube.pbc = True
    first = pores.candidate_sites(tube, n_sites=3, spacing=0.5)
    second = pores.candidate_sites(tube, n_sites=3, spacing=0.5)
    assert first == second


def test_non_periodic_structure_is_an_error_not_a_zero():
    mol = Atoms("H2", positions=[[0, 0, 0], [0, 0, 0.74]], pbc=False)
    with pytest.raises(pores.PoreError, match="periodic"):
        pores.analyze(mol)


def test_unknown_element_raises_rather_than_guessing_a_radius():
    with pytest.raises(pores.PoreError, match="van der Waals"):
        pores.vdw_radius("Og")


def test_vdw_table_is_self_consistent_across_the_3d_row():
    """Mixed-provenance radii would bias one metal's framework against another."""
    row = ["Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn"]
    values = [pores.VDW_RADII[e] for e in row]
    assert all(1.9 < v < 2.2 for v in values), values
    # No neighbouring pair may jump by more than 0.1 A.
    assert max(abs(b - a) for a, b in zip(values, values[1:])) < 0.1
