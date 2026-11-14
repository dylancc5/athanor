"""Scorers for molecules and porous frameworks.

Four scorers, covering two campaigns:

    Gfn2XtbScorer   drug_stability  polymorph lattice energy, relative
                    polymorph stability, HOMO-LUMO gap            (GFN2-xTB)
    Odac23Scorer    mof_water       water adsorption energy, pore geometry,
                    regeneration-energy proxy                     (ODAC23)
    RdkitScorer     drug_stability  descriptors, synthetic accessibility,
                    solubility proxy                              (RDKit)
    RetrievalScorer both            structures and published property values
                    read out of external databases

Honesty rules these implementations follow, from `contracts.py`:

  * No value is ever invented, interpolated or filled in. A calculation that
    fails lands in `ScoreResult.failed` with the reason, and the candidate
    simply has no measurement for that property.
  * `is_proxy=True` whenever a number stands in for the property actually
    asked about, and the `note` says what it stands for *and why it is
    imperfect*.
  * "Water uptake" is not computed anywhere in this file, because it is not
    computable here. Uptake is a loading isotherm at a temperature and
    humidity; what this code measures is the binding energy of a single water
    molecule at 0 K. The adsorption energy is reported as itself, and the
    regeneration-energy proxy derived from it is labelled as a proxy.
"""

from __future__ import annotations

import logging
import math
from typing import Any, ClassVar

from ..contracts import (
    Artifact,
    Candidate,
    Domain,
    Measurement,
    Provenance,
    ScoreResult,
    Spec,
)
from ..structure import atoms_to_dict, parse_structure
from ..workers.base import run_worker

log = logging.getLogger("athanor.scorers.molecular")

EV_PER_KJ_MOL = 96.48533212

# --------------------------------------------------------------------------
# Measured accuracy of the ODAC water-adsorption pipeline
# --------------------------------------------------------------------------
# These are not guesses. They come from running `Odac23Scorer`'s exact shipped
# configuration over the 8 smallest frameworks in the ODAC promising-MOF
# archive that carry published DFT reference water adsorption energies
# (`promising_pristine_MOFs.csv`), and comparing. The script is kept out of the
# package; the numbers are quoted in every measurement note so a reader never
# has to take the pipeline's accuracy on trust.
#
# Caveat that belongs with them: those reference values are ODAC23 *training*
# data, so this is an in-distribution check, not an out-of-sample test.
ODAC_VALIDATION_N = 8
ODAC_MAE_EV = 0.22
ODAC_MEAN_SIGNED_ERROR_EV = 0.19
ODAC_SPEARMAN = 0.43
#: Resolution limit of GFN2-xTB polymorph energy differences, in kJ/mol. Set
#: from the measured inversions on real polymorph pairs; see Gfn2XtbScorer.
GFN2_POLYMORPH_RESOLUTION_KJ_MOL = 3.0


def _artifact(candidate_id: str, kind: str, label: str, prefix: str) -> Artifact:
    aid = f"a-{prefix}-{candidate_id}"
    return Artifact(
        id=aid,
        candidate_id=candidate_id,
        kind=kind,  # type: ignore[arg-type]
        label=label,
        uri=f"artifacts/{aid}.json",
    )


def _finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


# ==========================================================================
# GFN2-xTB: molecular crystals
# ==========================================================================


