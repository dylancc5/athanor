"""Materials Project access: near-hull search, structures, and real DFT numbers.

Why this module exists: `energy_above_hull` and `band_gap` are the two numbers in
a solid-electrolyte campaign that ATHANOR does *not* compute. They come from the
Materials Project's DFT workflows. Reading them from the database rather than
estimating them is the whole point — see the honesty rules in `contracts.py`.

Everything is cached on disk under `data/cache/mp/`, keyed by a hash of the
query, so a demo run is fast and repeatable and a second run needs no network.
A cache hit returns a value *identical* to the miss that produced it: the miss
path normalizes through JSON before returning, so both paths yield the same
types and the same rounded floats.

mp-api is synchronous and does real HTTP. Call the `a*` coroutines from the
server so the event loop (and the SSE stream) is never blocked.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from ase import Atoms

from .structure import AtomsDict, as_json_safe, dict_to_atoms

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
CACHE_DIR = Path(os.environ.get("ATHANOR_MP_CACHE", REPO_ROOT / "data" / "cache" / "mp"))

# Bump when the shape of a cached payload changes, so stale entries are ignored
# instead of being deserialized into the wrong fields.
CACHE_SCHEMA = 1

SOURCE = "materials_project"

# The summary endpoint aggregates the *mixed* GGA/GGA+U/r2SCAN thermo scheme.
# Its `uncorrected_energy_per_atom` is therefore the r2SCAN energy, which is on
# a completely different scale from GGA — for mp-985583 the two differ by
# 2.47 eV/atom. MACE-MP-0 was fitted to MPtrj, i.e. raw GGA/GGA+U VASP
# energies, so comparing a MACE energy against the summary's "uncorrected"
# number is meaningless. `get_thermo` fetches the GGA_GGA+U entry instead.
MIXED_SCHEME = "GGA_GGA+U_R2SCAN"
MACE_TRAINING_SCHEME = "GGA_GGA+U"

# Fields we always ask for.
SUMMARY_FIELDS = (
    "material_id",
    "formula_pretty",
    "chemsys",
    "elements",
    "nsites",
    "energy_above_hull",
    "band_gap",
    "is_stable",
    "energy_per_atom",
    "uncorrected_energy_per_atom",
    "theoretical",
)


class MPError(RuntimeError):
    """Materials Project could not answer. Never swallowed into a default."""


# --------------------------------------------------------------------------
# Entries
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class MPEntry:
    """One Materials Project summary record, plus its structure as an AtomsDict.

    `energy_above_hull` and `band_gap` are MP's DFT values, not ours.
    """

    material_id: str
    formula_pretty: str
    chemsys: str
    elements: tuple[str, ...]
    n_sites: int
    energy_above_hull: float | None
    band_gap: float | None
    energy_per_atom: float | None
    uncorrected_energy_per_atom: float | None
    is_stable: bool | None
    theoretical: bool | None
    structure: AtomsDict | None = None

    def atoms(self) -> Atoms:
        if self.structure is None:
            raise MPError(f"{self.material_id}: entry was fetched without a structure")
        return dict_to_atoms(self.structure)

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["elements"] = list(self.elements)
        return d

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> MPEntry:
        d = dict(d)
        d["elements"] = tuple(d.get("elements") or ())
        return cls(**d)


# --------------------------------------------------------------------------
# Disk cache
# --------------------------------------------------------------------------

CACHE_STATS: dict[str, int] = {"hits": 0, "misses": 0}


def _cache_key(op: str, params: dict[str, Any]) -> str:
    blob = json.dumps(
        {"schema": CACHE_SCHEMA, "op": op, "params": params},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(blob.encode()).hexdigest()[:40]


def _cache_path(op: str, key: str) -> Path:
    return CACHE_DIR / f"{op}-{key}.json"


def _cached(op: str, params: dict[str, Any], compute) -> Any:
    """Return `compute()`'s JSON-safe result, reading/writing the disk cache.

    The miss path round-trips the fresh result through JSON before returning it,
    so a caller cannot tell a hit from a miss: same types, same values.
    """
    key = _cache_key(op, params)
    path = _cache_path(op, key)
    if path.exists():
        try:
            entry = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise MPError(f"corrupt cache entry {path}: {exc}") from exc
        if entry.get("schema") == CACHE_SCHEMA:
            CACHE_STATS["hits"] += 1
            return entry["result"]

    # `as_json_safe` converts numpy scalars to Python ones. Note the absence of
    # `default=str`: with it, a np.int64 serializes to the *string* "30" and the
    # cache quietly changes a field's type. Anything it cannot convert must
    # raise here rather than be stringified into the cache.
    result = as_json_safe(compute())
    CACHE_STATS["misses"] += 1
    text = json.dumps(
        {"schema": CACHE_SCHEMA, "op": op, "params": params, "result": result},
        sort_keys=True,
    )
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    # Atomic: a crash mid-write must not leave a half file that later parses.
    fd, tmp = tempfile.mkstemp(dir=str(CACHE_DIR), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return json.loads(text)["result"]


def cache_info() -> dict[str, Any]:
    files = sorted(CACHE_DIR.glob("*.json")) if CACHE_DIR.exists() else []
    return {"dir": str(CACHE_DIR), "entries": len(files), **CACHE_STATS}


# --------------------------------------------------------------------------
# API access
# --------------------------------------------------------------------------


def api_key() -> str:
    key = os.environ.get("MP_API_KEY")
    if not key:
        from dotenv import load_dotenv

        load_dotenv(REPO_ROOT / ".env")
        key = os.environ.get("MP_API_KEY")
    if not key:
        raise MPError("MP_API_KEY is not set (expected in the repo-root .env)")
    return key


def _rester():
    from mp_api.client import MPRester

    return MPRester(api_key())


def _structure_to_dict(structure) -> AtomsDict:
    from pymatgen.io.ase import AseAtomsAdaptor

    from .structure import atoms_to_dict

    return atoms_to_dict(AseAtomsAdaptor.get_atoms(structure))


def _doc_to_json(doc, *, with_structure: bool) -> dict[str, Any]:
    def num(x):
        return None if x is None else float(x)

    return MPEntry(
        material_id=str(doc.material_id),
        formula_pretty=str(doc.formula_pretty),
        chemsys=str(getattr(doc, "chemsys", "") or ""),
        elements=tuple(sorted(str(e) for e in (getattr(doc, "elements", None) or ()))),
        n_sites=int(getattr(doc, "nsites", 0) or 0),
        energy_above_hull=num(getattr(doc, "energy_above_hull", None)),
        band_gap=num(getattr(doc, "band_gap", None)),
        energy_per_atom=num(getattr(doc, "energy_per_atom", None)),
        uncorrected_energy_per_atom=num(getattr(doc, "uncorrected_energy_per_atom", None)),
        is_stable=None if getattr(doc, "is_stable", None) is None else bool(doc.is_stable),
        theoretical=None if getattr(doc, "theoretical", None) is None else bool(doc.theoretical),
        structure=_structure_to_dict(doc.structure) if with_structure else None,
    ).to_json()


# --------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------


def search_near_hull(
    *,
    chemsys: str | None = None,
    elements: list[str] | None = None,
    must_contain: str | None = None,
    exclude_elements: list[str] | None = None,
    max_e_above_hull: float | None = 0.05,
    max_atoms: int | None = None,
    min_atoms_of: dict[str, int] | None = None,
    max_band_gap: float | None = None,
    min_band_gap: float | None = None,
    limit: int = 10,
    with_structures: bool = True,
) -> list[MPEntry]:
    """Near-hull candidates for a chemical system, most stable first.

    Filtering happens server-side wherever MP supports it (`num_sites`,
    `energy_above_hull`, `exclude_elements`, `band_gap`) so we do not download a
    whole chemical system to throw most of it away. `min_atoms_of` (e.g.
    `{"Li": 2}`) is applied locally because MP has no per-element count filter —
    it matters because a vacancy-mediated NEB needs at least two mobile sites.

    Ordering is deterministic: `(energy_above_hull, material_id)`.
    """
    if not chemsys and not elements:
        raise ValueError("pass chemsys or elements")
    if must_contain and elements and must_contain not in elements:
        elements = [*elements, must_contain]

    params = {
        "chemsys": chemsys,
        "elements": sorted(elements) if elements else None,
        "must_contain": must_contain,
        "exclude_elements": sorted(exclude_elements) if exclude_elements else None,
        "max_e_above_hull": max_e_above_hull,
        "max_atoms": max_atoms,
        "min_atoms_of": dict(sorted((min_atoms_of or {}).items())),
        "max_band_gap": max_band_gap,
        "min_band_gap": min_band_gap,
        "limit": limit,
        "with_structures": with_structures,
        "fields": list(SUMMARY_FIELDS),
    }

    def compute() -> list[dict[str, Any]]:
        query: dict[str, Any] = {"fields": [*SUMMARY_FIELDS, "structure"]}
        if chemsys:
            query["chemsys"] = chemsys
        if elements:
            query["elements"] = sorted(elements)
        if exclude_elements:
            query["exclude_elements"] = sorted(exclude_elements)
        if max_e_above_hull is not None:
            query["energy_above_hull"] = (0.0, float(max_e_above_hull))
        if max_atoms is not None:
            query["num_sites"] = (1, int(max_atoms))
        if min_band_gap is not None or max_band_gap is not None:
            query["band_gap"] = (
                float(min_band_gap) if min_band_gap is not None else 0.0,
                float(max_band_gap) if max_band_gap is not None else 100.0,
            )
        try:
            with _rester() as mpr:
                docs = mpr.materials.summary.search(**query)
        except Exception as exc:
            raise MPError(f"summary.search failed: {type(exc).__name__}: {exc}") from exc

        out: list[dict[str, Any]] = []
        for doc in docs:
            comp = doc.structure.composition.as_dict()
            if must_contain and must_contain not in comp:
                continue
            if any(comp.get(el, 0) < n for el, n in (min_atoms_of or {}).items()):
                continue
            out.append(_doc_to_json(doc, with_structure=True))
        out.sort(key=lambda d: (d["energy_above_hull"] or 0.0, d["material_id"]))
        return out[: int(limit)]

    rows = _cached("search", params, compute)
    entries = [MPEntry.from_json(r) for r in rows]
    if not with_structures:
        # Structures are always cached (they are the expensive part); drop them
        # on the way out when the caller only wanted the numbers.
        entries = [MPEntry.from_json({**e.to_json(), "structure": None}) for e in entries]
    return entries


def get_entry(material_id: str, *, with_structure: bool = True) -> MPEntry:
    """One material by id, with its real `energy_above_hull` and `band_gap`."""
    mid = str(material_id).strip()
    if not mid:
        raise ValueError("material_id is empty")
    params = {"material_id": mid, "fields": list(SUMMARY_FIELDS)}

    def compute() -> dict[str, Any]:
        try:
            with _rester() as mpr:
                docs = mpr.materials.summary.search(
                    material_ids=[mid], fields=[*SUMMARY_FIELDS, "structure"]
                )
        except Exception as exc:
            raise MPError(f"summary lookup of {mid} failed: {type(exc).__name__}: {exc}") from exc
        if not docs:
            raise MPError(f"{mid}: no such material in Materials Project")
        return _doc_to_json(docs[0], with_structure=True)

    entry = MPEntry.from_json(_cached("entry", params, compute))
    if not with_structure:
        entry = MPEntry.from_json({**entry.to_json(), "structure": None})
    return entry


def competing_phases(elements: list[str], *, max_atoms: int | None = 80) -> dict[str, Any]:
    """Every known phase in a chemical system, as structures to be re-relaxed.

    These are the phases a candidate competes against on a convex hull. Note
    what is and is not used: the *structures* and *compositions* come from
    Materials Project, the *energies* do not — the caller recomputes those with
    its own potential so the hull and the candidate sit on one energy scale.
    Mixing MP's DFT energies with MACE energies would be meaningless, as the
    two use different reference states.

    `get_entries_in_chemsys` is the right call here because it spans every
    subsystem (for Li-P-S: Li, P, S, Li-P, Li-S, P-S and Li-P-S), and a hull
    is undefined without the elemental endpoints. It is pinned to the
    `GGA_GGA+U` thermo type for two reasons: mixing functionals would return
    several entries per material and waste a relaxation on each duplicate, and
    GGA/GGA+U is the functional MACE-MP-0 was itself trained on, so these are
    the structures closest to what the model expects. Only the structures are
    used, never these entries' energies.

    Returns `{"phases": [...], "skipped_large": n, "skipped_no_structure": n,
    "total": n}`, sorted deterministically by material id. `max_atoms` filters
    out cells too large to relax, and the skip counts are returned rather than
    discarded because a dropped phase could have been a true hull vertex — the
    caller states this on the measurement.
    """
    els = sorted({str(e) for e in elements})
    if not els:
        raise ValueError("no elements given")
    params = {"elements": els, "max_atoms": max_atoms}

    def compute() -> dict[str, Any]:
        try:
            with _rester() as mpr:
                entries = mpr.get_entries_in_chemsys(
                    els,
                    compatible_only=False,
                    additional_criteria={"thermo_types": [MACE_TRAINING_SCHEME]},
                )
        except Exception as exc:
            raise MPError(
                f"get_entries_in_chemsys({els}) failed: {type(exc).__name__}: {exc}"
            ) from exc

        out: list[dict[str, Any]] = []
        skipped_large = 0
        skipped_no_structure = 0
        for entry in entries:
            structure = getattr(entry, "structure", None)
            if structure is None:
                skipped_no_structure += 1  # cannot be re-relaxed
                continue
            n_sites = len(structure)
            if max_atoms is not None and n_sites > int(max_atoms):
                skipped_large += 1
                continue
            out.append(
                {
                    "material_id": str(getattr(entry, "entry_id", "") or ""),
                    "formula_pretty": str(structure.composition.reduced_formula),
                    "composition": {
                        str(el): float(n)
                        for el, n in sorted(
                            structure.composition.as_dict().items(), key=lambda kv: str(kv[0])
                        )
                    },
                    "n_sites": n_sites,
                    "structure": _structure_to_dict(structure),
                }
            )
        out.sort(key=lambda d: (d["material_id"], d["formula_pretty"]))
        return {
            "phases": out,
            "skipped_large": skipped_large,
            "skipped_no_structure": skipped_no_structure,
            "total": len(entries),
            "elements": els,
            "max_atoms": max_atoms,
        }

    return _cached("phases", params, compute)


async def acompeting_phases(elements: list[str], *, max_atoms: int | None = 80):
    return await asyncio.to_thread(competing_phases, elements, max_atoms=max_atoms)


def get_thermo(material_id: str) -> dict[str, Any]:
    """Per-scheme thermodynamic entries for one material, keyed by thermo type.

    Needed because MACE-MP-0's training energies are raw GGA/GGA+U, and only
    this endpoint exposes that scheme's `uncorrected_energy_per_atom` separately
    from the mixed-scheme value the summary reports.
    """
    mid = str(material_id).strip()
    if not mid:
        raise ValueError("material_id is empty")
    fields = [
        "thermo_type",
        "energy_per_atom",
        "uncorrected_energy_per_atom",
        "energy_above_hull",
        "formation_energy_per_atom",
    ]

    def compute() -> dict[str, Any]:
        try:
            with _rester() as mpr:
                docs = mpr.materials.thermo.search(material_ids=[mid], fields=fields)
        except Exception as exc:
            raise MPError(f"thermo lookup of {mid} failed: {type(exc).__name__}: {exc}") from exc
        out: dict[str, Any] = {}
        for doc in docs:
            out[str(doc.thermo_type)] = {
                f: (None if getattr(doc, f, None) is None else float(getattr(doc, f)))
                for f in fields
                if f != "thermo_type"
            }
        return out

    return _cached("thermo", {"material_id": mid, "fields": fields}, compute)


def gga_reference_energy_per_atom(material_id: str) -> float | None:
    """The raw GGA/GGA+U energy per atom MACE-MP-0 was trained to reproduce.

    None when Materials Project has no GGA/GGA+U entry for this material (some
    are r2SCAN-only), in which case callers must omit the comparison rather
    than fall back to a value on a different energy scale.
    """
    entry = get_thermo(material_id).get(MACE_TRAINING_SCHEME)
    if not entry:
        return None
    value = entry.get("uncorrected_energy_per_atom")
    return None if value is None else float(value)


async def aget_thermo(material_id: str) -> dict[str, Any]:
    return await asyncio.to_thread(get_thermo, material_id)


async def agga_reference_energy_per_atom(material_id: str) -> float | None:
    return await asyncio.to_thread(gga_reference_energy_per_atom, material_id)


def get_structure(material_id: str) -> Atoms:
    """Fetch a structure by material id as ASE `Atoms`."""
    return get_entry(material_id).atoms()


# --------------------------------------------------------------------------
# Async wrappers (mp-api is blocking)
# --------------------------------------------------------------------------


async def asearch_near_hull(**kwargs) -> list[MPEntry]:
    return await asyncio.to_thread(lambda: search_near_hull(**kwargs))


async def aget_entry(material_id: str, *, with_structure: bool = True) -> MPEntry:
    return await asyncio.to_thread(get_entry, material_id, with_structure=with_structure)


async def aget_structure(material_id: str) -> Atoms:
    return await asyncio.to_thread(get_structure, material_id)
