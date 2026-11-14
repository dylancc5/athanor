"""External structure and property databases.

Every structure ATHANOR reasons about comes from a real database read. Nothing
in this module generates a structure, and nothing fills a missing property with
an estimate: a lookup that cannot be answered raises.

Layout
------
A `Source` fetches records for one database. Sources are small and uniform, so
adding a database (or repointing one at a different archive) is configuration
rather than a rewrite:

    PubChemSource     small molecules by name or CID, via PUG-REST
    CodSource         molecular-crystal CIFs by COD id
    CifArchiveSource  a zip of CIFs behind one URL (ODAC promising-MOF set,
                      CoRE MOF 2019), member looked up by refcode
    CsvPropertySource reference property values from a CSV column

Honesty about provenance
------------------------
`PropertyValue.kind` records *how a number came to exist*, because "it came
from a database" is not the same claim as "it was measured":

    "experimental"  measured — a diffraction-determined crystal structure, or a
                    value derived directly from one (cell volume, density)
    "computed"      produced by somebody else's calculation. PubChem's XLogP
                    and TPSA are computed descriptors, not measurements. The
                    ODAC reference adsorption energies are DFT numbers.
    "derived"       arithmetic on another record's fields.

A scorer must not promote a "computed" value to experimental confidence.

Caching
-------
Every fetch is cached on disk under `data/cache/<source>/`, keyed by a hash of
the query. A cache **hit returns a value identical to the miss that produced
it**: the miss path round-trips its result through JSON before returning, so a
caller cannot tell the two apart — same types, same rounded floats. A demo run
therefore needs no network and replays identically.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
import time
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
CACHE_DIR = Path(
    os.environ.get("ATHANOR_RETRIEVAL_CACHE", REPO_ROOT / "data" / "cache")
)

#: Bump when a cached payload's shape changes, so stale entries are ignored
#: rather than deserialized into the wrong fields.
CACHE_SCHEMA = 1

#: Generic client identifier. Deliberately carries no personal or project
#: detail, and no contact address.
USER_AGENT = "athanor-research-client/0.1"

#: PubChem asks for no more than 5 requests/second.
PUBCHEM_MIN_INTERVAL = 0.25

CACHE_STATS: dict[str, int] = {"hits": 0, "misses": 0}


class RetrievalError(RuntimeError):
    """A database could not answer. Never swallowed into a default."""


PropertyKind = Literal["experimental", "computed", "derived"]


@dataclass(frozen=True)
class PropertyValue:
    property: str
    value: float
    unit: str
    kind: PropertyKind
    note: str = ""

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Record:
    """One database entry: what it is, where it came from, what is known."""

    database: str
    external_id: str
    name: str
    structure: str | None = None
    repr_kind: str | None = None  # "cif" | "smiles"
    formula: str | None = None
    properties: tuple[PropertyValue, ...] = ()
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["properties"] = [p.to_json() for p in self.properties]
        return d

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Record:
        d = dict(d)
        d["properties"] = tuple(PropertyValue(**p) for p in d.get("properties") or ())
        d["extra"] = d.get("extra") or {}
        return cls(**d)


# --------------------------------------------------------------------------
# Disk cache
# --------------------------------------------------------------------------


def _cache_key(op: str, params: dict[str, Any]) -> str:
    blob = json.dumps(
        {"schema": CACHE_SCHEMA, "op": op, "params": params},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(blob.encode()).hexdigest()[:40]


def cached_json(namespace: str, op: str, params: dict[str, Any], compute) -> Any:
    """`compute()`'s JSON-safe result, reading and writing the disk cache."""
    directory = CACHE_DIR / namespace
    path = directory / f"{op}-{_cache_key(op, params)}.json"
    if path.exists():
        try:
            entry = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise RetrievalError(f"corrupt cache entry {path}: {exc}") from exc
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
    _atomic_write(path, text)
    # Round-trip so a miss is indistinguishable from a hit.
    return json.loads(text)["result"]