class Gfn2XtbScorer:
    """Polymorph stability and frontier-orbital gap from GFN2-xTB.

    The lattice energy is `E(crystal)/Z - E(isolated molecule)`, computed in
    the xtb worker; see `athanor/workers/xtb.py` for why the gas-phase
    reference is built once per molecule from its canonical SMILES rather than
    once per polymorph.

    `relative_polymorph_energy` is only emitted when **two or more polymorphs
    of the same molecule** are present in the same batch, because a relative
    value needs a reference. The reference candidate's id is named in the note,
    so the number can never be read without knowing what it is relative to.
    """

    name = "gfn2-xtb"
    domains: tuple[Domain, ...] = ("drug_stability",)
    properties: tuple[str, ...] = (
        "lattice_energy",
        "relative_polymorph_energy",
        "homo_lumo_gap",
        "degradation_susceptibility",
    )

    def __init__(self, *, fmax: float = 0.05, steps: int = 150, timeout: float = 3600.0):
        self.fmax = fmax
        self.steps = steps
        self.timeout = timeout

    async def score(self, candidates: list[Candidate], spec: Spec) -> ScoreResult:
        result = ScoreResult()
        lattice: dict[str, tuple[float, str]] = {}  # candidate id -> (E_latt, smiles)

        for cand in candidates:
            try:
                atoms = parse_structure(cand.structure, cand.repr_kind)
            except Exception as exc:  # noqa: BLE001
                result.failed[cand.id] = (
                    f"could not parse structure: {type(exc).__name__}: {exc}"
                )
                continue

            periodic = bool(atoms.pbc.any())
            payload = atoms_to_dict(atoms)

            # --- HOMO-LUMO gap, on the isolated molecule -------------------
            # Run on a molecular structure only: a periodic crystal's frontier
            # orbitals at the Gamma point are not the molecular gap.
            if not periodic:
                await self._gap(cand, payload, result)

            # --- lattice energy, crystals only -----------------------------
            if not periodic:
                result.failed[cand.id] = (
                    "lattice energy needs a crystal structure; this candidate is "
                    f"a {cand.repr_kind} with no unit cell. A packing was NOT "
                    "constructed for it, because a predicted packing is not a "
                    "polymorph."
                )
                continue

            try:
                r = await run_worker(
                    "xtb",
                    {
                        "op": "lattice_energy",
                        "atoms": payload,
                        "fmax": self.fmax,
                        "steps": self.steps,
                    },
                    timeout=self.timeout,
                )
            except Exception as exc:  # noqa: BLE001 — recorded, never defaulted
                result.failed[cand.id] = f"lattice energy failed: {exc}"
                continue

            value = r.get("lattice_energy_ev_per_molecule")
            if not _finite(value):
                result.failed[cand.id] = f"non-finite lattice energy: {value!r}"
                continue

            # The gas-phase reference's frontier orbitals come back with the
            # lattice energy, which is the only way a crystal candidate gets a
            # molecular gap: the Gamma-point orbitals of a periodic cell are
            # not the molecular HOMO-LUMO gap.
            self._emit_gap(
                cand,
                r,
                result,
                shared_across_polymorphs=True,
            )

            result.measurements.append(
                Measurement(
                    candidate_id=cand.id,
                    property="lattice_energy",
                    value=float(value),
                    unit="eV",
                    source=self.name,
                    method=r.get("method"),
                    confidence=0.6 if r.get("converged") else 0.4,
                    ood_flag=False,
                    is_proxy=False,
                    note=(
                        f"lattice energy per molecule, Z={r.get('z_total')} in a "
                        f"{r.get('supercell')} supercell. Gamma point only. "
                        f"Semiempirical, and the ABSOLUTE value is not reliable: "
                        f"measured values here run 15-25% below experimental "
                        f"sublimation enthalpies. Only differences between "
                        f"polymorphs of the same molecule are meaningful, and even "
                        f"those resolve only down to about "
                        f"{GFN2_POLYMORPH_RESOLUTION_KJ_MOL:.0f} kJ/mol."
                        + (
                            " The gas-phase reference for this molecule is a "
                            "ZWITTERION, which is not a gas-phase minimum (it "
                            "tautomerises to the neutral form), so this absolute "
                            "lattice energy is especially unreliable; it cancels "
                            "exactly in polymorph differences."
                            if r.get("gas_reference_zwitterionic")
                            else ""
                        )
                        + ("" if r.get("converged") else " Geometry did NOT converge.")
                    ),
                )
            )
            lattice[cand.id] = (float(value), str(r.get("gas_reference_smiles") or ""))

            packing = r.get("crystal_packing")
            if packing:
                result.artifacts.append(
                    (
                        _artifact(cand.id, "crystal_packing", f"{cand.name} packing", "pack"),
                        packing,
                    )
                )

        self._relative(lattice, candidates, result)
        return result

    async def _gap(
        self, cand: Candidate, payload: dict[str, Any], result: ScoreResult
    ) -> None:
        try:
            g = await run_worker("xtb", {"op": "gap", "atoms": payload}, timeout=600.0)
        except Exception as exc:  # noqa: BLE001
            log.info("gap failed for %s: %s", cand.id, exc)
            return
        self._emit_gap(cand, g, result, shared_across_polymorphs=False)

    def _emit_gap(
        self,
        cand: Candidate,
        g: dict[str, Any],
        result: ScoreResult,
        *,
        shared_across_polymorphs: bool,
    ) -> None:
        gap = g.get("homo_lumo_gap_ev")
        if not _finite(gap):
            if g.get("orbital_error"):
                result.failed[f"{cand.id}:gap"] = (
                    f"HOMO-LUMO gap unavailable: {g['orbital_error']}"
                )
            return
        shared = (
            " Computed on the isolated molecule, so every polymorph of this "
            "molecule gets the SAME value: it separates molecules, never "
            "polymorphs of one molecule."
            if shared_across_polymorphs
            else ""
        )

        result.measurements.append(
            Measurement(
                candidate_id=cand.id,
                property="homo_lumo_gap",
                value=float(gap),
                unit="eV",
                source=self.name,
                method=g.get("method"),
                confidence=0.5,
                is_proxy=False,
                note=(
                    "GFN2-xTB frontier-orbital gap. A real computed quantity, but a "
                    "semiempirical one: it is not an experimental optical or "
                    "electrochemical gap." + shared
                ),
            )
        )
        # Same number, surfaced under the name the campaign's objective uses.
        result.measurements.append(
            Measurement(
                candidate_id=cand.id,
                property="degradation_susceptibility",
                value=float(gap),
                unit="eV",
                source=self.name,
                method=g.get("method"),
                confidence=0.3,
                is_proxy=True,
                note=(
                    "PROXY for chemical/oxidative degradation susceptibility, "
                    "represented by the GFN2-xTB HOMO-LUMO gap. A LARGER value "
                    "means a wider gap and so a molecule that is harder to oxidise "
                    "or attack electronically — this objective should be MAXIMIZED "
                    "for a more stable formulation. What it is not: it is not a "
                    "degradation rate, and it knows nothing about the actual "
                    "pathway (hydrolysis, photolysis, excipient reactions), the "
                    "solid-state environment, humidity, pH or temperature. Two "
                    "molecules with the same gap can have very different shelf "
                    "lives." + shared
                ),
            )
        )

    def _relative(
        self,
        lattice: dict[str, tuple[float, str]],
        candidates: list[Candidate],
        result: ScoreResult,
    ) -> None:
        """Relative stability within each set of same-molecule polymorphs."""
        by_molecule: dict[str, list[str]] = {}
        for cid, (_, smiles) in lattice.items():
            if smiles:
                by_molecule.setdefault(smiles, []).append(cid)

        names = {c.id: c.name for c in candidates}
        for smiles, ids in by_molecule.items():
            if len(ids) < 2:
                continue  # a relative energy needs something to be relative to
            # Most stable (most negative lattice energy) is the reference.
            ref_id = min(ids, key=lambda i: (lattice[i][0], i))
            ref_value = lattice[ref_id][0]
            for cid in sorted(ids):
                delta = (lattice[cid][0] - ref_value) * EV_PER_KJ_MOL
                result.measurements.append(
                    Measurement(
                        candidate_id=cid,
                        property="relative_polymorph_energy",
                        value=round(delta, 4),
                        unit="kJ/mol",
                        source=self.name,
                        method=(
                            "GFN2-xTB lattice energy difference against the most "
                            "stable polymorph in this batch"
                        ),
                        confidence=0.3,
                        is_proxy=False,
                        note=(
                            f"0 is the most stable polymorph found in this batch: "
                            f"{names.get(ref_id, ref_id)} ({ref_id}). Positive means "
                            f"less stable by that many kJ/mol. Relative to this batch "
                            f"only — adding a more stable polymorph later shifts the "
                            f"reference. Same molecule (SMILES {smiles}), so the "
                            f"gas-phase reference cancels exactly in this difference. "
                            f"Lattice energy alone omits thermal and entropic terms, "
                            f"so it does not by itself establish which form is stable "
                            f"at room temperature. RESOLUTION LIMIT: measured "
                            f"against real polymorph pairs this method got aspirin's "
                            f"ordering right but INVERTED glycine (alpha vs gamma) "
                            f"and paracetamol (II vs I), with the inversions "
                            f"spanning 1.4-2.6 kJ/mol. Treat differences below about "
                            f"{GFN2_POLYMORPH_RESOLUTION_KJ_MOL:.0f} kJ/mol as "
                            f"unresolved rather than as a ranking."
                        ),
                    )
                )


