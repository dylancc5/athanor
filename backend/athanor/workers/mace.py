"""MACE-MP-0 worker: energies, relaxations (keeping frames) and NEB barriers.

Runs in `backend/envs/mace`. Reference implementation for the worker protocol —
see `athanor/workers/base.py`.

Request: {"op": "<name>", ...op-specific fields}
Ops:
  ping    -> {"model": str}
  energy  -> {"atoms": AtomsDict}                      -> {"energy_ev", "energy_per_atom", "max_force"}
  relax   -> {"atoms": AtomsDict, "fmax", "steps", "relax_cell"}
             -> {"energy_ev", "energy_per_atom", "max_force", "steps_taken", "converged",
                 "initial_energy_ev", "atoms", "trajectory": {...}}

Determinism: MACE-MP-0 `medium` is deterministic on CPU at float32, and the
optimizers below are deterministic given the same starting coordinates.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from athanor.structure import atoms_to_dict, dict_to_atoms

MODEL = "medium"
_calc = None


def get_calculator():
    """Load MACE-MP-0 once per worker process."""
    global _calc
    if _calc is None:
        from mace.calculators import mace_mp

        # float32 on CPU: MPS cannot take the float64 model, and the accuracy
        # difference does not change which candidate wins a screen.
        _calc = mace_mp(model=MODEL, device="cpu", default_dtype="float32")
    return _calc


def op_ping(_: dict[str, Any]) -> dict[str, Any]:
    get_calculator()
    return {"model": f"mace-mp-0-{MODEL}"}


def op_energy(req: dict[str, Any]) -> dict[str, Any]:
    atoms = dict_to_atoms(req["atoms"])
    atoms.calc = get_calculator()
    e = float(atoms.get_potential_energy())
    f = float(np.abs(atoms.get_forces()).max())
    return {
        "energy_ev": e,
        "energy_per_atom": e / len(atoms),
        "max_force": f,
        "n_atoms": len(atoms),
    }


def op_relax(req: dict[str, Any]) -> dict[str, Any]:
    """Relax a structure, keeping every frame for 3D trajectory playback."""
    from ase.filters import FrechetCellFilter
    from ase.optimize import BFGS

    atoms = dict_to_atoms(req["atoms"])
    atoms.calc = get_calculator()
    fmax = float(req.get("fmax", 0.05))
    steps = int(req.get("steps", 120))
    relax_cell = bool(req.get("relax_cell", False)) and bool(np.any(atoms.pbc))

    initial_energy = float(atoms.get_potential_energy())
    frames: list[list[list[float]]] = []
    energies: list[float] = []
    cells: list[list[list[float]]] = []

    def record() -> None:
        frames.append(np.asarray(atoms.get_positions(), dtype=float).round(4).tolist())
        energies.append(round(float(atoms.get_potential_energy()), 6))
        if relax_cell:
            cells.append(np.asarray(atoms.cell.array, dtype=float).round(4).tolist())

    target = FrechetCellFilter(atoms) if relax_cell else atoms
    opt = BFGS(target, logfile=None)
    opt.attach(record, interval=1)
    converged = bool(opt.run(fmax=fmax, steps=steps))
    if not frames:  # already converged before the first callback
        record()

    final_energy = float(atoms.get_potential_energy())
    trajectory = {
        "symbols": [str(s) for s in atoms.get_chemical_symbols()],
        "cell": np.asarray(atoms.cell.array, dtype=float).round(4).tolist()
        if np.any(atoms.pbc)
        else None,
        "pbc": bool(np.any(atoms.pbc)),
        "frames": frames,
        "energies": energies,
        "cells": cells or None,
    }
    return {
        "energy_ev": final_energy,
        "energy_per_atom": final_energy / len(atoms),
        "initial_energy_ev": initial_energy,
        "relaxation_drop_ev": initial_energy - final_energy,
        "max_force": float(np.abs(atoms.get_forces()).max()),
        "steps_taken": len(frames),
        "converged": converged,
        "n_atoms": len(atoms),
        "atoms": atoms_to_dict(atoms),
        "trajectory": trajectory,
    }


def op_path(req: dict[str, Any]) -> dict[str, Any]:
    """Energies along a straight-line path for one moving atom.

    This is a crude *upper bound* on a migration barrier, not a converged
    saddle point — a relaxed CI-NEB can only lower it. Callers must label the
    resulting measurement `is_proxy=True` and say so in `method`.
    """
    atoms = dict_to_atoms(req["atoms"])
    index = int(req["mobile_index"])
    end = np.asarray(req["end_position"], dtype=float)
    n_images = int(req.get("n_images", 9))
    atoms.calc = get_calculator()

    start = np.asarray(atoms.get_positions()[index], dtype=float)
    frames: list[list[list[float]]] = []
    energies: list[float] = []
    for frac in np.linspace(0.0, 1.0, n_images):
        positions = np.asarray(atoms.get_positions(), dtype=float).copy()
        positions[index] = start + frac * (end - start)
        atoms.set_positions(positions)
        energies.append(round(float(atoms.get_potential_energy()), 6))
        frames.append(positions.round(4).tolist())
    atoms.set_positions(np.asarray(frames[0], dtype=float))

    barrier = float(max(energies) - energies[0])
    return {
        "barrier_ev": barrier,
        "energies": energies,
        "method": f"linear interpolation, {n_images} images (upper bound)",
        "path": {
            "symbols": [str(s) for s in atoms.get_chemical_symbols()],
            "cell": np.asarray(atoms.cell.array, dtype=float).round(4).tolist()
            if np.any(atoms.pbc)
            else None,
            "pbc": bool(np.any(atoms.pbc)),
            "frames": frames,
            "energies": energies,
            "mobile_index": index,
            "barrier_ev": barrier,
        },
    }


def _max_climb(energies: list[float]) -> float:
    """Largest uphill climb when traversing the profile left to right.

    For each image, how far it sits above the lowest point reached so far;
    the maximum of that is the barrier the ion must actually surmount, which
    is correct whether or not the path has intermediate minima.
    """
    worst = 0.0
    lowest = energies[0]
    for e in energies:
        lowest = min(lowest, e)
        worst = max(worst, e - lowest)
    return float(worst)


def op_neb(req: dict[str, Any]) -> dict[str, Any]:
    """Vacancy-mediated migration barrier by climbing-image NEB.

    The physical process: one mobile-ion site is vacant, and an ion on an
    adjacent site hops into it. So both endpoints are the *same* defective
    structure (one ion removed) differing only in which of the two sites the
    hopping ion occupies. Both endpoints are relaxed, then CI-NEB finds the
    saddle between them.

    Request: {"atoms", "species" (default "Li"), "n_images", "fmax", "steps",
              "min_cell_length"}
    Returns: {"barrier_ev", "forward_barrier_ev", "reverse_barrier_ev",
              "hop_distance_A", "energies", "converged", "path": {...}}
    """
    try:
        from ase.mep import NEB
    except ImportError:  # older ASE
        from ase.neb import NEB  # type: ignore[no-redef]
    from ase.optimize import BFGS

    atoms = dict_to_atoms(req["atoms"])
    species = str(req.get("species", "Li"))
    n_images = int(req.get("n_images", 9))
    fmax = float(req.get("fmax", 0.05))
    steps = int(req.get("steps", 200))
    endpoint_steps = int(req.get("endpoint_steps", 100))
    min_cell = float(req.get("min_cell_length", 8.0))

    # Expand so the migrating ion does not interact with its own periodic image.
    if np.any(atoms.pbc):
        reps = tuple(
            max(1, int(np.ceil(min_cell / max(l, 1e-6)))) for l in atoms.cell.lengths()
        )
        if reps != (1, 1, 1):
            atoms = atoms * reps

    sites = [i for i, s in enumerate(atoms.get_chemical_symbols()) if s == species]
    if len(sites) < 2:
        raise ValueError(f"need at least two {species} sites, found {len(sites)}")

    # Shortest hop between adjacent mobile-ion sites.
    best: tuple[float, int, int] | None = None
    for a_idx in sites:
        for b_idx in sites:
            if a_idx >= b_idx:
                continue
            d = float(atoms.get_distance(a_idx, b_idx, mic=True))
            if best is None or d < best[0]:
                best = (d, a_idx, b_idx)
    assert best is not None
    hop_distance, site_a, site_b = best

    # Target position for the hop, carried across the periodic boundary correctly.
    vec = np.asarray(atoms.get_distance(site_a, site_b, mic=True, vector=True), dtype=float)
    start_pos = np.asarray(atoms.get_positions()[site_a], dtype=float)
    target_pos = start_pos + vec

    # Endpoints: remove the ion on site B to create the vacancy, then the ion
    # on site A sits either where it started (initial) or in the vacancy (final).
    initial = atoms.copy()
    del initial[site_b]
    moved_index = site_a - 1 if site_a > site_b else site_a

    final = initial.copy()
    positions = np.asarray(final.get_positions(), dtype=float).copy()
    positions[moved_index] = target_pos
    final.set_positions(positions)

    # Relax the lattice around each endpoint while holding the hopping ion on
    # its site. Without this constraint the ion drifts off the site during
    # relaxation and the intended hop geometry — and the saddle — is lost.
    from ase.constraints import FixAtoms

    calc = get_calculator()
    for endpoint in (initial, final):
        endpoint.calc = calc
        endpoint.set_constraint(FixAtoms(indices=[moved_index]))
        BFGS(endpoint, logfile=None).run(fmax=fmax, steps=endpoint_steps)
        endpoint.set_constraint()

    images = [initial] + [initial.copy() for _ in range(n_images - 2)] + [final]
    for image in images[1:-1]:
        image.calc = calc
    neb = NEB(images, climb=True, allow_shared_calculator=True)
    neb.interpolate(mic=bool(np.any(atoms.pbc)))

    opt = BFGS(neb, logfile=None)
    converged = bool(opt.run(fmax=fmax, steps=steps))

    energies = [round(float(im.get_potential_energy()), 6) for im in images]
    e0, e1 = energies[0], energies[-1]
    # Migration often passes through a metastable interstitial, so the profile
    # has intermediate minima and `peak - endpoint` understates the barrier an
    # ion actually has to climb. The rate-limiting barrier for traversing the
    # path is the largest uphill climb from any preceding minimum.
    forward = _max_climb(energies)
    reverse = _max_climb(list(reversed(energies)))
    limiting = max(forward, reverse)

    return {
        "barrier_ev": float(max(limiting, 0.0)),
        "forward_barrier_ev": float(forward),
        "reverse_barrier_ev": float(reverse),
        "endpoint_asymmetry_ev": float(abs(e1 - e0)),
        "hop_distance_A": float(hop_distance),
        "energies": energies,
        "converged": converged,
        "n_atoms": len(initial),
        "species": species,
        "method": (
            f"CI-NEB, {n_images} images, vacancy-mediated {species} hop, "
            f"MACE-MP-0 ({MODEL}), fmax {fmax:.2f} eV/A"
        ),
        "path": {
            "symbols": [str(s) for s in initial.get_chemical_symbols()],
            "cell": np.asarray(initial.cell.array, dtype=float).round(4).tolist()
            if np.any(initial.pbc)
            else None,
            "pbc": bool(np.any(initial.pbc)),
            "frames": [
                np.asarray(im.get_positions(), dtype=float).round(4).tolist() for im in images
            ],
            "energies": energies,
            "mobile_index": moved_index,
            "barrier_ev": float(max(forward, 0.0)),
        },
    }


OPS = {
    "ping": op_ping,
    "energy": op_energy,
    "relax": op_relax,
    "path": op_path,
    "neb": op_neb,
}


def handle(req: dict[str, Any]) -> dict[str, Any]:
    op = req.get("op")
    if op not in OPS:
        raise ValueError(f"unknown op {op!r}; known: {sorted(OPS)}")
    return OPS[op](req)


if __name__ == "__main__":
    from athanor.workers.base import serve

    serve(handle)
