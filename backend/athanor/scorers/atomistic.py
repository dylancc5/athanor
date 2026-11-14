"""The crystal/inorganic scorer: MACE-MP-0 through the out-of-process worker.

What it reports, and where each number comes from:

  energy_per_atom          MACE-MP-0 BFGS relaxation (ML potential, not DFT)
  relaxation_drop          the same relaxation, energy released, per atom
  relaxation_displacement  the same relaxation, how far the furthest atom moved
  migration_barrier        vacancy-mediated CI-NEB (solid_electrolyte only)
  energy_above_hull        distance above a hull built from MACE energies
  energy_above_hull_dft    Materials Project DFT hull — retrieved candidates only
  band_gap                 Materials Project DFT (GGA) — a *proxy*, flagged

Two hull numbers, on purpose. A candidate the Generator invented has no
Materials Project record, so it can never have a DFT hull distance — and if
that were the only route to the value, every invented candidate would be
missing an objective and would silently vanish from the Pareto frontier. So
`energy_above_hull` is computed for *every* candidate by rebuilding the hull of
its chemical system from MACE energies: the competing phases' structures come
from Materials Project, but their energies are recomputed with the same
potential as the candidate's. That is standard practice for screening with a
machine-learned potential, and it is a genuinely different quantity from MP's
DFT hull distance — lower precision, same units — so it carries
`source="mace-mp-0"`, a method string that says so, and a lower confidence.
Where MP's real DFT value also exists it is reported *alongside*, as
`energy_above_hull_dft`, because it is better data. The two are never mixed:
MACE and DFT energies use different reference states, so subtracting one from
the other would be meaningless.

Nothing here is interpolated, estimated or filled in. A property that cannot be
measured for a candidate is named in `ScoreResult.failed` with the reason and is
simply absent from `measurements`. `band_gap` is the honest remaining gap: it
needs electronic structure, MACE is a force field, so an invented candidate has
no band gap and none is fabricated.

Note for the loop: a candidate can appear in `failed` *and* carry measurements.
`failed` is per-property, keyed by candidate id, so treat it as "here is what is
missing", not "this candidate is dead".
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
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
# A hull distance from MACE energies. The hull topology is usually right and
# near-hull phases come out near the hull, but MLIP formation energies carry
# tens of meV/atom of error and that error does not cancel between a candidate
# and the phases it decomposes into. Well below MP's DFT 0.95.
MACE_HULL_CONFIDENCE = 0.55

HULL_CACHE_DIR = Path(
    os.environ.get("ATHANOR_HULL_CACHE", mp.REPO_ROOT / "data" / "cache" / "mace_hull")
)
HULL_CACHE_SCHEMA = 2  # 2: PhaseEnergy records convergence


class HullUnavailable(RuntimeError):
    """The hull for a chemical system could not be built. Never defaulted to 0."""


@dataclass(frozen=True)
class PhaseEnergy:
    material_id: str
    formula: str
    composition: dict[str, float]
    n_atoms: int
    energy_per_atom: float
    converged: bool = True


@dataclass(frozen=True)
class SystemHull:
    """A convex hull for one chemical system, built entirely from MACE energies."""

    elements: tuple[str, ...]
    phases: tuple[PhaseEnergy, ...]
    skipped_large: int
    skipped_failed: int
    fmax: float
    steps: int
    max_atoms: int
    seconds: float

    @property
    def label(self) -> str:
        return "-".join(self.elements)

    def _diagram(self):
        from pymatgen.analysis.phase_diagram import PhaseDiagram
        from pymatgen.core import Composition
        from pymatgen.entries.computed_entries import ComputedEntry

        entries = [
            ComputedEntry(
                Composition(p.composition),
                p.energy_per_atom * sum(p.composition.values()),
                entry_id=p.material_id,
            )
            for p in self.phases
        ]
        return PhaseDiagram(entries), Composition

    def e_above_hull(self, composition: dict[str, float], energy_per_atom: float) -> float:
        """The candidate's distance above this hull, in eV/atom.

        Negative is allowed and meaningful: it says the candidate is more stable
        than anything Materials Project knows for this system, on MACE's energy
        scale. Clamping it to zero would hide exactly the result a discovery
        campaign is looking for.
        """
        from pymatgen.entries.computed_entries import ComputedEntry

        diagram, Composition = self._diagram()
        comp = Composition(composition)
        entry = ComputedEntry(comp, energy_per_atom * comp.num_atoms)
        _, e_above = diagram.get_decomp_and_e_above_hull(entry, allow_negative=True)
        return float(e_above)

    def method(self) -> str:
        return (
            f"convex hull of the {self.label} system rebuilt from MACE-MP-0 energies "
            f"({len(self.phases)} Materials Project phases re-relaxed with MACE at fmax "
            f"{self.fmax:.2f} eV/A); NOT a DFT hull distance"
        )

    @property
    def n_unconverged(self) -> int:
        return sum(1 for p in self.phases if not p.converged)

    @property
    def is_complete(self) -> bool:
        """True when no competing phase was dropped or left unconverged.

        Only on a complete hull can a negative distance be read as "more stable
        than anything known": otherwise the candidate may simply be below a hull
        that is missing one of its own vertices.
        """
        return not (self.skipped_large or self.skipped_failed or self.n_unconverged)

    def exclusions(self) -> str:
        bits = []
        if self.skipped_large:
            bits.append(
                f"{self.skipped_large} phase(s) larger than {self.max_atoms} atoms were "
                f"excluded as too costly to relax; if one of those was a hull vertex this "
                f"distance is an underestimate."
            )
        if self.skipped_failed:
            bits.append(f"{self.skipped_failed} phase(s) failed to relax and were excluded.")
        if self.n_unconverged:
            bits.append(
                f"{self.n_unconverged} phase(s) did not reach fmax {self.fmax:.2f} eV/A, so "
                f"their energies are upper bounds — that pushes the hull up and makes "
                f"candidates look slightly more stable than they are."
            )
        return " ".join(bits)

    def caveat(self) -> str:
        bits = [
            (
                f"The candidate and all {len(self.phases)} competing phases are on one MACE "
                f"energy scale, so this is comparable across candidates but is not MP's DFT "
                f"hull distance and the two must not be compared directly."
            )
        ]
        exclusions = self.exclusions()
        if exclusions:
            bits.append(exclusions)
        return " ".join(bits)

    def to_json(self) -> dict[str, Any]:
        return {
            "schema": HULL_CACHE_SCHEMA,
            "elements": list(self.elements),
            "phases": [asdict(p) for p in self.phases],
            "skipped_large": self.skipped_large,
            "skipped_failed": self.skipped_failed,
            "fmax": self.fmax,
            "steps": self.steps,
            "max_atoms": self.max_atoms,
            "seconds": self.seconds,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> SystemHull:
        return cls(
            elements=tuple(d["elements"]),
            phases=tuple(PhaseEnergy(**p) for p in d["phases"]),
            skipped_large=int(d["skipped_large"]),
            skipped_failed=int(d["skipped_failed"]),
            fmax=float(d["fmax"]),
            steps=int(d["steps"]),
            max_atoms=int(d["max_atoms"]),
            seconds=float(d["seconds"]),
        )


def _finite(x: Any) -> float:
    v = float(x)
    if not math.isfinite(v):
        raise ValueError(f"non-finite value from worker: {x!r}")
    return v


class HullBuilder:
    """Builds and caches one MACE convex hull per chemical system.

    The hull is the expensive part — dozens of relaxations — and it is reused by
    every candidate in that system and by every later round of the campaign, so
    it is cached both in memory and on disk. The disk key includes the relaxation
    settings, because a hull built at a different `fmax` is a different hull.
    """

    def __init__(
        self,
        runner,
        *,
        fmax: float = 0.05,
        steps: int = 120,
        max_atoms: int = 80,
        max_phases: int = 400,
    ):
        self._runner = runner  # async (request, timeout) -> response
        self.fmax = fmax
        self.steps = steps
        self.max_atoms = max_atoms
        self.max_phases = max_phases
        self._memory: dict[tuple[str, ...], SystemHull] = {}
        self._locks: dict[tuple[str, ...], asyncio.Lock] = {}

    def _path(self, elements: tuple[str, ...]) -> Path:
        key = (
            f"{'-'.join(elements)}__fmax{self.fmax:g}_steps{self.steps}"
            f"_max{self.max_atoms}_v{HULL_CACHE_SCHEMA}"
        )
        return HULL_CACHE_DIR / f"{key}.json"

    async def get(self, elements: set[str] | tuple[str, ...], *, timeout: float) -> SystemHull:
        els = tuple(sorted(str(e) for e in elements))
        if not els:
            raise HullUnavailable("candidate has no elements")
        if els in self._memory:
            return self._memory[els]

        # One build per system even if several candidates arrive together.
        lock = self._locks.setdefault(els, asyncio.Lock())
        async with lock:
            if els in self._memory:
                return self._memory[els]

            path = self._path(els)
            if path.exists():
                try:
                    data = json.loads(path.read_text())
                    if data.get("schema") == HULL_CACHE_SCHEMA:
                        hull = SystemHull.from_json(data)
                        self._memory[els] = hull
                        return hull
                except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
                    log.warning("ignoring unreadable hull cache %s: %s", path, exc)

            hull = await self._build(els, timeout=timeout)
            self._memory[els] = hull
            HULL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(HULL_CACHE_DIR), suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(hull.to_json(), f, sort_keys=True)
                os.replace(tmp, path)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise
            return hull

    async def _build(self, elements: tuple[str, ...], *, timeout: float) -> SystemHull:
        started = time.monotonic()
        try:
            found = await mp.acompeting_phases(list(elements), max_atoms=self.max_atoms)
        except Exception as exc:
            raise HullUnavailable(
                f"could not retrieve competing phases for {'-'.join(elements)}: "
                f"{type(exc).__name__}: {exc}"
            ) from exc

        phases = found["phases"]
        if not phases:
            raise HullUnavailable(
                f"Materials Project returned no phases for {'-'.join(elements)} with at most "
                f"{self.max_atoms} atoms"
            )
        if len(phases) > self.max_phases:
            # Refuse rather than silently truncate: dropping an arbitrary subset
            # of phases would move the hull by an unknown amount.
            raise HullUnavailable(
                f"the {'-'.join(elements)} system has {len(phases)} competing phases, over "
                f"the {self.max_phases}-phase budget; relaxing them all would dominate the "
                f"run, and truncating the set would move the hull by an unknown amount"
            )

        # One worker call for the whole batch: the model loads once, not N times.
        response = await self._runner(
            {
                "op": "relax_many",
                "structures": [
                    {"label": p["entry_id"], "atoms": p["structure"]} for p in phases
                ],
                "fmax": self.fmax,
                "steps": self.steps,
            },
            timeout=timeout,
        )

        by_id = {p["entry_id"]: p for p in phases}
        energies: list[PhaseEnergy] = []
        failed = 0
        for item in response["results"]:
            phase = by_id.get(item.get("label"))
            if phase is None:
                continue
            if "error" in item:
                failed += 1
                log.warning(
                    "hull phase %s (%s) failed to relax: %s",
                    phase["material_id"],
                    phase["formula_pretty"],
                    item["error"],
                )
                continue
            value = float(item["energy_per_atom"])
            if not math.isfinite(value):
                failed += 1
                continue
            energies.append(
                PhaseEnergy(
                    material_id=phase["material_id"],
                    formula=phase["formula_pretty"],
                    composition=phase["composition"],
                    n_atoms=int(phase["n_sites"]),
                    energy_per_atom=value,
                    converged=bool(item.get("converged", True)),
                )
            )

        # A hull is undefined without a reference for every element in the system.
        covered = {el for p in energies for el, n in p.composition.items() if n > 0}
        missing = set(elements) - covered
        if missing:
            raise HullUnavailable(
                f"no usable phase containing {', '.join(sorted(missing))} in the "
                f"{'-'.join(elements)} system, so its convex hull is undefined"
            )

        # Deterministic: sort by material id so a rebuild gives an identical hull.
        energies.sort(key=lambda p: p.material_id)
        return SystemHull(
            elements=elements,
            phases=tuple(energies),
            skipped_large=int(found.get("skipped_large", 0)),
            skipped_failed=failed,
            fmax=self.fmax,
            steps=self.steps,
            max_atoms=self.max_atoms,
            seconds=round(time.monotonic() - started, 2),
        )


def _phase_note(entry: mp.MPEntry) -> str:
    """Whether the phase has been made. Three-way: a missing flag is not a 'no'."""
    if entry.theoretical is False:
        return "Experimentally reported phase."
    if entry.theoretical is True:
        return "Theoretical (computed-only) phase — never reported experimentally."
    return "Materials Project does not record whether this phase has been made experimentally."


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
        "energy_above_hull",  # MACE-derived, available for every candidate
    )
    # Measured and reported, but deliberately NOT in `properties`.
    #
    # `properties` is the vocabulary the intake agent may draw objectives from,
    # and `pareto.rank()` excludes any candidate missing an objective. Both keys
    # below exist only for candidates retrieved from Materials Project, so
    # offering either as an objective would silently delete every invented
    # candidate from the frontier — the exact bug the MACE hull exists to fix.
    #
    #   energy_above_hull_dft  MP's DFT hull distance; no MP record, no value.
    #   band_gap               needs electronic structure, and MACE-MP-0 is a
    #                          force field. It is structurally uncomputable for
    #                          a candidate we invented, so as an objective it is
    #                          not an objective at all — it is a filter that
    #                          removes the whole generation branch from the one
    #                          view where candidates visibly compete.
    #
    # Please don't add either one back here. Both are still emitted as
    # measurements for retrieved candidates, `band_gap` honestly flagged
    # `is_proxy` for the electrochemical window, and both belong in the
    # measurements table — just not in the objective vocabulary.
    extra_properties: tuple[str, ...] = ("energy_above_hull_dft", "band_gap")

    #: Properties that only apply to a periodic ionic conductor. A MOF gets
    #: neither (no mobile-ion hop; a dense-phase hull distance is meaningless
    #: for an open framework), so a scorer serving `mof_water` must not
    #: advertise them — `router.property_vocabulary` unions `properties`
    #: per domain with no narrowing, and an objective nothing measures empties
    #: the frontier. `registry.all_scorers()` therefore registers one instance
    #: per domain with the right tuple; see `for_domain`.
    SOLID_ONLY: tuple[str, ...] = ("migration_barrier", "energy_above_hull")

    def __init__(
        self,
        *,
        relax_fmax: float = 0.05,
        relax_steps: int = 120,
        neb_images: int = 9,
        neb_fmax: float = 0.05,
        # 200 was not enough for Li3PS4 once the endpoints are MACE-relaxed
        # (the band stalled at 0.275 eV still unconverged); 400 converges it.
        neb_steps: int = 400,
        neb_min_cell_length: float = 8.0,
        neb_max_atoms: int = 220,
        relax_timeout: float = 1200.0,
        neb_timeout: float = 3000.0,
        hull_timeout: float = 2400.0,
        hull_max_atoms: int = 80,
        concurrency: int = 1,
        use_mp: bool = True,
        use_mace_hull: bool = True,
        domains: tuple[Domain, ...] | None = None,
    ) -> None:
        if domains is not None:
            # Instance-level override, so one domain's objective vocabulary
            # cannot advertise another domain's properties.
            self.domains = tuple(domains)
            if "solid_electrolyte" not in self.domains:
                self.properties = tuple(
                    p for p in type(self).properties if p not in self.SOLID_ONLY
                )
        self.relax_fmax = relax_fmax
        self.relax_steps = relax_steps
        self.neb_images = neb_images
        self.neb_fmax = neb_fmax
        self.neb_steps = neb_steps
        self.neb_min_cell_length = neb_min_cell_length
        self.neb_max_atoms = neb_max_atoms
        self.relax_timeout = relax_timeout
        self.neb_timeout = neb_timeout
        self.hull_timeout = hull_timeout
        self.use_mp = use_mp
        self.use_mace_hull = use_mace_hull
        # Each worker gets OMP_NUM_THREADS=8; running NEBs in parallel just
        # oversubscribes the CPU and makes every one of them slower.
        self._sem = asyncio.Semaphore(max(1, int(concurrency)))
        self._hulls = HullBuilder(
            self._worker, fmax=relax_fmax, steps=relax_steps, max_atoms=hull_max_atoms
        )

    # ---------------------------------------------------------------- public

    async def score(self, candidates: list[Candidate], spec: Spec) -> ScoreResult:
        result = ScoreResult()
        for candidate in candidates:
            failures: list[str] = []
            try:
                await self._score_one(candidate, spec, result, failures)
            except Exception as exc:
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

        # ---- Materials Project DFT numbers ------------------------------
        # Recorded before the relaxation on purpose: these are database reads
        # and are valid whatever MACE does next, so a worker crash must not
        # throw away a hull energy we already hold.
        mp_entry = await self._mp_entry(candidate, atoms, failures)
        if mp_entry is not None:
            self._add_mp_measurements(candidate, mp_entry, result, failures)

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

        # Honest context: an ML energy/atom means little on its own, so say how
        # far it sits from the DFT value the model was actually fitted against.
        # That reference has to be the raw GGA/GGA+U energy (what MPtrj
        # contains), NOT the summary endpoint's `uncorrected_energy_per_atom`,
        # which is the r2SCAN value on an entirely different scale. If MP has no
        # GGA/GGA+U entry, the comparison is omitted rather than mislabelled.
        gap_note = None
        if mp_entry is not None:
            try:
                reference = await mp.agga_reference_energy_per_atom(mp_entry.material_id)
            except Exception as exc:  # noqa: BLE001 — context only, never a measurement
                log.warning("GGA reference lookup failed for %s: %s", mp_entry.material_id, exc)
                reference = None
            if reference is not None:
                delta = _finite(relax["energy_per_atom"]) - reference
                gap_note = (
                    f"For scale: Materials Project's raw GGA/GGA+U energy for "
                    f"{mp_entry.material_id} is {reference:.3f} eV/atom, so MACE-MP-0 is "
                    f"{delta:+.3f} eV/atom from the DFT data it was trained on."
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

        # ---- MACE convex hull, for every candidate ----------------------
        await self._mace_hull(
            candidate, atoms, relax, relax_ood, result, failures, is_known_phase=mp_entry is not None
        )

        # ---- migration barrier -----------------------------------------
        if candidate.domain == "solid_electrolyte":
            await self._migration_barrier(candidate, relax, pre, result, failures)

    def _add(self, result: ScoreResult, measurement: Measurement) -> None:
        result.measurements.append(measurement)

    # ---- MACE-derived convex hull ---------------------------------------

    async def _mace_hull(
        self,
        candidate: Candidate,
        atoms: Atoms,
        relax: dict[str, Any],
        relax_ood: bool,
        result: ScoreResult,
        failures: list[str],
        *,
        is_known_phase: bool,
    ) -> None:
        """`energy_above_hull` for any candidate, invented or retrieved.

        This is the measurement that lets a generated candidate reach the Pareto
        frontier at all: `pareto.rank()` drops a candidate that is missing an
        objective, and only a retrieved candidate can ever have a DFT hull
        distance. Everything here — candidate and competing phases alike — is
        MACE energy, so the comparison is internally consistent.
        """
        if not self.use_mace_hull:
            failures.append("energy_above_hull: MACE hull construction disabled")
            return
        if candidate.domain != "solid_electrolyte":
            # A MOF is a metastable open framework: it is *always* far above the
            # hull of dense phases, so the distance says nothing about whether it
            # is makeable, and the chemical system (Zn-C-H-N-O and every
            # subsystem) would mean hundreds of relaxations for that non-answer.
            failures.append(
                f"energy_above_hull: not computed for the {candidate.domain} domain — a "
                f"hull distance against dense competing phases is not the relevant "
                f"stability measure for an open framework, and would be misleading here."
            )
            return

        composition: dict[str, float] = {}
        for symbol in atoms.get_chemical_symbols():
            composition[str(symbol)] = composition.get(str(symbol), 0.0) + 1.0

        try:
            hull = await self._hulls.get(set(composition), timeout=self.hull_timeout)
            value = hull.e_above_hull(composition, _finite(relax["energy_per_atom"]))
        except Exception as exc:  # noqa: BLE001
            log.warning("MACE hull unavailable for %s: %s", candidate.id, exc)
            failures.append(
                f"energy_above_hull: could not build a MACE convex hull for this chemical "
                f"system: {type(exc).__name__}: {exc}. Not estimated."
            )
            return

        if not math.isfinite(value):
            failures.append("energy_above_hull: MACE hull gave a non-finite distance")
            return

        note = hull.caveat()
        if value < -0.001:
            if is_known_phase:
                # This candidate IS one of the known phases of this system. It
                # cannot genuinely sit below the hull of known phases; it only
                # appears to because its own entry was excluded (too large, or
                # failed to relax) or because of MACE noise. Reporting the
                # negative number would put a database entry at the top of the
                # frontier as a "discovery", which would be false.
                note = (
                    f"Raw hull distance came out at {value:+.4f} eV/atom and has been "
                    f"reported as 0.0: this is an existing Materials Project phase, so it "
                    f"cannot be more stable than the hull of known phases. The negative "
                    f"value means its own entry is not among the phases used to build this "
                    f"hull. " + note
                )
                value = 0.0
            else:
                note = (
                    f"Negative: on MACE's energy scale this sits {abs(value):.4f} eV/atom "
                    f"below the hull of the {len(hull.phases)} {hull.label} phases relaxed "
                    f"here. Not clamped. Read it as a lead requiring DFT confirmation, not a "
                    f"result: a sub-hull prediction from a machine-learned potential is "
                    f"within that potential's own error bar, and "
                    + (
                        "this hull is complete, so no known phase was omitted."
                        if hull.is_complete
                        else "this hull is incomplete (see below), so a missing phase may "
                        "be the real explanation."
                    )
                    + " "
                    + note
                )
        self._add(
            result,
            Measurement(
                candidate_id=candidate.id,
                property="energy_above_hull",
                value=round(value, 4),
                unit="eV/atom",
                source=self.name,
                method=hull.method(),
                confidence=MACE_HULL_CONFIDENCE,
                ood_flag=relax_ood,
                is_proxy=False,
                note=note,
            ),
        )

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
            failures.append(
                "energy_above_hull_dft, band_gap: Materials Project lookup disabled"
            )
            return None
        if prov.source != "retrieval" or prov.database != mp.SOURCE or not prov.external_id:
            failures.append(
                f"energy_above_hull_dft, band_gap: unavailable — candidate is "
                f"{prov.source}"
                + (f" from {prov.database}" if prov.database else " with no database entry")
                + ", so there is no Materials Project DFT hull distance or band structure "
                "for it. Neither is estimated. Its `energy_above_hull` is still measured, "
                "from the MACE-rebuilt hull of its chemical system; `band_gap` genuinely "
                "cannot be computed here, because that needs electronic structure and "
                "MACE-MP-0 is a force field."
            )
            return None
        try:
            entry = await mp.aget_entry(prov.external_id)
        except Exception as exc:  # noqa: BLE001
            failures.append(
                f"energy_above_hull_dft, band_gap: Materials Project lookup of "
                f"{prov.external_id} failed: {type(exc).__name__}: {exc}"
            )
            return None

        ours = candidate.formula or reduced_formula(atoms)
        if not _same_composition(ours, entry.formula_pretty):
            failures.append(
                f"energy_above_hull_dft, band_gap: {prov.external_id} is "
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
                f"energy_above_hull_dft: {entry.material_id} has no hull energy in Materials "
                f"Project (no complete phase diagram for {entry.chemsys})"
            )
        else:
            # Reported *alongside* the MACE hull, never instead of it. This is
            # the better number where it exists, but it exists only for
            # retrieved candidates, so it cannot be the Pareto objective.
            self._add(
                result,
                Measurement(
                    candidate_id=candidate.id,
                    property="energy_above_hull_dft",
                    value=round(entry.energy_above_hull, 4),
                    unit="eV/atom",
                    source=mp.SOURCE,
                    method=(
                        f"DFT convex hull from the Materials Project summary "
                        f"({mp.MIXED_SCHEME} mixed scheme), {entry.material_id}"
                    ),
                    confidence=MP_DFT_CONFIDENCE,
                    note=(
                        f"Read from the database, not computed here — real DFT, and more "
                        f"reliable than the MACE hull distance reported as "
                        f"`energy_above_hull`. The two are different quantities on different "
                        f"energy scales and must not be compared value-for-value. "
                        f"{_phase_note(entry)}"
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
                f"{self.neb_steps} steps, so this is whatever the band had reached and not a "
                f"located saddle point: the true barrier may be either higher or lower. "
                f"Flagged out-of-distribution."
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