# ==========================================================================
# ODAC23: porous frameworks + water
# ==========================================================================


class Odac23Scorer:
    """Water adsorption energy and pore geometry for porous frameworks.

    Two different kinds of number come out of this scorer, and they are not
    equally trustworthy:

      * `water_adsorption_energy` — the ODAC23 checkpoint's prediction for a
        single water molecule in the framework. A real calculation, validated
        against published DFT references (see `workers/odac.py`): it tends to
        **under-bind**, by a mean of `ODAC_MEAN_SIGNED_ERROR_EV`, though
        individual frameworks can overshoot, so this is a tendency and not a
        bound.
      * `void_fraction`, `pore_diameter`, `surface_area` — pure geometry from
        atom positions and vdW radii. No model, no fitting.

    `regeneration_energy` is a labelled proxy. See the note it emits.
    """

    name = "odac23"
    domains: tuple[Domain, ...] = ("mof_water",)
    properties: tuple[str, ...] = (
        "water_adsorption_energy",
        "regeneration_energy",
        "void_fraction",
        "pore_diameter",
        "surface_area",
    )

    def __init__(
        self,
        *,
        n_sites: int = 4,
        n_orientations: int = 4,
        n_relax: int = 3,
        relax_steps: int = 80,
        grid_spacing: float = 0.6,
        timeout: float = 3600.0,
    ):
        self.n_sites = n_sites
        self.n_orientations = n_orientations
        self.n_relax = n_relax
        self.relax_steps = relax_steps
        self.grid_spacing = grid_spacing
        self.timeout = timeout

    async def score(self, candidates: list[Candidate], spec: Spec) -> ScoreResult:
        result = ScoreResult()
        for cand in candidates:
            try:
                atoms = parse_structure(cand.structure, cand.repr_kind)
            except Exception as exc:  # noqa: BLE001
                result.failed[cand.id] = (
                    f"could not parse structure: {type(exc).__name__}: {exc}"
                )
                continue
            if not atoms.pbc.any():
                result.failed[cand.id] = (
                    "framework must be a periodic structure; got a non-periodic "
                    f"{cand.repr_kind}"
                )
                continue

            self._geometry(cand, atoms, result)
            await self._adsorption(cand, atoms, result)
        return result

    def _geometry(self, cand: Candidate, atoms: Any, result: ScoreResult) -> None:
        """Pore geometry. Separate from adsorption so one can fail alone."""
        from .. import pores

        try:
            analysis = pores.analyze(
                atoms,
                probe_radius=pores.WATER_PROBE_RADIUS,
                spacing=self.grid_spacing,
            )
            payload = pores.void_grid_payload(
                atoms,
                probe_radius=pores.WATER_PROBE_RADIUS,
                spacing=self.grid_spacing,
                analysis=analysis,
            )
        except Exception as exc:  # noqa: BLE001
            result.failed[f"{cand.id}:pores"] = f"pore geometry failed: {exc}"
            return

        geometric = (
            f"hard-sphere geometry from vdW radii with a "
            f"{pores.WATER_PROBE_RADIUS:.2f} A probe (water-sized), "
            f"{analysis.grid_spacing_A:.2f} A grid"
        )
        for prop, value, unit, note in (
            (
                "void_fraction",
                analysis.void_fraction,
                "dimensionless",
                (
                    f"geometric void fraction: {geometric}. NOT a helium void "
                    f"fraction (which is a Boltzmann average over a real "
                    f"He-framework potential at a temperature) and not an "
                    f"experimental pore volume."
                ),
            ),
            (
                "pore_diameter",
                analysis.pore_diameter_A,
                "A",
                (
                    f"largest included sphere anywhere in the cell, {geometric}. "
                    f"Grid-limited to about +/-{analysis.grid_spacing_A:.2f} A, "
                    f"and it does not require the pore to be reachable from "
                    f"outside, so a sealed cavity counts."
                ),
            ),
            (
                "surface_area",
                analysis.accessible_surface_area_m2_g,
                "m^2/g",
                (
                    f"probe-accessible vdW surface area, {geometric}, by a "
                    f"deterministic Shrake-Rupley sampling. Comparable to a "
                    f"simulated geometric surface area, not to an experimental "
                    f"BET number."
                ),
            ),
        ):
            if not _finite(value):
                continue
            result.measurements.append(
                Measurement(
                    candidate_id=cand.id,
                    property=prop,
                    value=float(value),
                    unit=unit,
                    source=self.name,
                    method=f"athanor.pores, {geometric}",
                    confidence=0.85,
                    is_proxy=False,
                    note=note,
                )
            )

        result.artifacts.append(
            (
                _artifact(cand.id, "void_grid", f"{cand.name} pore network", "void"),
                payload,
            )
        )

    async def _adsorption(self, cand: Candidate, atoms: Any, result: ScoreResult) -> None:
        try:
            r = await run_worker(
                "odac",
                {
                    "op": "adsorption",
                    "host": atoms_to_dict(atoms),
                    "guest": "H2O",
                    "n_sites": self.n_sites,
                    "n_orientations": self.n_orientations,
                    "n_relax": self.n_relax,
                    "relax_steps": self.relax_steps,
                    "grid_spacing": self.grid_spacing,
                },
                timeout=self.timeout,
            )
        except Exception as exc:  # noqa: BLE001 — recorded, never defaulted
            result.failed[cand.id] = f"water adsorption failed: {exc}"
            return

        e_ads = r.get("adsorption_energy_ev")
        if not _finite(e_ads):
            result.failed[cand.id] = f"non-finite adsorption energy: {e_ads!r}"
            return
        e_ads = float(e_ads)
        no_hydrogen = "H" not in set(atoms.get_chemical_symbols())

        result.measurements.append(
            Measurement(
                candidate_id=cand.id,
                property="water_adsorption_energy",
                value=round(e_ads, 4),
                unit="eV",
                source=self.name,
                method=r.get("method"),
                confidence=0.35 if no_hydrogen else 0.5,
                ood_flag=no_hydrogen,
                is_proxy=False,
                note=(
                    "Binding energy of ONE water molecule at 0 K, from the ODAC23 "
                    "EquiformerV2 checkpoint. Negative is favourable. "
                    "ACCURACY: against 8 published DFT reference energies for these "
                    "same frameworks this pipeline UNDER-BINDS by a mean of "
                    f"{ODAC_MEAN_SIGNED_ERROR_EV:+.2f} eV "
                    f"(MAE {ODAC_MAE_EV:.2f} eV, Spearman "
                    f"{ODAC_SPEARMAN:.2f} over 8 frameworks). That is a TENDENCY, "
                    "not a bound: individual values do overshoot and bind more "
                    "strongly than the reference. The gap is site sampling, not the "
                    "energy model — it screens a few deterministic placements "
                    f"({r.get('n_placements_screened')} here, {r.get('n_relaxed')} "
                    "relaxed) against a rigid framework, where the references come "
                    "from an exhaustive search with full DFT relaxation. Note also "
                    "that those references are ODAC23 training data, so the "
                    "comparison is in-distribution and flatters the model. "
                    "This is NOT water uptake: uptake is a loading isotherm at a "
                    "given temperature and humidity, which cannot be computed from "
                    "a single-molecule binding energy."
                    + (
                        " OUT OF DISTRIBUTION: this framework contains no hydrogen "
                        "atoms at all. Aromatic C-H and any bridging mu-OH proton "
                        "are missing from the deposited structure, and a bare mu-O "
                        "is a different site for water than a mu-OH, so the binding "
                        "energy is for a framework that is not quite the real one."
                        if no_hydrogen
                        else ""
                    )
                ),
            )
        )

        # --- regeneration-energy proxy -----------------------------------
        regen_kj = -e_ads * EV_PER_KJ_MOL
        result.measurements.append(
            Measurement(
                candidate_id=cand.id,
                property="regeneration_energy",
                value=round(regen_kj, 3),
                unit="kJ/mol",
                source=self.name,
                method=(
                    "-1 x the computed single-molecule water adsorption energy, "
                    "converted to kJ/mol"
                ),
                confidence=0.25,
                is_proxy=True,
                note=(
                    "PROXY for the energy needed to regenerate the framework. What "
                    "it actually is: the magnitude of the computed binding energy of "
                    "a SINGLE water molecule at 0 K, sign-flipped, i.e. the work to "
                    "remove that one molecule from its site. A positive value means "
                    "water is bound and energy is needed to drive it off.\n"
                    "What it is NOT, and why it is imperfect: (1) it is not the "
                    "isosteric heat of adsorption, which is what a real regeneration "
                    "duty is based on; (2) it ignores how binding weakens as loading "
                    "rises, so it reflects the FIRST, strongest-bound water and "
                    "overestimates the per-molecule cost at working loading; (3) it "
                    "excludes water-water hydrogen bonding and pore condensation, "
                    "which dominate uptake in a real water harvester; (4) it omits "
                    "zero-point energy and all entropic terms, so it is not a free "
                    "energy at any temperature; (5) it excludes the sensible heat of "
                    "heating the framework itself, which is a large part of a real "
                    "regeneration budget. Use it to rank frameworks, never as a "
                    "thermal duty."
                ),
            )
        )

        if r.get("adsorption_sites"):
            result.artifacts.append(
                (
                    _artifact(
                        cand.id, "adsorption_sites", f"{cand.name} water sites", "ads"
                    ),
                    r["adsorption_sites"],
                )
            )
        if r.get("trajectory"):
            result.artifacts.append(
                (
                    _artifact(
                        cand.id,
                        "relaxation_trajectory",
                        f"{cand.name} water relaxation",
                        "adsrelax",
                    ),
                    r["trajectory"],
                )
            )