def cached_bytes(namespace: str, name: str, fetch) -> bytes:
    """Binary blob cache (archives). Returns the identical bytes every time."""
    path = CACHE_DIR / namespace / name
    if path.exists():
        CACHE_STATS["hits"] += 1
        return path.read_bytes()
    blob = fetch()
    CACHE_STATS["misses"] += 1
    _atomic_write(path, blob)
    return path.read_bytes()


def _atomic_write(path: Path, data: str | bytes) -> None:
    """Write so a crash mid-write cannot leave a half file that later parses."""
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "wb" if isinstance(data, bytes) else "w"
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, mode) as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def cache_info() -> dict[str, Any]:
    files = sorted(CACHE_DIR.rglob("*")) if CACHE_DIR.exists() else []
    return {
        "dir": str(CACHE_DIR),
        "entries": sum(1 for f in files if f.is_file()),
        **CACHE_STATS,
    }


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

_last_request: dict[str, float] = {}


def http_get(
    url: str,
    *,
    throttle_key: str = "default",
    min_interval: float = 0.0,
    attempts: int = 4,
    backoff: float = 3.5,
    timeout: float = 60.0,
) -> bytes:
    """GET with throttling and retry. Raises `RetrievalError` on give-up.

    COD in particular resets connections under tight loops, so a retry with a
    few seconds of backoff is the difference between a flaky fetch and a
    reliable one. Cached callers hit this at most once per identifier.
    """
    import httpx

    if min_interval > 0:
        elapsed = time.monotonic() - _last_request.get(throttle_key, 0.0)
        if elapsed < min_interval:
            time.sleep(min_interval - elapsed)

    last: Exception | None = None
    for attempt in range(attempts):
        try:
            response = httpx.get(
                url,
                headers={"User-Agent": USER_AGENT},
                timeout=timeout,
                follow_redirects=True,
            )
            _last_request[throttle_key] = time.monotonic()
            if response.status_code == 404:
                raise RetrievalError(f"not found: {url}")
            response.raise_for_status()
            return response.content
        except RetrievalError:
            raise
        except Exception as exc:  # noqa: BLE001 — retried, then reported
            last = exc
            if attempt < attempts - 1:
                time.sleep(backoff * (attempt + 1))
    raise RetrievalError(f"GET {url} failed after {attempts} attempts: {last}")


# --------------------------------------------------------------------------
# Source protocol
# --------------------------------------------------------------------------


class Source(Protocol):
    name: str

    def fetch(self, identifier: str) -> Record: ...


# --------------------------------------------------------------------------
# PubChem
# --------------------------------------------------------------------------

PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound"

#: Property fields requested from PUG-REST. Verified against a live response:
#: `SMILES` and `ConnectivitySMILES` are the current key names — the older
#: `CanonicalSMILES`/`IsomericSMILES` are accepted in the request path but are
#: simply absent from the response, so asking for them yields nothing.
PUBCHEM_PROPERTIES = (
    "MolecularFormula",
    "MolecularWeight",
    "SMILES",
    "ConnectivitySMILES",
    "XLogP",
    "TPSA",
    "HBondDonorCount",
    "HBondAcceptorCount",
    "RotatableBondCount",
    "Complexity",
)

#: Numeric PubChem fields worth carrying, with units. Every one of these is a
#: *computed* descriptor from PubChem's own pipeline, not a measurement.
_PUBCHEM_NUMERIC: dict[str, tuple[str, str, str]] = {
    "MolecularWeight": ("molecular_weight", "g/mol", "formula mass"),
    "XLogP": (
        "xlogp",
        "dimensionless",
        "PubChem's computed XLogP3-AA octanol/water partition coefficient",
    ),
    "TPSA": ("tpsa", "A^2", "topological polar surface area, computed from the graph"),
    "HBondDonorCount": ("hbond_donors", "count", "graph-derived count"),
    "HBondAcceptorCount": ("hbond_acceptors", "count", "graph-derived count"),
    "RotatableBondCount": ("rotatable_bonds", "count", "graph-derived count"),
    "Complexity": ("complexity", "dimensionless", "Bertz/Hendrickson complexity"),
}


