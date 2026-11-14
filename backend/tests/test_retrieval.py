"""Retrieval tests.

No test here touches the network: `http_get` is replaced in every test that
could reach out, which also makes the cache behaviour checkable — the central
guarantee being that **a cache hit is indistinguishable from the miss that
produced it**.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from athanor import retrieval as R


@pytest.fixture
def cache(tmp_path, monkeypatch):
    """Point the cache at a temp dir and reset its counters."""
    monkeypatch.setattr(R, "CACHE_DIR", tmp_path)
    monkeypatch.setitem(R.CACHE_STATS, "hits", 0)
    monkeypatch.setitem(R.CACHE_STATS, "misses", 0)
    return tmp_path


def test_cache_hit_is_identical_to_the_miss(cache):
    calls = []

    def compute():
        calls.append(1)
        # Deliberately awkward types: a tuple and an int that a JSON
        # round-trip changes. A hit must return what the miss returned.
        return {"a": (1, 2), "b": 3, "c": 1.5}

    first = R.cached_json("ns", "op", {"q": 1}, compute)
    second = R.cached_json("ns", "op", {"q": 1}, compute)

    assert len(calls) == 1, "second call must come from cache"
    assert first == second
    assert first == {"a": [1, 2], "b": 3, "c": 1.5}
    assert R.CACHE_STATS == {"hits": 1, "misses": 1}


def test_different_params_are_different_cache_entries(cache):
    calls = []
    R.cached_json("ns", "op", {"q": 1}, lambda: calls.append(1) or {"v": 1})
    R.cached_json("ns", "op", {"q": 2}, lambda: calls.append(1) or {"v": 2})
    assert len(calls) == 2


def test_corrupt_cache_entry_raises_rather_than_refetching(cache):
    R.cached_json("ns", "op", {"q": 1}, lambda: {"v": 1})
    entry = next((cache / "ns").glob("op-*.json"))
    entry.write_text("{not json")
    with pytest.raises(R.RetrievalError, match="corrupt cache"):
        R.cached_json("ns", "op", {"q": 1}, lambda: {"v": 1})


def test_record_survives_a_json_round_trip():
    record = R.Record(
        database="cod",
        external_id="4513002",
        name="glycine",
        structure="data_x\n_atom_site_label\nC1\n",
        repr_kind="cif",
        properties=(
            R.PropertyValue(
                property="density_g_cm3",
                value=1.6,
                unit="g/cm^3",
                kind="experimental",
                note="from the measured cell",
            ),
        ),
    )
    again = R.Record.from_json(json.loads(json.dumps(record.to_json())))
    assert again == record
    assert again.properties[0].kind == "experimental"


# --------------------------------------------------------------------------
# PubChem
# --------------------------------------------------------------------------

PUBCHEM_RESPONSE = {
    "PropertyTable": {
        "Properties": [
            {
                "CID": 1983,
                "MolecularFormula": "C8H9NO2",
                "MolecularWeight": "151.16",
                "SMILES": "CC(=O)NC1=CC=C(C=C1)O",
                "ConnectivitySMILES": "CC(=O)NC1=CC=C(C=C1)O",
                "XLogP": 0.5,
                "TPSA": 49.3,
            }
        ]
    }
}


def test_pubchem_parses_the_current_key_names(cache, monkeypatch):
    monkeypatch.setattr(
        R, "http_get", lambda *a, **k: json.dumps(PUBCHEM_RESPONSE).encode()
    )
    record = R.PubChemSource().fetch("paracetamol")
    assert record.database == "pubchem"
    assert record.external_id == "1983"
    assert record.repr_kind == "smiles"
    assert record.structure == "CC(=O)NC1=CC=C(C=C1)O"

    props = {p.property: p for p in record.properties}
    assert props["molecular_weight"].value == pytest.approx(151.16)
    assert props["xlogp"].value == pytest.approx(0.5)
    # The honesty requirement: PubChem descriptors are computed, not measured.
    assert all(p.kind == "computed" for p in record.properties)


def test_pubchem_without_a_smiles_is_an_error(cache, monkeypatch):
    payload = {"PropertyTable": {"Properties": [{"CID": 1, "TPSA": 10.0}]}}
    monkeypatch.setattr(R, "http_get", lambda *a, **k: json.dumps(payload).encode())
    with pytest.raises(R.RetrievalError, match="no SMILES"):
        R.PubChemSource().fetch("mystery")


def test_pubchem_picks_the_smallest_cid_deterministically(cache, monkeypatch):
    payload = {
        "PropertyTable": {
            "Properties": [
                {"CID": 900, "SMILES": "CC", "MolecularFormula": "C2H6"},
                {"CID": 12, "SMILES": "CO", "MolecularFormula": "CH4O"},
            ]
        }
    }
    monkeypatch.setattr(R, "http_get", lambda *a, **k: json.dumps(payload).encode())
    assert R.PubChemSource().fetch("ambiguous").external_id == "12"


# --------------------------------------------------------------------------
# COD
# --------------------------------------------------------------------------


def test_cod_rejects_a_non_numeric_id(cache):
    with pytest.raises(R.RetrievalError, match="numeric"):
        R.CodSource().fetch("glycine")


def test_cod_requires_atom_sites_in_the_response(cache, monkeypatch):
    monkeypatch.setattr(R, "http_get", lambda *a, **k: b"<html>down for maintenance")
    with pytest.raises(R.RetrievalError, match="no atom sites"):
        R.CodSource().fetch("4513002")


def test_cod_cif_is_cached_and_the_second_read_needs_no_network(cache, monkeypatch):
    cif = "data_glycine\n_atom_site_label\nC1\n"
    monkeypatch.setattr(R, "http_get", lambda *a, **k: cif.encode())
    first = R.CodSource().fetch("4513002")

    def boom(*a, **k):
        raise AssertionError("network must not be touched on a cache hit")

    monkeypatch.setattr(R, "http_get", boom)
    assert R.CodSource().fetch("4513002") == first


def test_cod_polymorph_catalog_is_well_formed():
    """These ids were verified against COD; keep them honest."""
    for compound, forms in R.COD_POLYMORPHS.items():
        assert len(forms) >= 2, f"{compound} needs 2+ forms to be a polymorph set"
        for form in forms:
            assert form["cod_id"].isdigit()
            assert form["n_atoms"] > 0
    ids = [f["cod_id"] for forms in R.COD_POLYMORPHS.values() for f in forms]
    assert len(ids) == len(set(ids)), "duplicate COD id across polymorph sets"


# --------------------------------------------------------------------------
# CIF archives
# --------------------------------------------------------------------------


def _zip_bytes(members: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in members.items():
            zf.writestr(name, text)
    return buf.getvalue()


@pytest.fixture
def archive_source(cache, monkeypatch):
    blob = _zip_bytes(
        {
            "pristine/AAAA.cif": "data_a\n_atom_site_label\nZn1\n",
            "pristine/BBBB.cif": "data_b\n_atom_site_label\nCu1\n",
            "__MACOSX/pristine/._AAAA.cif": "junk",
        }
    )
    monkeypatch.setattr(R, "http_get", lambda *a, **k: blob)
    return R.CifArchiveSource(
        R.ArchiveConfig(name="test_archive", url="https://example.invalid/x.zip", license="CC-BY")
    )


def test_archive_lists_and_fetches_by_refcode(archive_source):
    assert archive_source.refcodes() == ["AAAA", "BBBB"]
    record = archive_source.fetch("BBBB")
    assert record.external_id == "BBBB"
    assert "Cu1" in str(record.structure)
    assert record.extra["license"] == "CC-BY"


def test_archive_skips_macosx_metadata(archive_source):
    assert not any("__MACOSX" in m for m in archive_source.list_members())


def test_archive_missing_refcode_is_an_error(archive_source):
    with pytest.raises(R.RetrievalError, match="no member named"):
        archive_source.fetch("ZZZZ")


def test_git_lfs_pointer_is_reported_as_such(cache, monkeypatch):
    """The real trap: some of these archives are 133-byte LFS pointers."""
    pointer = b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n"
    monkeypatch.setattr(R, "http_get", lambda *a, **k: pointer)
    source = R.CifArchiveSource(
        R.ArchiveConfig(name="lfs", url="https://example.invalid/y.zip", license="")
    )
    with pytest.raises(R.RetrievalError, match="Git LFS"):
        source.fetch("ANY")


def test_known_archive_configs_are_sane():
    for config in (R.ODAC_PROMISING, R.CORE_MOF_2019):
        assert config.url.startswith("https://")
        assert config.license
    # Must not point at the LFS-pointer tarballs.
    assert "tar.gz" not in R.ODAC_PROMISING.url


# --------------------------------------------------------------------------
# Reference property CSVs
# --------------------------------------------------------------------------

CSV_TEXT = "MOF,Eads_CO2/eV,Eads_H2O/eV\nALPHA,-1.5,-0.5\nBETA,,-0.25\n"


def test_csv_property_source_parses_and_labels_as_computed(cache, monkeypatch):
    monkeypatch.setattr(R, "http_get", lambda *a, **k: CSV_TEXT.encode())
    source = R.CsvPropertySource(R.ODAC_REFERENCE_ENERGIES)

    props = {p.property: p for p in source.properties_for("ALPHA")}
    assert props["water_adsorption_energy"].value == pytest.approx(-0.5)
    assert props["co2_adsorption_energy"].value == pytest.approx(-1.5)
    # These are DFT numbers. Calling them experimental would be a lie.
    assert all(p.kind == "computed" for p in props.values())
    assert "not experimental" in props["water_adsorption_energy"].note

    # A blank cell is skipped rather than becoming a zero.
    beta = {p.property for p in source.properties_for("BETA")}
    assert beta == {"water_adsorption_energy"}

    assert source.properties_for("MISSING") == ()


def test_empty_csv_raises(cache, monkeypatch):
    monkeypatch.setattr(R, "http_get", lambda *a, **k: b"MOF,Eads_H2O/eV\n")
    with pytest.raises(R.RetrievalError, match="zero rows"):
        R.CsvPropertySource(R.ODAC_REFERENCE_ENERGIES).table()


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------


def test_unknown_source_is_an_error_listing_the_known_ones():
    with pytest.raises(R.RetrievalError, match="unknown source"):
        R.get_source("csd")


def test_default_sources_are_all_usable():
    for name, source in R.default_sources().items():
        assert source.name == name or isinstance(source, R.CifArchiveSource)
        assert callable(source.fetch)


def test_water_harvesters_are_not_labelled_from_filenames():
    """Regression guard for a real mistake.

    These entries were once labelled "Al-fumarate (A520)" because the archive
    filenames contain `alf`. Checking the composition showed 8 C per Al with 4
    carboxylate O — an aromatic dicarboxylate, not fumarate, which has 4 C per
    Al. Names in database fields and filenames are not evidence.
    """
    for entry in R.WATER_HARVESTERS:
        assert "formula" in entry, "every entry must record its measured formula"
        assert entry["refcode"] in entry["name"], (
            "the label must carry the refcode, so it can always be traced back"
        )
    blob = json.dumps(R.WATER_HARVESTERS).lower()
    for trade_name in ("a520", "basolite", "fumarate"):
        assert trade_name not in blob, (
            f"{trade_name!r} is a name claim that the composition does not support"
        )


def test_water_harvesters_do_not_claim_mof_303():
    """MOF-303 is in no open database; an id for it would be fabricated."""
    blob = json.dumps(R.WATER_HARVESTERS).lower()
    assert "mof-303" not in blob and "mof303" not in blob
    for entry in R.WATER_HARVESTERS:
        assert entry["archive"] in R.default_sources()
        assert entry["refcode"]


def test_http_get_retries_then_reports_failure(cache, monkeypatch):
    attempts = []

    class Boom(Exception):
        pass

    def fake_get(*a, **k):
        attempts.append(1)
        raise Boom("reset by peer")

    monkeypatch.setattr("httpx.get", fake_get)
    monkeypatch.setattr(R.time, "sleep", lambda s: None)
    with pytest.raises(R.RetrievalError, match="failed after 3 attempts"):
        R.http_get("https://example.invalid/x", attempts=3, backoff=0.0)
    assert len(attempts) == 3