# ==========================================================================
# RDKit descriptors
# ==========================================================================


class RdkitScorer:
    """Graph descriptors, synthetic accessibility, and a solubility proxy.

    Everything here is computed from the molecular graph alone. These are fast
    and reproducible, and none of them is a measurement of a physical sample.
    """

    name = "rdkit"
    domains: tuple[Domain, ...] = ("drug_stability",)
    properties: tuple[str, ...] = (
        "molecular_weight",
        "logp",
        "tpsa",
        "rotatable_bonds",
        "synthetic_accessibility",
        "solubility_logs",
    )

    async def score(self, candidates: list[Candidate], spec: Spec) -> ScoreResult:
        result = ScoreResult()
        for cand in candidates:
            try:
                mol = self._mol(cand)
            except Exception as exc:  # noqa: BLE001
                result.failed[cand.id] = (
                    f"RDKit could not build a molecule: {type(exc).__name__}: {exc}"
                )
                continue
            try:
                self._descriptors(cand, mol, result)
            except Exception as exc:  # noqa: BLE001
                result.failed[cand.id] = f"descriptor calculation failed: {exc}"
        return result

    def _mol(self, cand: Candidate):
        from rdkit import Chem

        if cand.repr_kind == "smiles":
            mol = Chem.MolFromSmiles(cand.structure)
            if mol is None:
                raise ValueError(f"unparseable SMILES: {cand.structure[:60]!r}")
            return mol

        # A crystal. One molecule has to be lifted out of the cell properly,
        # which means following bonds under the minimum-image convention and
        # unwrapping whatever crosses a cell boundary. Feeding the whole cell
        # to RDKit as a flat XYZ does not work: a molecule split across the
        # boundary comes back with atoms that have no bonds at all, and bond
        # perception fails outright ("Unable to determine valence of atom ...
        # with 0 bonds"). That logic already exists in the xtb worker, whose
        # top-level imports are only numpy/ase/athanor.structure, so it is
        # safe to use here in the server environment.
        from ..structure import parse_structure
        from ..workers.xtb import _canonical_smiles, analyze_crystal

        atoms = parse_structure(cand.structure, cand.repr_kind)
        info = analyze_crystal(atoms)
        if len(info["formulas"]) != 1:
            raise ValueError(
                "cell contains more than one distinct molecule "
                f"({', '.join(info['formulas'])}); descriptors for a hydrate, "
                "solvate or co-crystal are ambiguous"
            )
        smiles = _canonical_smiles(info["molecules"][0])
        mol = Chem.MolFromSmiles(smiles)
        if mol is None:
            raise ValueError(f"perceived SMILES would not parse: {smiles!r}")
        return mol

    def _descriptors(self, cand: Candidate, mol: Any, result: ScoreResult) -> None:
        from rdkit.Chem import Crippen, Descriptors, rdMolDescriptors

        mw = float(Descriptors.MolWt(mol))
        logp = float(Crippen.MolLogP(mol))
        tpsa = float(rdMolDescriptors.CalcTPSA(mol))
        rot = int(rdMolDescriptors.CalcNumRotatableBonds(mol))

        for prop, value, unit, conf, note in (
            (
                "molecular_weight",
                mw,
                "g/mol",
                0.99,
                (
                    "formula mass from the molecular graph; exact arithmetic, "
                    "not a measurement of a sample"
                ),
            ),
            (
                "logp",
                logp,
                "dimensionless",
                0.4,
                (
                    "PROXY for the octanol/water partition coefficient. It is "
                    "Crippen cLogP, a sum of fitted atom-type contributions, so it "
                    "stands in for a measured partition coefficient without being "
                    "one. Imperfect because the fit is only as good as its training "
                    "chemistry, it has no conformational or tautomeric information, "
                    "and it describes the neutral species rather than whatever is "
                    "present at a given pH."
                ),
            ),
            (
                "tpsa",
                tpsa,
                "A^2",
                0.9,
                (
                    "topological polar surface area: a deterministic sum of polar "
                    "atom contributions from the graph. A descriptor, not a "
                    "measured surface."
                ),
            ),
            (
                "rotatable_bonds",
                float(rot),
                "count",
                0.99,
                "exact count from the molecular graph",
            ),
        ):
            result.measurements.append(
                Measurement(
                    candidate_id=cand.id,
                    property=prop,
                    value=round(value, 4),
                    unit=unit,
                    source=self.name,
                    method="RDKit",
                    confidence=conf,
                    is_proxy=prop == "logp",
                    note=note,
                )
            )

        self._sa_score(cand, mol, result)
        self._solubility(cand, mol, mw, logp, rot, result)

    def _sa_score(self, cand: Candidate, mol: Any, result: ScoreResult) -> None:
        try:
            score = _sascorer().calculateScore(mol)
        except Exception as exc:  # noqa: BLE001
            result.failed[f"{cand.id}:sa"] = f"synthetic accessibility failed: {exc}"
            return
        result.measurements.append(
            Measurement(
                candidate_id=cand.id,
                property="synthetic_accessibility",
                value=round(float(score), 4),
                unit="dimensionless",
                source=self.name,
                method="RDKit Contrib SA_Score (Ertl & Schuffenhauer 2009)",
                confidence=0.5,
                is_proxy=True,
                note=(
                    "PROXY for how hard a molecule is to make, on a 1 (easy) to 10 "
                    "(hard) scale. It is a fragment-frequency heuristic: it rewards "
                    "substructures that are common in PubChem and penalises ring "
                    "complexity and stereocentres. It has never seen a synthetic "
                    "route, and it does not know whether this specific compound is "
                    "commercially available."
                ),
            )
        )

    def _solubility(
        self,
        cand: Candidate,
        mol: Any,
        mw: float,
        logp: float,
        rot: int,
        result: ScoreResult,
    ) -> None:
        """ESOL (Delaney 2004) aqueous-solubility estimate."""
        heavy = mol.GetNumHeavyAtoms()
        if heavy == 0:
            return
        aromatic = sum(1 for a in mol.GetAtoms() if a.GetIsAromatic())
        ap = aromatic / heavy
        logs = 0.16 - 0.63 * logp - 0.0062 * mw + 0.066 * rot - 0.74 * ap
        if not _finite(logs):
            return
        result.measurements.append(
            Measurement(
                candidate_id=cand.id,
                property="solubility_logs",
                value=round(float(logs), 4),
                unit="log10(mol/L)",
                source=self.name,
                method=(
                    "ESOL (Delaney 2004): logS = 0.16 - 0.63*cLogP - 0.0062*MW "
                    "+ 0.066*RotB - 0.74*AromaticProportion"
                ),
                confidence=0.3,
                is_proxy=True,
                note=(
                    "PROXY for aqueous solubility. It is a four-descriptor linear "
                    "regression published by Delaney in 2004, evaluated on this "
                    "molecule's graph — NOT a solubility measurement and not a "
                    "calculation from physics. Its inputs are themselves estimates "
                    "(cLogP). Reported RMS error on the original set is about 1 log "
                    "unit, i.e. a factor of ten, and it is worse outside drug-like "
                    "chemical space. It also describes the AMORPHOUS/intrinsic "
                    "solubility of the molecule and is blind to which polymorph the "
                    "solid is in — yet polymorph is exactly what this campaign "
                    "varies, and different polymorphs of one drug can differ several "
                    "fold in dissolution. So this number must not be used to rank "
                    "polymorphs of the same molecule against each other; it "
                    "separates different molecules only."
                ),
            )
        )


