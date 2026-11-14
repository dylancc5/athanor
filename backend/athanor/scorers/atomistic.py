"""The crystal/inorganic scorer: MACE-MP-0 through the out-of-process worker.

What it reports, and where each number comes from:

  energy_per_atom          MACE-MP-0 BFGS relaxation (ML potential, not DFT)
  relaxation_drop          the same relaxation, energy released, per atom
  relaxation_displacement  the same relaxation, how far the furthest atom moved
  migration_barrier        vacancy-mediated CI-NEB (solid_electrolyte only)
  energy_above_hull        Materials Project DFT, read from the database
  band_gap                 Materials Project DFT (GGA) — a *proxy*, flagged

Nothing here is interpolated, estimated or filled in. A property that cannot be
measured for a candidate is named in `ScoreResult.failed` with the reason and is
simply absent from `measurements`. The commonest case is a perturbed candidate:
it has no Materials Project entry, so it has no `energy_above_hull`, and that is
reported as a gap rather than inherited from its parent.

Note for the loop: a candidate can appear in `failed` *and* carry measurements.
`failed` is per-property, keyed by candidate id, so treat it as "here is what is
missing", not "this candidate is dead".
"""

from __future__ import annotations

import asyncio
import logging
import math
from typing import Any

import numpy as np
from ase import Atoms

from .. import mp, ood
from ..contracts import Artifact, Candidate, Domain, Measurement, ScoreResult, Spec
from ..structure import (
    as_json_safe,
    atoms_to_dict,
    parse_structure,
    reduced_formula,
    supercell_for_min_length,
)
from ..workers.base import run_worker

log = logging.getLogger(__name__)

SCORER_NAME = "mace-mp-0"

# Which ion is assumed to migrate, in preference order, in a solid electrolyte.
MOBILE_SPECIES = ("Li", "Na", "K", "Ag", "Mg", "Ca", "Zn", "Al")

# MACE-MP-0 is a fitted potential benchmarked at tens of meV/atom against the
# PBE data it was trained on. 0.75 says "right ordering, real physics, not DFT".
ENERGY_CONFIDENCE = 0.75
# A CI-NEB saddle from a relaxation-trained potential: the mechanism is real,
# the number carries both the potential's error and the path's extrapolation.
BARRIER_CONFIDENCE = 0.6
MP_DFT_CONFIDENCE = 0.95
MP_GAP_CONFIDENCE = 0.6


def _finite(x: Any) -> float:
    v = float(x)
    if not math.isfinite(v):
        raise ValueError(f"non-finite value from worker: {x!r}")
    return v


def _same_composition(formula_a: str, formula_b: str) -> bool:
    """Do two formulas reduce to the same composition?

    Guards against a perturbed child that inherited its parent's `external_id`:
    attaching the parent's hull energy to it would be a fabricated number.
    """
    try:
        from pymatgen.core import Composition

        a = Composition(formula_a).reduced_composition
        b = Composition(formula_b).reduced_composition
        return bool(a.almost_equals(b, rtol=0.0, atol=1e-6))
    except Exception as exc:  # noqa: BLE001 — unparseable formula means "cannot confirm"
        log.warning("composition comparison failed for %r vs %r: %s", formula_a, formula_b, exc)
        return False