class PubChemSource:
    """Small molecules from PubChem PUG-REST.

    Returns a SMILES string plus PubChem's computed descriptors. It does **not**
    return experimental solubility or melting point: those live in PUG-View as
    free text with inconsistent units, and parsing them into a float is exactly
    the kind of silent fabrication this project refuses.
    """

    name = "pubchem"

    def fetch(self, identifier: str) -> Record:
        return Record.from_json(
            cached_json(
                self.name,
                "compound",
                {"identifier": str(identifier).strip().lower()},
                lambda: self._fetch(str(identifier).strip()),
            )
        )

    def cids_for_name(self, name: str) -> list[int]:
        def compute() -> list[int]:
            raw = http_get(
                f"{PUBCHEM_BASE}/name/{_quote(name)}/cids/JSON",
                throttle_key="pubchem",
                min_interval=PUBCHEM_MIN_INTERVAL,
            )
            data = json.loads(raw)
            return [int(c) for c in data.get("IdentifierList", {}).get("CID", [])]

        return list(cached_json(self.name, "cids", {"name": name.lower()}, compute))

    def _fetch(self, identifier: str) -> dict[str, Any]:
        route = "cid" if identifier.isdigit() else "name"
        fields = ",".join(PUBCHEM_PROPERTIES)
        raw = http_get(
            f"{PUBCHEM_BASE}/{route}/{_quote(identifier)}/property/{fields}/JSON",
            throttle_key="pubchem",
            min_interval=PUBCHEM_MIN_INTERVAL,
        )
        entries = json.loads(raw).get("PropertyTable", {}).get("Properties", [])
        if not entries:
            raise RetrievalError(f"PubChem returned no properties for {identifier!r}")
        # Deterministic when a name maps to several CIDs: smallest CID wins.
        entry = min(entries, key=lambda e: int(e.get("CID", 0)))

        smiles = entry.get("SMILES") or entry.get("ConnectivitySMILES")
        if not smiles:
            raise RetrievalError(
                f"PubChem gave no SMILES for {identifier!r}; "
                f"keys present: {sorted(entry)}"
            )

        properties: list[dict[str, Any]] = []
        for key, (prop, unit, note) in _PUBCHEM_NUMERIC.items():
            if key not in entry or entry[key] is None:
                continue
            try:
                value = float(entry[key])
            except (TypeError, ValueError):
                continue
            properties.append(
                PropertyValue(
                    property=prop,
                    value=value,
                    unit=unit,
                    kind="computed",
                    note=f"PubChem computed descriptor: {note}",
                ).to_json()
            )

        return {
            "database": "pubchem",
            "external_id": str(entry.get("CID")),
            "name": identifier,
            "structure": smiles,
            "repr_kind": "smiles",
            "formula": entry.get("MolecularFormula"),
            "properties": properties,
            "extra": {"cid": entry.get("CID")},
        }


def _quote(text: str) -> str:
    from urllib.parse import quote

    return quote(str(text), safe="")


# --------------------------------------------------------------------------
# Crystallography Open Database
# --------------------------------------------------------------------------

#: Verified COD entries for molecular polymorphs. Atom counts are per unit cell
#: as the CIF ships. Glycine is the cheapest polymorph set to compute.
COD_POLYMORPHS: dict[str, list[dict[str, Any]]] = {
    "glycine": [
        {"cod_id": "4513002", "form": "alpha", "n_atoms": 40},
        {"cod_id": "2201044", "form": "beta", "n_atoms": 20},
        {"cod_id": "4512999", "form": "gamma", "n_atoms": 30},
    ],
    "paracetamol": [
        {"cod_id": "2104364", "form": "I (monoclinic)", "n_atoms": 80},
        {"cod_id": "4510931", "form": "II (orthorhombic)", "n_atoms": 160},
        {"cod_id": "2021812", "form": "III", "n_atoms": 160},
    ],
    "aspirin": [
        {"cod_id": "7126911", "form": "I", "n_atoms": 84},
        {"cod_id": "1515582", "form": "II", "n_atoms": 84},
    ],
}


