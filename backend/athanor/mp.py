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

from .structure import AtomsDict, dict_to_atoms

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
CACHE_DIR = Path(os.environ.get("ATHANOR_MP_CACHE", REPO_ROOT / "data" / "cache" / "mp"))

# Bump when the shape of a cached payload changes, so stale entries are ignored
# instead of being deserialized into the wrong fields.
CACHE_SCHEMA = 1

SOURCE = "materials_project"

# Fields we always ask for. `energy_per_atom` is here so a MACE energy can be
# sanity-checked against DFT rather than reported in a vacuum.
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

    result = compute()
    CACHE_STATS["misses"] += 1
    text = json.dumps(
        {"schema": CACHE_SCHEMA, "op": op, "params": params, "result": result},
        sort_keys=True,
        default=str,
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
        except Exception as exc:  # noqa: BLE001 — surfaced, never defaulted
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
        except Exception as exc:  # noqa: BLE001 — surfaced, never defaulted
            raise MPError(f"summary lookup of {mid} failed: {type(exc).__name__}: {exc}") from exc
        if not docs:
            raise MPError(f"{mid}: no such material in Materials Project")
        return _doc_to_json(docs[0], with_structure=True)

    entry = MPEntry.from_json(_cached("entry", params, compute))
    if not with_structure:
        entry = MPEntry.from_json({**entry.to_json(), "structure": None})
    return entry


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