_SASCORER: Any = None


def _sascorer() -> Any:
    """RDKit's contrib SA_Score module, imported from the RDKit install.

    Lives outside the importable package tree, so it needs a path entry. Some
    RDKit wheels omit `Contrib` entirely; if so this raises and the caller
    records the failure instead of skipping silently.
    """
    global _SASCORER
    if _SASCORER is None:
        import os
        import sys

        from rdkit.Chem import RDConfig

        path = os.path.join(RDConfig.RDContribDir, "SA_Score")
        if not os.path.isdir(path):
            raise ImportError(
                f"RDKit Contrib SA_Score not present at {path}; this RDKit wheel "
                f"does not ship the contrib tree"
            )
        if path not in sys.path:
            sys.path.append(path)
        import sascorer  # type: ignore[import-not-found]

        _SASCORER = sascorer
    return _SASCORER


# ==========================================================================
# Retrieval
# ==========================================================================


class RetrievalScorer:
    """Structures and published property values from external databases.

    Confidence here is *not* uniformly high, and that distinction is the point:
    a diffraction-determined crystal structure is an experimental fact, while
    PubChem's XLogP and the ODAC reference adsorption energies are somebody
    else's *calculation*. `PropertyValue.kind` carries that difference through
    from `athanor.retrieval`, and this scorer maps it onto `confidence` rather
    than flattening everything into "it came from a database, so it is solid".

    Also exposes `retrieve(spec, n)`, the duck-typed hook `loop/seeds.py` looks
    for when seeding a campaign.
    """

    name = "retrieval"
    domains: tuple[Domain, ...] = ("mof_water", "drug_stability")
    properties: tuple[str, ...] = (
        "molecular_weight",
        "xlogp",
        "tpsa",
        "density_g_cm3",
        "water_adsorption_energy",
        "co2_adsorption_energy",
    )

    #: kind -> (confidence, prefix for the note)
    _CONFIDENCE: ClassVar[dict[str, tuple[float, str]]] = {
        "experimental": (
            0.95,
            "EXPERIMENTAL value read from the database, not computed here",
        ),
        "computed": (
            0.55,
            "COMPUTED by the source database, not an experimental measurement",
        ),
        "derived": (0.7, "DERIVED arithmetically from database fields"),
    }

    async def score(self, candidates: list[Candidate], spec: Spec) -> ScoreResult:
        import asyncio

        result = ScoreResult()
        for cand in candidates:
            prov = cand.provenance
            if prov.source != "retrieval" or not prov.database or not prov.external_id:
                continue  # nothing to look up; not a failure
            try:
                await asyncio.to_thread(self._lookup, cand, result)
            except Exception as exc:  # noqa: BLE001
                result.failed[cand.id] = (
                    f"database lookup failed ({prov.database} "
                    f"{prov.external_id}): {exc}"
                )
        return result

    def _lookup(self, cand: Candidate, result: ScoreResult) -> None:
        from .. import retrieval

        prov = cand.provenance
        database = str(prov.database)
        external_id = str(prov.external_id)
        values: list[retrieval.PropertyValue] = []

        if database == "pubchem":
            values.extend(retrieval.fetch("pubchem", external_id).properties)
        elif database.startswith("odac"):
            values.extend(
                retrieval.CsvPropertySource(
                    retrieval.ODAC_REFERENCE_ENERGIES
                ).properties_for(external_id)
            )
        elif database == "cod":
            values.extend(self._from_crystal(cand))

        for pv in values:
            if not _finite(pv.value):
                continue
            confidence, prefix = self._CONFIDENCE.get(pv.kind, (0.5, "from a database"))
            result.measurements.append(
                Measurement(
                    candidate_id=cand.id,
                    property=pv.property,
                    value=round(float(pv.value), 6),
                    unit=pv.unit,
                    source=f"{self.name}:{database}",
                    method=f"read from {database} {external_id}",
                    confidence=confidence,
                    is_proxy=False,
                    note=f"{prefix}. {pv.note}".strip(),
                )
            )

    def _from_crystal(self, cand: Candidate) -> list[Any]:
        """Density straight off an experimentally determined crystal structure."""
        from .. import retrieval

        atoms = parse_structure(cand.structure, cand.repr_kind)
        if not atoms.pbc.any():
            return []
        volume = float(atoms.get_volume())
        if volume <= 0:
            return []
        mass = float(atoms.get_masses().sum())
        density = mass / volume * 1.66053906660
        return [
            retrieval.PropertyValue(
                property="density_g_cm3",
                value=round(density, 5),
                unit="g/cm^3",
                kind="experimental",
                note=(
                    "crystallographic density computed from the measured unit cell "
                    "and contents of this diffraction-determined structure "
                    "(arithmetic on experimental data, no model)"
                ),
            )
        ]

    # --- seeding -----------------------------------------------------------

    async def retrieve(self, spec: Spec, n: int) -> list[Candidate]:
        """Seed candidates for a campaign, read from real databases.

        Never generates a structure. For `mof_water` it serves the named water
        harvesters that genuinely exist in open archives; for `drug_stability`
        it serves real polymorph sets from COD, which is what makes a polymorph
        comparison meaningful at all.
        """
        import asyncio

        return await asyncio.to_thread(self._retrieve_sync, spec, n)

    def _retrieve_sync(self, spec: Spec, n: int) -> list[Candidate]:
        from .. import retrieval

        if spec.domain == "mof_water":
            return self._mof_seeds(n)
        if spec.domain == "drug_stability":
            return self._polymorph_seeds(n)
        raise retrieval.RetrievalError(
            f"this retrieval scorer covers mof_water and drug_stability, "
            f"not {spec.domain!r}"
        )

    def _mof_seeds(self, n: int) -> list[Candidate]:
        from .. import retrieval

        out: list[Candidate] = []
        for entry in retrieval.WATER_HARVESTERS:
            if len(out) >= n:
                break
            source = retrieval.get_source(str(entry["archive"]))
            record = source.fetch(str(entry["refcode"]))
            out.append(
                Candidate(
                    id=f"c-{entry['refcode']}",
                    name=str(entry["name"]),
                    structure=str(record.structure),
                    repr_kind="cif",
                    domain="mof_water",
                    provenance=Provenance(
                        source="retrieval",
                        database=str(entry["archive"]),
                        external_id=str(entry["refcode"]),
                        operation=str(entry.get("note") or ""),
                    ),
                )
            )
        # Top up from the rest of the archive, in a deterministic order.
        if len(out) < n:
            source = retrieval.get_source("odac_promising_mof")
            taken = {c.provenance.external_id for c in out}
            for refcode in source.refcodes():  # type: ignore[attr-defined]
                if len(out) >= n:
                    break
                if refcode in taken:
                    continue
                record = source.fetch(refcode)
                out.append(
                    Candidate(
                        id=f"c-{refcode}",
                        name=refcode,
                        structure=str(record.structure),
                        repr_kind="cif",
                        domain="mof_water",
                        provenance=Provenance(
                            source="retrieval",
                            database="odac_promising_mof",
                            external_id=refcode,
                        ),
                    )
                )
        return out

    def _polymorph_seeds(self, n: int) -> list[Candidate]:
        from .. import retrieval

        out: list[Candidate] = []
        # Cheapest polymorph sets first, so a campaign gets a real comparison
        # inside its compute budget.
        for compound in ("glycine", "paracetamol", "aspirin"):
            for form in retrieval.COD_POLYMORPHS[compound]:
                if len(out) >= n:
                    return out
                record = retrieval.fetch("cod", str(form["cod_id"]))
                out.append(
                    Candidate(
                        id=f"c-cod-{form['cod_id']}",
                        name=f"{compound} form {form['form']}",
                        structure=str(record.structure),
                        repr_kind="cif",
                        domain="drug_stability",
                        provenance=Provenance(
                            source="retrieval",
                            database="cod",
                            external_id=str(form["cod_id"]),
                            operation=f"{compound} polymorph {form['form']}",
                        ),
                    )
                )
        return out


#: Kept so `registry.py`'s pre-existing `_molecular` builder keeps working.
MolecularScorer = Gfn2XtbScorer