class CodSource:
    """Molecular-crystal CIFs from the Crystallography Open Database (CC0).

    A COD structure is an *experimentally determined* crystal structure, so the
    structure itself and quantities read straight off it (cell, volume,
    density) are experimental. COD's text name fields are unreliable and are
    never used to identify a phase — match on space group and cell instead.
    """

    name = "cod"
    base = "https://www.crystallography.net/cod"

    def fetch(self, identifier: str) -> Record:
        cod_id = str(identifier).strip()
        if not cod_id.isdigit():
            raise RetrievalError(f"COD ids are numeric; got {cod_id!r}")
        return Record.from_json(
            cached_json(self.name, "cif", {"cod_id": cod_id}, lambda: self._fetch(cod_id))
        )

    def _fetch(self, cod_id: str) -> dict[str, Any]:
        raw = http_get(
            f"{self.base}/{cod_id}.cif",
            throttle_key="cod",
            min_interval=1.0,
            attempts=4,
            backoff=3.5,
        )
        text = raw.decode("utf-8", errors="replace")
        if "_atom_site" not in text:
            raise RetrievalError(
                f"COD {cod_id} response has no atom sites; got {text[:200]!r}"
            )
        return {
            "database": "cod",
            "external_id": cod_id,
            "name": f"COD {cod_id}",
            "structure": text,
            "repr_kind": "cif",
            "formula": None,
            "properties": [],
            "extra": {"license": "CC0"},
        }


# --------------------------------------------------------------------------
# CIF archives (MOF sets)
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ArchiveConfig:
    """Where a zip of CIFs lives and how its members are named."""

    name: str
    url: str
    license: str
    #: Path prefix inside the zip to strip when matching by refcode.
    member_suffix: str = ".cif"
    description: str = ""


#: The ODAC "promising MOF" pristine set: 135 P1 CIFs, 20-616 atoms, named by
#: CSD refcode. Small enough to ship and the matching reference-energy CSV
#: makes it the set to validate an adsorption-energy pipeline against.
ODAC_PROMISING = ArchiveConfig(
    name="odac_promising_mof",
    url=(
        "https://raw.githubusercontent.com/Open-Catalyst-Project/odac-data/"
        "main/promising_mof/promising_mof_structures/pristine.zip"
    ),
    license="dataset CC-BY-4.0, repository MIT",
    description="ODAC promising-MOF pristine structures (135 CIFs)",
)

#: CoRE MOF 2019 v2.0.1. 81 MB, 19081 CIFs; use the `CR/ASR/` subfolder for
#: the 6603 computation-ready ones. These ship symmetry-expanded, so reducing
#: to the primitive cell first saves 2-4x on centred lattices.
CORE_MOF_2019 = ArchiveConfig(
    name="core_mof_2019",
    url=(
        "https://zenodo.org/api/records/14184621/files/"
        "CoREMOF2019_public_v2_20241119.zip/content"
    ),
    license="CC-BY-4.0",
    description="CoRE MOF 2019 v2.0.1 (19081 CIFs; CR/ASR subset is computation-ready)",
)