class AtomisticScorer:
    """`Scorer` for periodic inorganic candidates, backed by the `mace` worker."""

    name: str = SCORER_NAME
    domains: tuple[Domain, ...] = ("solid_electrolyte", "mof_water")
    properties: tuple[str, ...] = (
        "energy_per_atom",
        "relaxation_drop",
        "relaxation_displacement",
        "migration_barrier",
        "energy_above_hull",
        "band_gap",
    )

    def __init__(
        self,
        *,
        relax_fmax: float = 0.05,
        relax_steps: int = 120,
        neb_images: int = 9,
        neb_fmax: float = 0.05,
        neb_steps: int = 200,
        neb_min_cell_length: float = 8.0,
        neb_max_atoms: int = 220,
        relax_timeout: float = 1200.0,
        neb_timeout: float = 3000.0,
        concurrency: int = 1,
        use_mp: bool = True,
    ) -> None:
        self.relax_fmax = relax_fmax
        self.relax_steps = relax_steps
        self.neb_images = neb_images
        self.neb_fmax = neb_fmax
        self.neb_steps = neb_steps
        self.neb_min_cell_length = neb_min_cell_length
        self.neb_max_atoms = neb_max_atoms
        self.relax_timeout = relax_timeout
        self.neb_timeout = neb_timeout
        self.use_mp = use_mp
        # Each worker gets OMP_NUM_THREADS=8; running NEBs in parallel just
        # oversubscribes the CPU and makes every one of them slower.
        self._sem = asyncio.Semaphore(max(1, int(concurrency)))

    # ---------------------------------------------------------------- public

    async def score(self, candidates: list[Candidate], spec: Spec) -> ScoreResult:
        result = ScoreResult()
        for candidate in candidates:
            failures: list[str] = []
            try:
                await self._score_one(candidate, spec, result, failures)
            except Exception as exc:  # noqa: BLE001 — one bad candidate must not sink the batch
                log.exception("scoring %s failed", candidate.id)
                failures.append(f"all properties: {type(exc).__name__}: {exc}")
            if failures:
                result.failed[candidate.id] = "; ".join(failures)
        return result

    # --------------------------------------------------------------- private

    async def _score_one(
        self,
        candidate: Candidate,
        spec: Spec,
        result: ScoreResult,
        failures: list[str],
    ) -> None:
        try:
            atoms = parse_structure(candidate.structure, candidate.repr_kind)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"all properties: could not parse {candidate.repr_kind}: {exc}")
            return

        # Hard OOD before spending any compute. An element MACE has no embedding
        # for would crash the worker; a geometry with overlapping atoms would
        # return a huge meaningless energy. Either way: report, do not measure.
        pre = ood.assess_structure(atoms, scorer=self.name)
        if pre.hard:
            failures.append(f"all properties: out of distribution — {pre.summary()}")
            return

        mp_entry = await self._mp_entry(candidate, atoms, failures)

        # ---- relaxation -------------------------------------------------
        try:
            relax = await self._worker(
                {
                    "op": "relax",
                    "atoms": atoms_to_dict(atoms),
                    "fmax": self.relax_fmax,
                    "steps": self.relax_steps,
                    "relax_cell": False,
                },
                timeout=self.relax_timeout,
            )
        except Exception as exc:  # noqa: BLE001
            failures.append(
                f"energy_per_atom, relaxation_drop, relaxation_displacement, "
                f"migration_barrier: relaxation failed: {type(exc).__name__}: {exc}"
            )
            return

        post = ood.assess_results(scorer=self.name, relax=relax)
        relax_report = ood.merge([pre, post], scorer=self.name)
        relax_ood = relax_report.is_ood
        relax_note = relax_report.summary() if relax_report.reasons else None
        n_atoms = int(relax["n_atoms"])

        gap_note = None
        if mp_entry is not None and mp_entry.uncorrected_energy_per_atom is not None:
            # Honest context: an ML energy/atom means little on its own, so say
            # how far it sits from the DFT value the model was fitted against.
            delta = _finite(relax["energy_per_atom"]) - mp_entry.uncorrected_energy_per_atom
            gap_note = (
                f"MACE-MP-0 vs Materials Project uncorrected PBE for "
                f"{mp_entry.material_id}: {delta:+.3f} eV/atom."
            )

        self._add(
            result,
            Measurement(
                candidate_id=candidate.id,
                property="energy_per_atom",
                value=round(_finite(relax["energy_per_atom"]), 4),
                unit="eV/atom",
                source=self.name,
                method=(
                    f"MACE-MP-0 (medium, float32) BFGS relaxation at fixed cell, "
                    f"fmax {self.relax_fmax:.2f} eV/A, {relax['steps_taken']} steps, "
                    f"{'converged' if relax['converged'] else 'NOT converged'}"
                ),
                confidence=ENERGY_CONFIDENCE,
                ood_flag=relax_ood,
                note=" ".join(x for x in (gap_note, relax_note) if x) or None,
            ),
        )
        self._add(
            result,
            Measurement(
                candidate_id=candidate.id,
                property="relaxation_drop",
                value=round(_finite(relax["relaxation_drop_ev"]) / n_atoms, 4),
                unit="eV/atom",
                source=self.name,
                method="initial single-point energy minus relaxed energy, per atom",
                confidence=ENERGY_CONFIDENCE,
                ood_flag=relax_ood,
                note=(
                    f"How far the input sat above the potential's nearest minimum. "
                    f"Residual force {_finite(relax['max_force']):.3f} eV/A."
                ),
            ),
        )
        self._add(
            result,
            Measurement(
                candidate_id=candidate.id,
                property="relaxation_displacement",
                value=round(_finite(relax["max_displacement_A"]), 3),
                unit="A",
                source=self.name,
                method="largest per-atom displacement during relaxation (minimum-image)",
                confidence=ENERGY_CONFIDENCE,
                ood_flag=relax_ood,
                note=f"RMS displacement {_finite(relax['rms_displacement_A']):.3f} A.",
            ),
        )
        result.artifacts.append(
            (
                Artifact(
                    id=f"a-relax-{candidate.id}",
                    candidate_id=candidate.id,
                    kind="relaxation_trajectory",
                    label=f"{candidate.name} relaxation ({relax['steps_taken']} steps)",
                    uri=f"artifacts/a-relax-{candidate.id}.json",
                ),
                _relaxation_payload(relax["trajectory"]),
            )
        )

        # ---- Materials Project DFT numbers ------------------------------
        if mp_entry is not None:
            self._add_mp_measurements(candidate, mp_entry, result, failures)

        # ---- migration barrier -----------------------------------------
        if candidate.domain == "solid_electrolyte":
            await self._migration_barrier(candidate, relax, pre, result, failures)

    def _add(self, result: ScoreResult, measurement: Measurement) -> None:
        result.measurements.append(measurement)

    async def _worker(self, request: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        async with self._sem:
            return await run_worker("mace", request, timeout=timeout)

    # ---- Materials Project ---------------------------------------------

    async def _mp_entry(
        self, candidate: Candidate, atoms: Atoms, failures: list[str]
    ) -> mp.MPEntry | None:
        """The candidate's own MP record, or None with the reason recorded.

        Gated on all three of: retrieved (not perturbed), from Materials
        Project, and carrying an external id. Then the composition has to match,
        because a perturbed child can inherit its parent's `external_id`.
        """
        prov = candidate.provenance
        if not self.use_mp:
            failures.append("energy_above_hull, band_gap: Materials Project lookup disabled")
            return None
        if prov.source != "retrieval" or prov.database != mp.SOURCE or not prov.external_id:
            failures.append(
                f"energy_above_hull, band_gap: unavailable — candidate is "
                f"{prov.source}"
                + (f" from {prov.database}" if prov.database else " with no database entry")
                + ", so it has no Materials Project convex-hull or band-structure "
                "calculation. Not estimated."
            )
            return None
        try:
            entry = await mp.aget_entry(prov.external_id)
        except Exception as exc:  # noqa: BLE001
            failures.append(
                f"energy_above_hull, band_gap: Materials Project lookup of "
                f"{prov.external_id} failed: {type(exc).__name__}: {exc}"
            )
            return None

        ours = candidate.formula or reduced_formula(atoms)
        if not _same_composition(ours, entry.formula_pretty):
            failures.append(
                f"energy_above_hull, band_gap: {prov.external_id} is "
                f"{entry.formula_pretty} but this candidate is {ours} — the structure has "
                f"been modified since retrieval, so the stored DFT values do not describe "
                f"it. Not transferred."
            )
            return None
        return entry

    def _add_mp_measurements(
        self,
        candidate: Candidate,
        entry: mp.MPEntry,
        result: ScoreResult,
        failures: list[str],
    ) -> None:
        if entry.energy_above_hull is None:
            failures.append(
                f"energy_above_hull: {entry.material_id} has no hull energy in Materials "
                f"Project (no complete phase diagram for {entry.chemsys})"
            )
        else:
            self._add(
                result,
                Measurement(
                    candidate_id=candidate.id,
                    property="energy_above_hull",
                    value=round(entry.energy_above_hull, 4),
                    unit="eV/atom",
                    source=mp.SOURCE,
                    method=f"DFT (GGA/GGA+U) convex hull, Materials Project {entry.material_id}",
                    confidence=MP_DFT_CONFIDENCE,
                    note=(
                        f"Read from the database, not computed here. "
                        f"{'Experimentally reported phase' if entry.theoretical is False else 'Theoretical (computed-only) phase'}."
                    ),
                ),
            )

        if entry.band_gap is None:
            failures.append(f"band_gap: {entry.material_id} has no band gap in Materials Project")
        else:
            self._add(
                result,
                Measurement(
                    candidate_id=candidate.id,
                    property="band_gap",
                    value=round(entry.band_gap, 3),
                    unit="eV",
                    source=mp.SOURCE,
                    method=f"DFT (GGA) band gap, Materials Project {entry.material_id}",
                    confidence=MP_GAP_CONFIDENCE,
                    is_proxy=True,
                    note=(
                        "Proxy for the electrochemical stability window, which is what "
                        "actually decides whether this survives contact with lithium metal. "
                        "A wide gap is necessary but not sufficient for a wide window. GGA "
                        "systematically underestimates gaps (often by 30-50%), so this is a "
                        "conservative lower bound and should be used ordinally, not as a "
                        "voltage."
                    ),
                ),
            )

    # ---- NEB ------------------------------------------------------------

    async def _migration_barrier(
        self,
        candidate: Candidate,
        relax: dict[str, Any],
        pre: ood.OODReport,
        result: ScoreResult,
        failures: list[str],
    ) -> None:
        relaxed = relax["atoms"]
        symbols = list(relaxed["symbols"])
        species = next((s for s in MOBILE_SPECIES if symbols.count(s) >= 2), None)
        if species is None:
            failures.append(
                f"migration_barrier: no mobile-ion sublattice found — needs at least two "
                f"sites of one of {', '.join(MOBILE_SPECIES)}, structure has "
                f"{reduced_formula(parse_structure(candidate.structure, candidate.repr_kind))}"
            )
            return

        # The NEB expands to a >=8 A supercell so the hopping ion cannot see its
        # own periodic image. Check the cost before committing to it.
        from ..structure import dict_to_atoms

        reps = supercell_for_min_length(dict_to_atoms(relaxed), self.neb_min_cell_length)
        projected = len(symbols) * int(np.prod(reps))
        if projected > self.neb_max_atoms:
            failures.append(
                f"migration_barrier: not attempted — a {self.neb_min_cell_length:.0f} A "
                f"supercell would be {reps[0]}x{reps[1]}x{reps[2]} = {projected} atoms, over "
                f"the {self.neb_max_atoms}-atom budget for a {self.neb_images}-image CI-NEB. "
                f"Not estimated from a smaller cell, because a periodic image of the "
                f"migrating ion changes the barrier."
            )
            return

        try:
            neb = await self._worker(
                {
                    "op": "neb",
                    "atoms": relaxed,
                    "species": species,
                    "n_images": self.neb_images,
                    "fmax": self.neb_fmax,
                    "steps": self.neb_steps,
                    "min_cell_length": self.neb_min_cell_length,
                },
                timeout=self.neb_timeout,
            )
        except Exception as exc:  # noqa: BLE001
            failures.append(f"migration_barrier: NEB failed: {type(exc).__name__}: {exc}")
            return

        post = ood.assess_results(scorer=self.name, neb=neb)
        report = ood.merge([pre, post], scorer=self.name)
        converged = bool(neb["converged"])
        barrier = round(_finite(neb["barrier_ev"]), 3)

        note = (
            f"Rate-limiting uphill climb along a {_finite(neb['hop_distance_A']):.2f} A "
            f"vacancy-mediated {species} hop in a {neb['n_atoms']}-atom "
            f"{'x'.join(str(r) for r in neb['supercell'])} supercell. Forward "
            f"{_finite(neb['forward_barrier_ev']):.3f} eV / reverse "
            f"{_finite(neb['reverse_barrier_ev']):.3f} eV; endpoint asymmetry "
            f"{_finite(neb['endpoint_asymmetry_ev']):.3f} eV "
            f"({'symmetric hop' if _finite(neb['endpoint_asymmetry_ev']) < 0.05 else 'inequivalent sites, so the two directions differ'}). "
            f"Scored as the largest climb from any preceding minimum rather than "
            f"peak-minus-endpoint, because migration often passes through a metastable "
            f"interstitial that would otherwise hide the real barrier."
        )
        if not converged:
            note += (
                f" The band did NOT converge to fmax {self.neb_fmax:.2f} eV/A in "
                f"{self.neb_steps} steps — read this as a lower bound on the saddle, flagged "
                f"out-of-distribution."
            )
        if report.reasons:
            note += " " + report.summary()

        self._add(
            result,
            Measurement(
                candidate_id=candidate.id,
                property="migration_barrier",
                value=barrier,
                unit="eV",
                source=self.name,
                method=str(neb["method"]),
                confidence=BARRIER_CONFIDENCE,
                ood_flag=(not converged) or report.is_ood,
                is_proxy=False,
                note=note,
            ),
        )
        result.artifacts.append(
            (
                Artifact(
                    id=f"a-neb-{candidate.id}",
                    candidate_id=candidate.id,
                    kind="neb_path",
                    label=f"{candidate.name} {species} hop, {barrier:.2f} eV",
                    uri=f"artifacts/a-neb-{candidate.id}.json",
                ),
                _neb_payload(neb["path"]),
            )
        )


# --------------------------------------------------------------------------
# Artifact payloads — exactly the keys the `Artifact` docstring specifies
# --------------------------------------------------------------------------


def _relaxation_payload(trajectory: dict[str, Any]) -> dict[str, Any]:
    return as_json_safe(
        {
            "symbols": list(trajectory["symbols"]),
            "cell": trajectory.get("cell"),
            "pbc": bool(trajectory.get("pbc", False)),
            "frames": trajectory["frames"],
            "energies": trajectory["energies"],
        }
    )


def _neb_payload(path: dict[str, Any]) -> dict[str, Any]:
    return as_json_safe(
        {
            "symbols": list(path["symbols"]),
            "cell": path.get("cell"),
            "pbc": bool(path.get("pbc", False)),
            "frames": path["frames"],
            "energies": path["energies"],
            "mobile_index": int(path["mobile_index"]),
            "barrier_ev": float(path["barrier_ev"]),
        }
    )
