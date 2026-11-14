"""Pore geometry for porous frameworks: void fraction, largest included sphere,
accessible surface area, and the `void_grid` artifact the UI renders.

Everything here is *geometry*, computed from atom positions and van der Waals
radii. Nothing is fitted, interpolated or estimated. The honest names for what
this module produces:

  * **geometric void fraction** — the fraction of the unit cell where the centre
    of a hard spherical probe of radius `probe_radius` fits without overlapping
    any atom's vdW sphere. This is *not* a helium void fraction (which is a
    Boltzmann-weighted average over a real He–framework potential at a real
    temperature), and it is not an experimental pore volume.
  * **largest included sphere diameter** (`pore_diameter_A`) — twice the largest
    clearance found on the sample grid. It is the diameter of the biggest sphere
    that fits *anywhere* in the cell, with no requirement that it be reachable
    from outside; a sealed cavity counts. Grid-limited: see `grid_spacing_A`.
  * **gravimetric accessible surface area** — the vdW surface, expanded by the
    probe radius, that a probe centre can touch, per unit mass.

Deliberate dependency floor: numpy + ase only, so the same code can run inside
the server and inside a worker environment (the ODAC worker uses the clearance
map to pick guest sites). scipy is used when present purely as a speed-up; the
numpy path returns identical numbers.

Non-orthogonal cells are handled properly: periodic images are generated from
the cell's *perpendicular widths* (V / |b x c|), not its edge lengths, so a
sheared or centred lattice gets the same answer as its orthogonal equivalent.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
from ase import Atoms

# --------------------------------------------------------------------------
# van der Waals radii
# --------------------------------------------------------------------------

#: vdW radii in Angstrom, vendored from pymatgen's shipped periodic table
#: (`pymatgen.core.periodic_table.Element.van_der_waals_radius`, Alvarez-type
#: set) for elements 1-94.
#:
#: Why vendored rather than imported: this module must import inside the worker
#: environments, which have numpy+ase but no pymatgen.
#:
#: Why this table and not `ase.data.vdw_radii`: ASE leaves 40 of the first 94
#: elements undefined (NaN), including Fe, Co, Cr, Mn, Ti, V, Zr and Sc — most
#: of the metals that matter for MOFs. Completing ASE's table from another
#: source would mix conventions: ASE gives Zn 1.39 and Ni 1.63 while the
#: Alvarez-type set gives 2.01 and 1.97, and a 0.6 A inconsistency between two
#: chemically similar metals would bias any comparison of a Zn framework
#: against an Fe one. One self-consistent set across the whole periodic table
#: is worth more here than per-element cherry-picking.
VDW_RADII: dict[str, float] = {
    "H": 1.1, "He": 1.4, "Li": 1.82, "Be": 1.53, "B": 1.92, "C": 1.7, "N": 1.55, "O": 1.52,
    "F": 1.47, "Ne": 1.54, "Na": 2.27, "Mg": 1.73, "Al": 1.84, "Si": 2.1, "P": 1.8, "S": 1.8,
    "Cl": 1.75, "Ar": 1.88, "K": 2.75, "Ca": 2.31, "Sc": 2.15, "Ti": 2.11, "V": 2.07,
    "Cr": 2.06, "Mn": 2.05, "Fe": 2.04, "Co": 2.0, "Ni": 1.97, "Cu": 1.96, "Zn": 2.01,
    "Ga": 1.87, "Ge": 2.11, "As": 1.85, "Se": 1.9, "Br": 1.85, "Kr": 2.02, "Rb": 3.03,
    "Sr": 2.49, "Y": 2.32, "Zr": 2.23, "Nb": 2.18, "Mo": 2.17, "Tc": 2.16, "Ru": 2.13,
    "Rh": 2.1, "Pd": 2.1, "Ag": 2.11, "Cd": 2.18, "In": 1.93, "Sn": 2.17, "Sb": 2.06,
    "Te": 2.06, "I": 1.98, "Xe": 2.16, "Cs": 3.43, "Ba": 2.68, "La": 2.43, "Ce": 2.42,
    "Pr": 2.4, "Nd": 2.39, "Pm": 2.38, "Sm": 2.36, "Eu": 2.35, "Gd": 2.34, "Tb": 2.33,
    "Dy": 2.31, "Ho": 2.3, "Er": 2.29, "Tm": 2.27, "Yb": 2.26, "Lu": 2.24, "Hf": 2.23,
    "Ta": 2.22, "W": 2.18, "Re": 2.16, "Os": 2.16, "Ir": 2.13, "Pt": 2.13, "Au": 2.14,
    "Hg": 2.23, "Tl": 1.96, "Pb": 2.02, "Bi": 2.07, "Po": 1.97, "At": 2.02, "Rn": 2.2,
    "Fr": 3.48, "Ra": 2.83, "Ac": 2.47, "Th": 2.45, "Pa": 2.43, "U": 2.41, "Np": 2.39,
    "Pu": 2.43,
}

#: Kinetic diameter of a water molecule is ~2.65 A, so its radius is ~1.32 A.
#: Used as the default probe when asking "can water get in here".
WATER_PROBE_RADIUS = 1.32

#: Helium-sized probe, the conventional choice for a geometric void fraction.
HELIUM_PROBE_RADIUS = 1.2


class PoreError(ValueError):
    """Pore geometry could not be computed. Never swallowed into a default."""


def vdw_radius(symbol: str) -> float:
    try:
        return VDW_RADII[str(symbol)]
    except KeyError:
        raise PoreError(
            f"no van der Waals radius for element {symbol!r}; "
            f"the vendored table covers elements 1-94"
        ) from None


# --------------------------------------------------------------------------
# Clearance map
# --------------------------------------------------------------------------


def perpendicular_widths(cell: np.ndarray) -> np.ndarray:
    """Distance between opposite faces of the cell, per axis.

    For a non-orthogonal cell this is V / |b x c| and friends, which is
    strictly smaller than the edge length. Using edge lengths here is the
    classic way to under-replicate a sheared cell and silently miss the
    nearest periodic image.
    """
    cell = np.asarray(cell, dtype=float)
    volume = abs(float(np.linalg.det(cell)))
    if volume <= 0:
        raise PoreError("cell has zero or negative volume; not a periodic structure")
    widths = np.empty(3, dtype=float)
    for axis in range(3):
        other = np.cross(cell[(axis + 1) % 3], cell[(axis + 2) % 3])
        widths[axis] = volume / np.linalg.norm(other)
    return widths


def _image_shifts(cell: np.ndarray, cutoff: float) -> np.ndarray:
    """Lattice translations needed so every atom within `cutoff` is included."""
    widths = perpendicular_widths(cell)
    reps = np.ceil(cutoff / widths).astype(int)
    reps = np.maximum(reps, 0)
    ranges = [np.arange(-r, r + 1) for r in reps]
    grid = np.stack(np.meshgrid(*ranges, indexing="ij"), axis=-1).reshape(-1, 3)
    return grid.astype(float) @ cell


def grid_points(cell: np.ndarray, shape: tuple[int, int, int]) -> np.ndarray:
    """Cartesian coordinates of the sample grid, C-ordered.

    Points sit at fractional coordinates i/n (not (i+0.5)/n), so the grid is
    periodic: index 0 and index n are the same point, and the UI can wrap the
    isosurface across the cell boundary without a half-cell offset.
    """
    na, nb, nc = shape
    cell = np.asarray(cell, dtype=float)
    fa = (np.arange(na, dtype=float) / na)[:, None, None, None]
    fb = (np.arange(nb, dtype=float) / nb)[None, :, None, None]
    fc = (np.arange(nc, dtype=float) / nc)[None, None, :, None]
    # Built by broadcasting rather than one big `frac @ cell`: on macOS the
    # Accelerate BLAS emits spurious divide-by-zero/overflow warnings for large
    # matmuls, and real non-finite values here must stay visible.
    points = fa * cell[0] + fb * cell[1] + fc * cell[2]
    return points.reshape(-1, 3)


def shape_for_spacing(cell: np.ndarray, spacing: float) -> tuple[int, int, int]:
    """Grid divisions giving at most `spacing` between points along each axis."""
    widths = perpendicular_widths(cell)
    return tuple(int(max(2, np.ceil(w / spacing))) for w in widths)  # type: ignore[return-value]


def clearance_map(
    atoms: Atoms,
    *,
    spacing: float = 0.5,
    shape: tuple[int, int, int] | None = None,
) -> tuple[np.ndarray, tuple[int, int, int]]:
    """Signed clearance at every grid point, in Angstrom.

    The value at a point is `min_i (|r - r_i| - rvdw_i)` over all atoms *and all
    periodic images*: the distance from the point to the nearest atom's vdW
    *surface*. Positive means a point probe fits there; negative means the point
    is inside an atom.

    Note this is the minimum of `distance - radius`, not `distance to the
    nearest centre - that centre's radius`. With mixed radii those differ: a
    slightly more distant but much larger atom can be the binding constraint.
    Computing it exactly per element (below) costs one nearest-neighbour query
    per element and removes the approximation entirely.

    Returns `(clearance, shape)` with `clearance` C-ordered and flat.
    """
    if not np.any(atoms.pbc):
        raise PoreError("pore geometry needs a periodic cell; this structure has pbc=False")
    if len(atoms) == 0:
        raise PoreError("structure has no atoms")

    cell = np.asarray(atoms.cell.array, dtype=float)
    if shape is None:
        shape = shape_for_spacing(cell, spacing)
    points = grid_points(cell, shape)

    symbols = [str(s) for s in atoms.get_chemical_symbols()]
    positions = np.asarray(atoms.get_positions(), dtype=float)
    radii = {s: vdw_radius(s) for s in set(symbols)}

    # Replicate far enough to cover the largest atom plus the longest distance
    # a point can sit from an atom inside the cell.
    cutoff = float(max(radii.values())) + float(perpendicular_widths(cell).max())
    shifts = _image_shifts(cell, cutoff)

    best = np.full(len(points), np.inf, dtype=float)
    for symbol, radius in radii.items():
        sel = np.array([i for i, s in enumerate(symbols) if s == symbol], dtype=int)
        images = (positions[sel][None, :, :] + shifts[:, None, :]).reshape(-1, 3)
        nearest = _nearest_distance(points, images)
        np.minimum(best, nearest - radius, out=best)

    if not np.all(np.isfinite(best)):
        raise PoreError("clearance map contains non-finite values")
    return best, shape


def _nearest_distance(points: np.ndarray, centres: np.ndarray) -> np.ndarray:
    """Distance from each point to the nearest centre.

    Uses scipy's KD-tree when available and a chunked numpy reduction
    otherwise. Both paths return the same distances, so results do not depend
    on which environment the code runs in.
    """
    try:
        from scipy.spatial import cKDTree
    except ImportError:
        pass
    else:
        return cKDTree(centres).query(points, k=1)[0]

    out = np.empty(len(points), dtype=float)
    # Chunked so peak memory stays near 64 MB regardless of grid size.
    chunk = max(1, int(8_000_000 / max(1, len(centres))))
    for start in range(0, len(points), chunk):
        block = points[start : start + chunk]
        d2 = ((block[:, None, :] - centres[None, :, :]) ** 2).sum(axis=-1)
        out[start : start + chunk] = np.sqrt(d2.min(axis=1))
    return out


# --------------------------------------------------------------------------
# Derived quantities
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class PoreAnalysis:
    """Geometric pore descriptors. Every field is measured, none is fitted."""

    void_fraction: float
    pore_diameter_A: float
    accessible_surface_area_m2_g: float
    probe_radius_A: float
    grid_spacing_A: float
    shape: tuple[int, int, int]
    cell_volume_A3: float
    mass_amu: float
    density_g_cm3: float
    n_atoms: int
    largest_pore_center: tuple[float, float, float]
    max_clearance_A: float

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["shape"] = list(self.shape)
        d["largest_pore_center"] = list(self.largest_pore_center)
        return d


#: amu / Angstrom^3 -> g / cm^3
_AMU_PER_A3_TO_G_PER_CM3 = 1.66053906660


def analyze(
    atoms: Atoms,
    *,
    probe_radius: float = HELIUM_PROBE_RADIUS,
    spacing: float = 0.5,
    surface_points: int = 200,
) -> PoreAnalysis:
    """Measure pore geometry.

    `probe_radius` is the radius of the hard sphere whose *centre* must fit.
    Pass 0.0 for the bare vdW free volume (what the analytic sphere-packing
    test checks); pass `WATER_PROBE_RADIUS` to ask what water can reach.
    """
    clearance, shape = clearance_map(atoms, spacing=spacing)
    cell = np.asarray(atoms.cell.array, dtype=float)
    volume = abs(float(np.linalg.det(cell)))

    accessible = clearance > probe_radius
    void_fraction = float(accessible.mean())

    max_clearance = float(clearance.max())
    # Largest sphere that fits anywhere: twice the biggest clearance. Clamped at
    # zero because a fully dense structure has negative clearance everywhere.
    pore_diameter = float(max(0.0, 2.0 * max_clearance))

    flat_best = int(np.argmax(clearance))
    centre = grid_points(cell, shape)[flat_best]

    mass = float(atoms.get_masses().sum())
    density = mass / volume * _AMU_PER_A3_TO_G_PER_CM3

    area = _accessible_surface_area(
        atoms, probe_radius=probe_radius, n_points=surface_points
    )
    # A^2/amu -> m^2/g
    area_m2_g = area / mass * 602.2140762

    widths = perpendicular_widths(cell)
    actual_spacing = float((widths / np.array(shape)).max())

    return PoreAnalysis(
        void_fraction=round(void_fraction, 6),
        pore_diameter_A=round(pore_diameter, 4),
        accessible_surface_area_m2_g=round(area_m2_g, 3),
        probe_radius_A=probe_radius,
        grid_spacing_A=round(actual_spacing, 4),
        shape=shape,
        cell_volume_A3=round(volume, 4),
        mass_amu=round(mass, 4),
        density_g_cm3=round(density, 5),
        n_atoms=len(atoms),
        largest_pore_center=tuple(np.round(centre, 4).tolist()),
        max_clearance_A=round(max_clearance, 4),
    )


def _fibonacci_sphere(n: int) -> np.ndarray:
    """`n` near-uniform points on the unit sphere. Deterministic (no sampling)."""
    i = np.arange(n, dtype=float) + 0.5
    phi = np.arccos(1.0 - 2.0 * i / n)
    golden = np.pi * (1.0 + 5.0**0.5)
    theta = golden * i
    return np.stack(
        [np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], axis=-1
    )


def _accessible_surface_area(
    atoms: Atoms, *, probe_radius: float, n_points: int
) -> float:
    """Probe-accessible vdW surface area in A^2 (Shrake-Rupley, periodic).

    Each atom's sphere is inflated to `rvdw + probe`, sampled at deterministic
    Fibonacci points, and a point counts when no *other* inflated sphere
    covers it. This is the surface a probe centre can touch.
    """
    cell = np.asarray(atoms.cell.array, dtype=float)
    symbols = [str(s) for s in atoms.get_chemical_symbols()]
    positions = np.asarray(atoms.get_positions(), dtype=float)
    radii = np.array([vdw_radius(s) + probe_radius for s in symbols], dtype=float)

    shifts = _image_shifts(cell, float(2.0 * radii.max()))
    # All images of all atoms, with their inflated radii.
    image_pos = (positions[None, :, :] + shifts[:, None, :]).reshape(-1, 3)
    image_rad = np.tile(radii, len(shifts))

    unit = _fibonacci_sphere(n_points)
    total = 0.0
    for i in range(len(atoms)):
        probe_points = positions[i] + radii[i] * unit
        d = np.linalg.norm(probe_points[:, None, :] - image_pos[None, :, :], axis=-1)
        # Ignore the atom's own sphere (distance exactly radii[i] by construction).
        own = np.isclose(d, radii[i], atol=1e-9) & np.isclose(
            image_rad[None, :], radii[i], atol=1e-9
        )
        covered = ((d < image_rad[None, :]) & ~own).any(axis=1)
        total += (1.0 - covered.mean()) * 4.0 * np.pi * radii[i] ** 2
    return float(total)


# --------------------------------------------------------------------------
# Guest-site selection (used by the ODAC worker)
# --------------------------------------------------------------------------


def candidate_sites(
    atoms: Atoms,
    *,
    n_sites: int = 3,
    spacing: float = 0.5,
    min_separation: float = 3.0,
    min_clearance: float = WATER_PROBE_RADIUS,
    prefer: str = "wall",
    target_clearance: float | None = None,
) -> list[dict[str, Any]]:
    """Deterministic start positions for a guest molecule in the pore network.

    `prefer` chooses what "good site" means, and it matters more than it looks:

      * ``"wall"`` (default) — points whose clearance is closest to
        `target_clearance`, i.e. snug against a pore wall. This is where a
        guest actually binds. A water oxygen hydrogen-bonded to a framework
        oxygen sits ~2.8 A from it, which is a clearance of about
        2.8 - 1.52 = 1.3 A. Sites are ranked by `|clearance - target|`.
      * ``"open"`` — the roomiest points, most open first. Useful for
        characterising the pore network, and a poor way to place a guest: the
        centre of a large pore is the one place a molecule has nothing to bind
        to, so a relaxation started there often just sits in the middle and
        reports almost no interaction.

    Deterministic throughout: ties are broken by flat grid index, and sites are
    accepted greedily subject to `min_separation`. A start site is still only a
    starting geometry — the relaxation is what finds the binding geometry.
    """
    clearance, shape = clearance_map(atoms, spacing=spacing)
    cell = np.asarray(atoms.cell.array, dtype=float)
    points = grid_points(cell, shape)

    eligible = clearance >= min_clearance
    if not eligible.any():
        return []

    if prefer == "open":
        key = -clearance
    elif prefer == "wall":
        target = min_clearance + 0.3 if target_clearance is None else target_clearance
        key = np.abs(clearance - target)
    else:
        raise PoreError(f"unknown site preference {prefer!r}; use 'wall' or 'open'")

    key = np.where(eligible, key, np.inf)
    order = np.lexsort((np.arange(len(clearance)), key))

    chosen: list[int] = []
    for idx in order:
        if not np.isfinite(key[idx]):
            break
        p = points[idx]
        if all(
            _min_image_distance(p, points[j], cell) >= min_separation for j in chosen
        ):
            chosen.append(int(idx))
        if len(chosen) >= n_sites:
            break

    return [
        {
            "position": np.round(points[i], 4).tolist(),
            "clearance_A": round(float(clearance[i]), 4),
        }
        for i in chosen
    ]


def _min_image_distance(a: np.ndarray, b: np.ndarray, cell: np.ndarray) -> float:
    """Shortest distance between two points under periodic boundaries."""
    inv = np.linalg.inv(cell)
    frac = (a - b) @ inv
    frac -= np.round(frac)
    # Nearest-image in fractional space is not always the true minimum for a
    # strongly sheared cell, so check the 27 surrounding images.
    offsets = np.stack(
        np.meshgrid(*[np.arange(-1.0, 2.0)] * 3, indexing="ij"), axis=-1
    ).reshape(-1, 3)
    cands = (frac + offsets) @ cell
    return float(np.linalg.norm(cands, axis=1).min())


# --------------------------------------------------------------------------
# Artifact payload
# --------------------------------------------------------------------------


def void_grid_payload(
    atoms: Atoms,
    *,
    probe_radius: float = HELIUM_PROBE_RADIUS,
    spacing: float = 0.5,
    analysis: PoreAnalysis | None = None,
) -> dict[str, Any]:
    """The `void_grid` artifact payload (see `Artifact` in contracts.py).

    Contract fields: `cell`, `shape`, flat `values` normalized 0..1,
    `void_fraction`, `pore_diameter_A`.

    `values` is the clearance map rescaled so **0 means no room at all** (on or
    inside an atom's vdW surface) and **1 is the most open point in the cell**.
    Clearance below zero is clamped to zero, so the isosurface level chosen in
    the UI maps monotonically onto probe size: level `t` encloses everywhere a
    probe of radius `t * max_clearance_A` fits.

    Index order is C/row-major over `shape = (na, nb, nc)`, i.e. the third
    (c) index varies fastest:  `values[(ia * nb + ib) * nc + ic]`. Grid points
    are at fractional coordinates `i / n`, so the array is periodic and the
    last point along each axis is *not* a repeat of the first.
    """
    clearance, shape = clearance_map(atoms, spacing=spacing)
    if analysis is None:
        analysis = analyze(atoms, probe_radius=probe_radius, spacing=spacing)

    positive = np.clip(clearance, 0.0, None)
    peak = float(positive.max())
    values = positive / peak if peak > 0 else np.zeros_like(positive)
    if not np.all(np.isfinite(values)):
        raise PoreError("void grid contains non-finite values")

    return {
        "cell": np.asarray(atoms.cell.array, dtype=float).round(4).tolist(),
        "shape": list(shape),
        "values": np.round(values, 4).tolist(),
        "void_fraction": analysis.void_fraction,
        "pore_diameter_A": analysis.pore_diameter_A,
        # Extra context so the number on screen can be read correctly. The
        # frontend ignores keys it does not know.
        "order": "C",
        "grid_spacing_A": analysis.grid_spacing_A,
        "probe_radius_A": analysis.probe_radius_A,
        "max_clearance_A": analysis.max_clearance_A,
        "value_meaning": (
            "clearance to the nearest vdW surface, 0 = no room, "
            "1 = most open point (max_clearance_A)"
        ),
    }