class CifArchiveSource:
    """CIFs from a zip archive behind one URL, looked up by member name.

    The archive is downloaded once into the disk cache and never re-fetched, so
    a demo never depends on the network. Member lookup tolerates the folder
    prefixes these archives use.
    """

    def __init__(self, config: ArchiveConfig):
        self.config = config
        self.name = config.name

    def _archive(self) -> zipfile.ZipFile:
        blob = cached_bytes(
            self.name,
            "archive.zip",
            lambda: http_get(self.config.url, throttle_key=self.name, timeout=600.0),
        )
        try:
            return zipfile.ZipFile(io.BytesIO(blob))
        except zipfile.BadZipFile as exc:
            raise RetrievalError(
                f"{self.name}: cached archive is not a zip ({exc}). "
                f"If it is a few hundred bytes it is probably a Git LFS pointer, "
                f"not the data."
            ) from None

    def list_members(self) -> list[str]:
        names = [
            n
            for n in self._archive().namelist()
            if n.endswith(self.config.member_suffix) and "__MACOSX" not in n
        ]
        return sorted(names)

    def refcodes(self) -> list[str]:
        return sorted({Path(n).stem for n in self.list_members()})

    def fetch(self, identifier: str) -> Record:
        refcode = str(identifier).strip()
        return Record.from_json(
            cached_json(
                self.name, "cif", {"refcode": refcode}, lambda: self._fetch(refcode)
            )
        )

    def _fetch(self, refcode: str) -> dict[str, Any]:
        archive = self._archive()
        matches = [n for n in self.list_members() if Path(n).stem == refcode]
        if not matches:
            raise RetrievalError(
                f"{self.name}: no member named {refcode!r} "
                f"({len(self.list_members())} CIFs in archive)"
            )
        text = archive.read(matches[0]).decode("utf-8", errors="replace")
        if "_atom_site" not in text:
            raise RetrievalError(f"{self.name}: {refcode} has no atom sites")
        return {
            "database": self.name,
            "external_id": refcode,
            "name": refcode,
            "structure": text,
            "repr_kind": "cif",
            "formula": None,
            "properties": [],
            "extra": {"license": self.config.license, "member": matches[0]},
        }


# --------------------------------------------------------------------------
# Reference property CSVs
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class CsvPropertyConfig:
    name: str
    url: str
    key_column: str
    #: csv column -> (property, unit, note)
    columns: dict[str, tuple[str, str, str]]
    license: str = ""


#: DFT reference adsorption energies published alongside the ODAC promising-MOF
#: structures. These are *computed* (DFT), not experimental, and they are the
#: ground truth the ODAC23 checkpoints were trained to reproduce — which makes
#: them the right thing to validate this pipeline against, and the wrong thing
#: to present as an independent experimental measurement.
ODAC_REFERENCE_ENERGIES = CsvPropertyConfig(
    name="odac_promising_mof",
    url=(
        "https://raw.githubusercontent.com/Open-Catalyst-Project/odac-data/"
        "main/promising_mof/promising_mof_structures/promising_pristine_MOFs.csv"
    ),
    key_column="MOF",
    columns={
        "Eads_H2O/eV": (
            "water_adsorption_energy",
            "eV",
            (
                "DFT reference adsorption energy from the ODAC23 dataset "
                "(computed, not experimental)"
            ),
        ),
        "Eads_CO2/eV": (
            "co2_adsorption_energy",
            "eV",
            (
                "DFT reference adsorption energy from the ODAC23 dataset "
                "(computed, not experimental)"
            ),
        ),
    },
    license="CC-BY-4.0",
)


class CsvPropertySource:
    """Reference property values from a remote CSV, cached once."""

    def __init__(self, config: CsvPropertyConfig):
        self.config = config
        self.name = f"{config.name}_properties"

    def table(self) -> dict[str, dict[str, float]]:
        def compute() -> dict[str, dict[str, float]]:
            import csv

            raw = http_get(self.config.url, throttle_key=self.name).decode()
            out: dict[str, dict[str, float]] = {}
            for row in csv.DictReader(io.StringIO(raw)):
                key = (row.get(self.config.key_column) or "").strip()
                if not key:
                    continue
                values: dict[str, float] = {}
                for column in self.config.columns:
                    text = (row.get(column) or "").strip()
                    if not text:
                        continue
                    try:
                        values[column] = float(text)
                    except ValueError:
                        continue
                out[key] = values
            if not out:
                raise RetrievalError(f"{self.name}: CSV parsed to zero rows")
            return out

        return dict(cached_json(self.config.name, "properties", {}, compute))

    def properties_for(self, key: str) -> tuple[PropertyValue, ...]:
        row = self.table().get(key)
        if not row:
            return ()
        out = []
        for column, value in row.items():
            prop, unit, note = self.config.columns[column]
            out.append(
                PropertyValue(
                    property=prop, value=value, unit=unit, kind="computed", note=note
                )
            )
        return tuple(out)


