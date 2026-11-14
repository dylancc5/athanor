"""Structure serialization shared by the server and every worker.

Deliberately depends only on `ase` + `numpy` (no pydantic, no torch), because
it is imported inside each isolated worker environment as well as the server.

A structure crosses the process boundary as a plain dict, `AtomsDict`:
    {"symbols": [...], "positions": [[x,y,z],...], "cell": [[..]x3]|None, "pbc": bool}
"""

from __future__ import annotations

import io
from typing import Any, TypedDict

import numpy as np
from ase import Atoms
from ase.io import read as ase_read
from ase.io import write as ase_write


class AtomsDict(TypedDict, total=False):
    symbols: list[str]
    positions: list[list[float]]
    cell: list[list[float]] | None
    pbc: bool


def atoms_to_dict(atoms: Atoms) -> AtomsDict:
    periodic = bool(np.any(atoms.pbc))
    return {
        "symbols": [str(s) for s in atoms.get_chemical_symbols()],
        "positions": np.asarray(atoms.get_positions(), dtype=float).round(6).tolist(),
        "cell": np.asarray(atoms.cell.array, dtype=float).round(6).tolist() if periodic else None,
        "pbc": periodic,
    }


def dict_to_atoms(d: AtomsDict) -> Atoms:
    cell = d.get("cell")
    return Atoms(
        symbols=list(d["symbols"]),
        positions=np.asarray(d["positions"], dtype=float),
        cell=np.asarray(cell, dtype=float) if cell is not None else None,
        pbc=bool(d.get("pbc", cell is not None)),
    )


# --------------------------------------------------------------------------
# Format conversion
# --------------------------------------------------------------------------


def parse_structure(text: str, repr_kind: str) -> Atoms:
    """Turn a serialized candidate structure into ASE `Atoms`.

    `smiles` is embedded to 3D with RDKit (available in the xtb worker
    environment and the server, not in the torch environments).
    """
    if repr_kind == "smiles":
        return smiles_to_atoms(text)
    fmt = {"cif": "cif", "xyz": "extxyz", "pdb": "proteindatabank"}.get(repr_kind)
    if fmt is None:
        raise ValueError(f"unsupported repr_kind: {repr_kind!r}")
    if fmt == "extxyz":
        try:
            return ase_read(io.StringIO(text), format="extxyz")
        except Exception:  # noqa: BLE001 — extxyz is a superset of xyz; any
            # parse failure is worth retrying as plain xyz, and the retry
            # raises on its own if the text is genuinely not a structure.
            return ase_read(io.StringIO(text), format="xyz")
    return ase_read(io.StringIO(text), format=fmt)


def atoms_to_cif(atoms: Atoms) -> str:
    # ASE's CIF writer wants a binary stream.
    buf = io.BytesIO()
    ase_write(buf, atoms, format="cif")
    return buf.getvalue().decode()


def atoms_to_xyz(atoms: Atoms) -> str:
    buf = io.StringIO()
    ase_write(buf, atoms, format="extxyz")
    return buf.getvalue()


def smiles_to_atoms(smiles: str, *, seed: int = 0xA7) -> Atoms:
    """Embed a SMILES string to a single 3D conformer, MMFF-relaxed.

    Deterministic: fixed random seed, and the lowest-energy conformer of a
    small fixed-size ensemble.
    """
    from rdkit import Chem
    from rdkit.Chem import AllChem

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"RDKit could not parse SMILES: {smiles!r}")
    mol = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = seed
    cids = AllChem.EmbedMultipleConfs(mol, numConfs=8, params=params)
    if not cids:
        raise ValueError(f"RDKit could not embed SMILES: {smiles!r}")
    energies: list[tuple[float, int]] = []
    for cid in cids:
        try:
            ff = AllChem.MMFFGetMoleculeForceField(
                mol, AllChem.MMFFGetMoleculeProperties(mol), confId=cid
            )
            ff.Minimize(maxIts=500)
            energies.append((ff.CalcEnergy(), cid))
        except Exception:  # noqa: BLE001 — fall back to the unrelaxed conformer
            energies.append((float("inf"), cid))
    best = min(energies)[1]
    conf = mol.GetConformer(best)
    return Atoms(
        symbols=[a.GetSymbol() for a in mol.GetAtoms()],
        positions=np.asarray(conf.GetPositions(), dtype=float),
        pbc=False,
    )


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------


def composition(atoms: Atoms) -> dict[str, int]:
    out: dict[str, int] = {}
    for s in atoms.get_chemical_symbols():
        out[str(s)] = out.get(str(s), 0) + 1
    return out


def reduced_formula(atoms: Atoms) -> str:
    from functools import reduce
    from math import gcd

    comp = composition(atoms)
    if not comp:
        return ""
    g = reduce(gcd, comp.values())
    parts = []
    for el in sorted(comp, key=lambda e: (e != "Li", e)):
        n = comp[el] // g
        parts.append(el if n == 1 else f"{el}{n}")
    return "".join(parts)


def supercell_for_min_length(atoms: Atoms, min_length: float = 8.0) -> tuple[int, int, int]:
    """Repetitions needed so each cell vector is at least `min_length` long.

    Used to keep a periodic image from interacting with itself (e.g. a
    migrating ion seeing its own copy across the cell).
    """
    if not np.any(atoms.pbc):
        return (1, 1, 1)
    lengths = atoms.cell.lengths()
    return tuple(max(1, int(np.ceil(min_length / max(l, 1e-6)))) for l in lengths)  # type: ignore[return-value]


def center_of_mass_distance(atoms: Atoms, i: int, j: int) -> float:
    return float(atoms.get_distance(i, j, mic=bool(np.any(atoms.pbc))))


def as_json_safe(obj: Any) -> Any:
    """Recursively convert numpy scalars/arrays so `json.dumps` accepts them."""
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, dict):
        return {k: as_json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [as_json_safe(v) for v in obj]
    return obj
