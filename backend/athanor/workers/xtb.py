"""GFN2-xTB worker: molecular and molecular-crystal energetics via tblite.

Runs in `backend/envs/xtb`. Worker protocol: `athanor/workers/base.py`;
reference implementation: `athanor/workers/mace.py`.

Request: {"op": "<name>", ...}
Ops:
  ping           -> {"method"}
  energy         -> {"atoms"}            -> {"energy_ev", "max_force", ...}
  relax          -> {"atoms", "fmax", "steps"} -> + {"trajectory": {...}}
  gap            -> {"atoms"}            -> {"homo_lumo_gap_ev", "homo_ev", "lumo_ev"}
  molecules      -> {"atoms"}            -> connectivity analysis of a crystal
  lattice_energy -> {"atoms", "smiles"?} -> {"lattice_energy_ev_per_molecule", ...}

-------------------------------------------------------------------------------
Lattice energy: what is computed and why it is computed this way
-------------------------------------------------------------------------------
    E_latt = E(crystal) / Z  -  E(isolated molecule)

where Z is the number of molecules in the unit cell. This is the energy
released when Z gas-phase molecules condense into one unit cell, per molecule.
It is negative for a stable crystal.

The number that actually matters for polymorph ranking is the *difference*
between two polymorphs of the same molecule. Two choices make that difference
trustworthy:

  * **One gas-phase reference per molecule, not one per polymorph.** The
    reference is built from the canonical SMILES, embedded with RDKit and
    relaxed with GFN2-xTB, then cached by that SMILES. If instead each
    polymorph's reference came from a molecule extracted out of its own
    crystal, each would relax from a different starting conformer into a
    different local minimum, and those conformer differences — which can be
    several kJ/mol, the same size as the polymorph difference being measured —
    would leak straight into the ranking. With a shared reference the term
    cancels exactly in the difference.
  * **Atom positions relax, the cell does not.** The experimental cell from the
    CIF is kept. GFN2-xTB has no dispersion-corrected cell optimisation good
    enough to reproduce molecular-crystal cells, and letting it relax the cell
    makes it drift away from the measured structure. This is stated in the
    `method` string of every measurement.

tblite is **Gamma-point only**. For a small cell that is an approximation, so
`lattice_energy` replicates the cell up to `min_cell_length` (default 8 A) and
reports `gamma_point_only: true` so the caller can say so.

Determinism: the GFN2-xTB SCF is deterministic at fixed electronic
temperature, and BFGS is deterministic from fixed starting coordinates.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from ase.units import Bohr, Hartree  # noqa: F401  (Hartree used below)

from athanor.structure import atoms_to_dict, dict_to_atoms, smiles_to_atoms

METHOD = "GFN2-xTB"

#: Electronic temperature (K) for Fermi smearing. Fixed so runs are comparable.
ELECTRONIC_TEMPERATURE = 300.0

#: An orbital counts as occupied above this occupation. Smearing gives
#: fractional occupations, so HOMO/LUMO need a threshold rather than an
#: integer electron count.
OCCUPATION_THRESHOLD = 0.5

_gas_cache: dict[str, float] = {}


def make_calculator(atoms):
    """A fresh TBLite calculator. One per structure: tblite ties a calculator
    to a fixed geometry/periodicity, so reusing one across structures is not
    safe the way it is for a neural-network potential."""
    from tblite.ase import TBLite

    return TBLite(
        method=METHOD,
        verbosity=0,
        electronic_temperature=ELECTRONIC_TEMPERATURE,
    )


def _single_point(atoms) -> float:
    atoms.calc = make_calculator(atoms)
    e = float(atoms.get_potential_energy())
    if not np.isfinite(e):
        raise ValueError(f"GFN2-xTB returned a non-finite energy: {e}")
    return e


# --------------------------------------------------------------------------
# Basic ops
# --------------------------------------------------------------------------


def op_ping(_: dict[str, Any]) -> dict[str, Any]:
    from ase.build import molecule

    a = molecule("H2O")
    return {"method": METHOD, "h2o_energy_ev": round(_single_point(a), 4)}


def op_energy(req: dict[str, Any]) -> dict[str, Any]:
    atoms = dict_to_atoms(req["atoms"])
    e = _single_point(atoms)
    return {
        "energy_ev": round(e, 6),
        "energy_per_atom": round(e / len(atoms), 6),
        "max_force": round(float(np.abs(atoms.get_forces()).max()), 6),
        "n_atoms": len(atoms),
        "periodic": bool(np.any(atoms.pbc)),
    }


def op_relax(req: dict[str, Any]) -> dict[str, Any]:
    """Relax atom positions, keeping every frame for trajectory playback.

    The cell is never relaxed here; see the module docstring.
    """
    from ase.optimize import BFGS

    atoms = dict_to_atoms(req["atoms"])
    fmax = float(req.get("fmax", 0.05))
    steps = int(req.get("steps", 200))
    atoms.calc = make_calculator(atoms)

    initial = float(atoms.get_potential_energy())
    frames: list[list[list[float]]] = []
    energies: list[float] = []

    def record() -> None:
        frames.append(np.asarray(atoms.get_positions(), dtype=float).round(4).tolist())
        energies.append(round(float(atoms.get_potential_energy()), 6))

    opt = BFGS(atoms, logfile=None)
    opt.attach(record, interval=1)
    converged = bool(opt.run(fmax=fmax, steps=steps))
    if not frames:
        record()

    final = float(atoms.get_potential_energy())
    periodic = bool(np.any(atoms.pbc))
    return {
        "energy_ev": round(final, 6),
        "initial_energy_ev": round(initial, 6),
        "relaxation_drop_ev": round(initial - final, 6),
        "max_force": round(float(np.abs(atoms.get_forces()).max()), 6),
        "steps_taken": len(frames),
        "converged": converged,
        "n_atoms": len(atoms),
        "atoms": atoms_to_dict(atoms),
        "trajectory": {
            "symbols": [str(s) for s in atoms.get_chemical_symbols()],
            "cell": np.asarray(atoms.cell.array, dtype=float).round(4).tolist()
            if periodic
            else None,
            "pbc": periodic,
            "frames": frames,
            "energies": energies,
        },
    }


def _frontier_orbitals(atoms) -> dict[str, float]:
    """HOMO, LUMO and their gap (eV) from an already-attached calculator."""
    res = atoms.calc._res
    if res is None:
        raise ValueError("tblite returned no result object; cannot read orbitals")
    data = res.dict()
    if "orbital-energies" not in data or "orbital-occupations" not in data:
        raise ValueError(
            "this tblite build does not expose orbital energies; "
            f"available keys: {sorted(data)}"
        )

    # tblite reports orbital energies in Hartree.
    eps = np.asarray(data["orbital-energies"], dtype=float) * Hartree
    occ = np.asarray(data["orbital-occupations"], dtype=float)
    occupied = occ > OCCUPATION_THRESHOLD
    if not occupied.any() or occupied.all():
        raise ValueError(
            f"cannot identify HOMO and LUMO: {int(occupied.sum())} of "
            f"{len(occ)} orbitals occupied above {OCCUPATION_THRESHOLD}"
        )
    homo = float(eps[occupied].max())
    lumo = float(eps[~occupied].min())
    gap = lumo - homo
    if not np.isfinite(gap):
        raise ValueError("non-finite HOMO-LUMO gap")
    return {
        "homo_lumo_gap_ev": round(gap, 6),
        "homo_ev": round(homo, 6),
        "lumo_ev": round(lumo, 6),
        "n_orbitals": len(occ),
        "n_occupied": int(occupied.sum()),
        "electronic_temperature_k": ELECTRONIC_TEMPERATURE,
        "method": (
            f"{METHOD} frontier orbital energies, Fermi smearing at "
            f"{ELECTRONIC_TEMPERATURE:.0f} K, occupation threshold "
            f"{OCCUPATION_THRESHOLD}"
        ),
    }


def op_gap(req: dict[str, Any]) -> dict[str, Any]:
    """HOMO-LUMO gap from GFN2-xTB orbital energies.

    This is a *proxy* for chemical/oxidative susceptibility, not a measured
    degradation rate and not an experimental band gap. A semiempirical
    tight-binding frontier-orbital gap correlates loosely with how readily a
    molecule is oxidised or attacked; it says nothing about a specific
    degradation pathway, solvent, pH or excipient. Callers must set
    `is_proxy=True`.
    """
    atoms = dict_to_atoms(req["atoms"])
    atoms.calc = make_calculator(atoms)
    atoms.get_potential_energy()
    return _frontier_orbitals(atoms)


# --------------------------------------------------------------------------
# Molecular-crystal connectivity
# --------------------------------------------------------------------------


def _components(atoms) -> tuple[list[list[int]], dict[int, np.ndarray]]:
    """Connected molecular units, and the lattice shift that unwraps each atom.

    Bonds come from ASE's natural covalent cutoffs under minimum-image
    convention. Breadth-first traversal assigns every atom in a component an
    integer lattice offset, so a molecule split across a cell boundary is put
    back together whole.
    """
    from ase.neighborlist import natural_cutoffs, neighbor_list

    cutoffs = natural_cutoffs(atoms, mult=1.2)
    i_idx, j_idx, shifts = neighbor_list("ijS", atoms, cutoffs)

    adjacency: dict[int, list[tuple[int, np.ndarray]]] = {i: [] for i in range(len(atoms))}
    for a, b, s in zip(i_idx, j_idx, shifts):
        adjacency[int(a)].append((int(b), np.asarray(s, dtype=float)))

    seen: set[int] = set()
    comps: list[list[int]] = []
    offsets: dict[int, np.ndarray] = {}
    for start in range(len(atoms)):
        if start in seen:
            continue
        comp = [start]
        seen.add(start)
        offsets[start] = np.zeros(3)
        queue = [start]
        while queue:
            cur = queue.pop(0)
            for nb, shift in adjacency[cur]:
                if nb in seen:
                    continue
                seen.add(nb)
                offsets[nb] = offsets[cur] + shift
                comp.append(nb)
                queue.append(nb)
        comps.append(sorted(comp))
    return comps, offsets


def _unwrapped(atoms, comp: list[int], offsets: dict[int, np.ndarray]):
    """One molecule as a non-periodic Atoms, reassembled across boundaries."""
    from ase import Atoms

    cell = np.asarray(atoms.cell.array, dtype=float)
    positions = np.asarray(atoms.get_positions(), dtype=float)
    symbols = [str(s) for s in atoms.get_chemical_symbols()]
    pos = np.array([positions[i] + offsets[i] @ cell for i in comp])
    return Atoms(symbols=[symbols[i] for i in comp], positions=pos, pbc=False)


def _formula_key(mol) -> str:
    return mol.get_chemical_formula(mode="hill")


def analyze_crystal(atoms) -> dict[str, Any]:
    """Molecular decomposition of a periodic crystal. Raises when ambiguous."""
    if not np.any(atoms.pbc):
        raise ValueError("not a periodic structure; lattice energy needs a crystal")
    comps, offsets = _components(atoms)
    molecules = [_unwrapped(atoms, c, offsets) for c in comps]
    formulas = sorted({_formula_key(m) for m in molecules})
    return {
        "n_components": len(comps),
        "components": comps,
        "formulas": formulas,
        "molecules": molecules,
        "offsets": offsets,
        "atoms_per_molecule": [len(c) for c in comps],
    }


def op_molecules(req: dict[str, Any]) -> dict[str, Any]:
    """Report how a crystal decomposes into molecules, without any energy."""
    atoms = dict_to_atoms(req["atoms"])
    info = analyze_crystal(atoms)
    return {
        "n_components": info["n_components"],
        "formulas": info["formulas"],
        "atoms_per_molecule": info["atoms_per_molecule"],
        "n_atoms": len(atoms),
        "single_component_type": len(info["formulas"]) == 1,
        "crystal_packing": {
            "symbols": [str(s) for s in atoms.get_chemical_symbols()],
            "cell": np.asarray(atoms.cell.array, dtype=float).round(4).tolist(),
            "positions": np.asarray(atoms.get_positions(), dtype=float).round(4).tolist(),
            "molecules": info["components"],
        },
    }


def _canonical_smiles(mol) -> str:
    """Perceive bond orders and return a canonical SMILES for one molecule."""
    from rdkit import Chem
    from rdkit.Chem import rdDetermineBonds

    xyz_lines = [str(len(mol)), ""]
    for sym, pos in zip(mol.get_chemical_symbols(), mol.get_positions()):
        xyz_lines.append(f"{sym} {pos[0]:.6f} {pos[1]:.6f} {pos[2]:.6f}")
    raw = Chem.MolFromXYZBlock("\n".join(xyz_lines))
    if raw is None:
        raise ValueError("RDKit could not read the extracted molecule geometry")
    rdDetermineBonds.DetermineBonds(raw, charge=0)
    return Chem.MolToSmiles(Chem.RemoveHs(raw))


def _gas_phase_energy(smiles: str, *, fmax: float, steps: int) -> dict[str, Any]:
    """Relaxed GFN2-xTB energy of one isolated molecule, cached by SMILES."""
    from ase.optimize import BFGS

    if smiles in _gas_cache:
        return {**_gas_cache[smiles], "cached": True}
    mol = smiles_to_atoms(smiles)
    mol.calc = make_calculator(mol)
    BFGS(mol, logfile=None).run(fmax=fmax, steps=steps)
    e = float(mol.get_potential_energy())
    if not np.isfinite(e):
        raise ValueError("non-finite gas-phase energy")

    # Frontier orbitals of the relaxed reference molecule come for free here:
    # the SCF result is already in hand. This is the only place a molecular
    # HOMO-LUMO gap can be had for a crystal candidate, since the Gamma-point
    # orbitals of a periodic cell are not the molecular gap.
    entry: dict[str, Any] = {"energy_ev": e, "n_atoms": len(mol)}
    try:
        entry.update(_frontier_orbitals(mol))
    except Exception as exc:  # noqa: BLE001 — reported, not silently dropped
        entry["orbital_error"] = f"{type(exc).__name__}: {exc}"
    _gas_cache[smiles] = entry
    return {**entry, "cached": False}


def op_lattice_energy(req: dict[str, Any]) -> dict[str, Any]:
    """Lattice energy per molecule of a molecular crystal.

    Fails loudly (never returns a plausible substitute) when the crystal is not
    a single-component molecular solid: a hydrate, solvate or co-crystal has
    more than one distinct molecule, and its lattice energy per molecule is not
    comparable with a pure polymorph's.
    """
    from ase.optimize import BFGS

    atoms = dict_to_atoms(req["atoms"])
    fmax = float(req.get("fmax", 0.05))
    steps = int(req.get("steps", 200))
    gas_steps = int(req.get("gas_steps", 400))
    min_cell = float(req.get("min_cell_length", 8.0))

    info = analyze_crystal(atoms)
    if len(info["formulas"]) != 1:
        raise ValueError(
            "crystal contains more than one distinct molecule "
            f"({', '.join(info['formulas'])}); lattice energy per molecule is "
            "not defined for a hydrate, solvate or co-crystal here"
        )
    z_cell = info["n_components"]

    # Canonical SMILES, from the molecule in the crystal unless the caller
    # supplies one. This identifies *which* molecule the reference is for; the
    # reference geometry itself always comes from the SMILES.
    smiles = req.get("smiles")
    perceived = None
    try:
        perceived = _canonical_smiles(info["molecules"][0])
    except Exception as exc:  # noqa: BLE001 — reported, never silently dropped
        perception_error = f"{type(exc).__name__}: {exc}"
    else:
        perception_error = None
    if not smiles:
        if perceived is None:
            raise ValueError(
                "could not perceive bond orders for the molecule in this "
                f"crystal and no `smiles` was supplied ({perception_error}). "
                "COD entries often omit hydrogens or are disordered."
            )
        smiles = perceived

    # Gamma-point only: replicate so the cell is at least `min_cell` across.
    from athanor.pores import perpendicular_widths

    widths = perpendicular_widths(np.asarray(atoms.cell.array, dtype=float))
    reps = tuple(max(1, int(np.ceil(min_cell / max(w, 1e-6)))) for w in widths)
    crystal = atoms * reps if reps != (1, 1, 1) else atoms.copy()
    z_total = z_cell * int(np.prod(reps))

    crystal.calc = make_calculator(crystal)
    e_initial = float(crystal.get_potential_energy())
    opt = BFGS(crystal, logfile=None)
    converged = bool(opt.run(fmax=fmax, steps=steps))
    e_crystal = float(crystal.get_potential_energy())
    if not np.isfinite(e_crystal):
        raise ValueError("non-finite crystal energy")

    gas = _gas_phase_energy(smiles, fmax=fmax, steps=gas_steps)
    e_gas = gas["energy_ev"]

    # A reference SMILES carrying formal charges means the molecule sits in the
    # crystal as a zwitterion (glycine does). An isolated zwitterion is NOT a
    # gas-phase minimum — it tautomerises to the neutral form — so the absolute
    # lattice energy against such a reference is unreliable. Differences
    # between polymorphs of the same molecule still cancel it exactly, which is
    # the number that gets used.
    zwitterionic = ("+" in smiles and "-" in smiles)

    e_latt = e_crystal / z_total - e_gas
    return {
        "homo_lumo_gap_ev": gas.get("homo_lumo_gap_ev"),
        "homo_ev": gas.get("homo_ev"),
        "lumo_ev": gas.get("lumo_ev"),
        "orbital_error": gas.get("orbital_error"),
        "gas_reference_zwitterionic": zwitterionic,
        "lattice_energy_ev_per_molecule": round(e_latt, 6),
        "lattice_energy_kj_per_mol": round(e_latt * 96.48533212, 4),
        "crystal_energy_ev": round(e_crystal, 6),
        "crystal_energy_per_molecule_ev": round(e_crystal / z_total, 6),
        "crystal_initial_energy_ev": round(e_initial, 6),
        "gas_phase_energy_ev": round(e_gas, 6),
        "gas_reference_smiles": smiles,
        "gas_reference_cached": bool(gas.get("cached")),
        "perceived_smiles": perceived,
        "perception_error": perception_error,
        "z_unit_cell": z_cell,
        "z_total": z_total,
        "supercell": list(reps),
        "n_atoms": len(crystal),
        "atoms_per_molecule": info["atoms_per_molecule"][0],
        "converged": converged,
        "gamma_point_only": True,
        "method": (
            f"{METHOD} (tblite, Gamma point only); E_latt = E(crystal)/Z - "
            f"E(isolated molecule); atom positions relaxed with BFGS to fmax "
            f"{fmax:.2f} eV/A at the experimental cell (cell NOT relaxed); "
            f"gas reference embedded from canonical SMILES and relaxed; "
            f"supercell {reps[0]}x{reps[1]}x{reps[2]}, Z={z_total}"
        ),
        "crystal_packing": {
            "symbols": [str(s) for s in atoms.get_chemical_symbols()],
            "cell": np.asarray(atoms.cell.array, dtype=float).round(4).tolist(),
            "positions": np.asarray(atoms.get_positions(), dtype=float).round(4).tolist(),
            "molecules": info["components"],
        },
    }


OPS = {
    "ping": op_ping,
    "energy": op_energy,
    "relax": op_relax,
    "gap": op_gap,
    "molecules": op_molecules,
    "lattice_energy": op_lattice_energy,
}


def handle(req: dict[str, Any]) -> dict[str, Any]:
    op = req.get("op")
    if op not in OPS:
        raise ValueError(f"unknown op {op!r}; known: {sorted(OPS)}")
    return OPS[op](req)


if __name__ == "__main__":
    from athanor.workers.base import serve

    serve(handle)