# --------------------------------------------------------------------------
# Named water-harvesting frameworks
# --------------------------------------------------------------------------

#: Small aluminium carboxylate frameworks from the ODAC promising-MOF archive,
#: used as the cheap water-adsorption seed set.
#:
#: These are deliberately labelled by **refcode and measured composition**, not
#: by a trade name. An earlier version of this table called the `cm503311x_alf*`
#: entries "Al-fumarate (A520)" on the strength of the `alf` in the filename.
#: That was wrong, and checking the composition is what caught it: these have
#: 8 C and 4 carboxylate O per Al, which is an aromatic dicarboxylate linker
#: (terephthalate-type, so MIL-53/CAU-10 family), whereas Al-fumarate has 4 C
#: per Al. Database name fields and filenames are not evidence; match on
#: composition, space group and cell.
#:
#: Every one of these ships with **no hydrogen atoms at all**. That is a real
#: limitation, not a cosmetic one: the aromatic C-H and the bridging mu-OH
#: proton are both missing, and a mu-O without its proton is a different
#: adsorption site for water than a mu-OH. `Odac23Scorer` flags frameworks with
#: no hydrogen as out-of-distribution for exactly this reason.
#:
#: MOF-303 is deliberately absent: it is in no open database (checked CoRE
#: 2019, CoRE 2024, QMOF and COD), and inventing an identifier for it would be
#: fabrication. A genuinely named harvester would come from CoRE MOF 2019
#: (`DOYBEA`, an Al framework) — but that needs the 81 MB archive below and its
#: composition verified before it earns a name here.
WATER_HARVESTERS: list[dict[str, Any]] = [
    {
        "name": "Al(F)(aromatic dicarboxylate) [cm503311x_alf350K]",
        "archive": "odac_promising_mof",
        "refcode": "cm503311x_alf350K",
        "n_atoms": 56,
        "formula": "C32Al4F4O16",
        "note": (
            "fluoride-bridged aluminium aryl-dicarboxylate, MIL-53-type; "
            "structure contains no hydrogen"
        ),
    },
    {
        "name": "Al(F)(aromatic dicarboxylate) [cm503311x_alf400K]",
        "archive": "odac_promising_mof",
        "refcode": "cm503311x_alf400K",
        "n_atoms": 56,
        "formula": "C32Al4F4O16",
        "note": "same framework, different reported temperature; no hydrogen",
    },
    {
        "name": "Al(O)(aromatic dicarboxylate) [cm503311x_aloh225K]",
        "archive": "odac_promising_mof",
        "refcode": "cm503311x_aloh225K",
        "n_atoms": 56,
        "formula": "C32Al4O20",
        "note": (
            "oxygen-bridged aluminium aryl-dicarboxylate, CAU-10-type; the "
            "bridging mu-OH proton is absent from the deposited structure"
        ),
    },
]


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------


def default_sources() -> dict[str, Source]:
    return {
        "pubchem": PubChemSource(),
        "cod": CodSource(),
        "odac_promising_mof": CifArchiveSource(ODAC_PROMISING),
        "core_mof_2019": CifArchiveSource(CORE_MOF_2019),
    }


def get_source(name: str) -> Source:
    sources = default_sources()
    try:
        return sources[name]
    except KeyError:
        raise RetrievalError(
            f"unknown source {name!r}; known: {sorted(sources)}"
        ) from None


def fetch(source: str, identifier: str) -> Record:
    """One record from one database, cached."""
    return get_source(source).fetch(identifier)
