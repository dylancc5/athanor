"""Out-of-distribution detection, per scorer.

A machine-learned interatomic potential will happily return a number for a
structure nothing like its training data, and the number will look plausible.
The Skeptic agent vetoes on this module, so every signal here is a concrete,
checkable statement about *why* a given input is outside what the model learned
from — not a confidence heuristic.

MACE-MP-0 was trained on MPtrj: DFT relaxation trajectories of Materials
Project crystals. Two consequences drive everything below. It has seen only 89
elements, and it has seen geometries at or near equilibrium. So the signals are:

  1. element coverage      — an element absent from the model's embedding table
  2. close contacts        — atoms far closer than any bond in a relaxed crystal
  3. isolated atoms        — an atom with no neighbour inside the model's cutoff
  4. force residual        — the relaxation never reached a minimum
  5. relaxation drop       — the input sat far above any equilibrium
  6. NEB geometry stretch  — a saddle point is, by construction, not a minimum

Two entry points, because the campaign needs OOD at two different moments:
`assess_structure` runs before any compute (that is when the Skeptic reviews),
and `assess_results` runs after, on what the worker actually returned.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

import numpy as np
from ase import Atoms
from ase.data import atomic_numbers, covalent_radii
from pydantic import BaseModel, Field

from .structure import dict_to_atoms

# Extracted from the shipped model, not from memory:
#   mace_mp(model="medium", device="cpu").models[0].atomic_numbers
# -> 89 entries: Z 1-83, then 89-94. Po, At, Rn, Fr and Ra are absent.
MACE_MP0_ATOMIC_NUMBERS: frozenset[int] = frozenset([*range(1, 84), 89, 90, 91, 92, 93, 94])

# A score at or above this is reported as out of distribution.
OOD_THRESHOLD = 0.5

# Thresholds, all stated in the reasons they produce.
CLOSE_CONTACT_HARD = 0.70  # d / (r_i + r_j); below this no relaxed crystal exists
CLOSE_CONTACT_WARN = 0.85
ISOLATION_CUTOFF_A = 6.0  # MACE-MP-0's receptive field; beyond it an atom is alone
ISOLATION_WARN_FACTOR = 1.8  # nearest neighbour this far past the covalent sum
ISOLATION_WARN_A = 3.5
FORCE_WARN_EV_A = 0.10
FORCE_HARD_EV_A = 0.50
DROP_WARN_EV_ATOM = 0.05
DROP_HARD_EV_ATOM = 0.30
STRETCH_WARN = 1.20  # saddle-point nearest-neighbour distance / endpoint's
STRETCH_HARD = 1.45

MAX_PAIRWISE_ATOMS = 2000  # above this, use a neighbour list instead of a full matrix


class OODReport(BaseModel):
    """Why a scorer's number should or should not be trusted for this input."""

    scorer: str
    score: float = Field(ge=0.0, le=1.0)
    hard: bool = False  # the value is not physically meaningful at all
    reasons: list[str] = []
    signals: dict[str, float] = {}

    @property
    def is_ood(self) -> bool:
        return self.hard or self.score >= OOD_THRESHOLD

    def summary(self) -> str:
        if not self.reasons:
            return "No out-of-distribution signal detected."
        head = "Hard OOD" if self.hard else f"OOD score {self.score:.2f}"
        return f"{head}: " + " ".join(self.reasons)


def merge(reports: list[OODReport], *, scorer: str | None = None) -> OODReport:
    """Combine reports with a soft OR: the worst signal decides.

    Max rather than a sum or a mean, because these signals are independent
    reasons to distrust a number and averaging would let one clean signal
    dilute a damning one.
    """
    reports = [r for r in reports if r is not None]
    if not reports:
        return OODReport(scorer=scorer or "unknown", score=0.0)
    signals: dict[str, float] = {}
    reasons: list[str] = []
    for r in reports:
        signals.update(r.signals)
        reasons.extend(r.reasons)
    return OODReport(
        scorer=scorer or reports[0].scorer,
        score=max(r.score for r in reports),
        hard=any(r.hard for r in reports),
        reasons=reasons,
        signals=signals,
    )


def _ramp(value: float, warn: float, hard: float) -> float:
    """0 at or below `warn`, 1 at or above `hard`, linear between."""
    if hard == warn:
        return 1.0 if value >= hard else 0.0
    return float(np.clip((value - warn) / (hard - warn), 0.0, 1.0))


def _covalent_sum(zi: int, zj: int) -> float:
    return float(covalent_radii[zi] + covalent_radii[zj])


def _nearest_neighbours(atoms: Atoms) -> tuple[np.ndarray, np.ndarray]:
    """For each atom: its shortest distance to any other atom, and that atom's index.

    Minimum-image convention when periodic, so a short contact across a cell
    boundary is not missed.
    """
    n = len(atoms)
    if n < 2:
        return np.array([]), np.array([], dtype=int)
    if n <= MAX_PAIRWISE_ATOMS:
        d = atoms.get_all_distances(mic=bool(np.any(atoms.pbc)))
        np.fill_diagonal(d, np.inf)
        return d.min(axis=1), d.argmin(axis=1)

    from ase.neighborlist import neighbor_list

    i, j, dist = neighbor_list("ijd", atoms, ISOLATION_CUTOFF_A)
    best = np.full(n, np.inf)
    who = np.full(n, -1, dtype=int)
    for a, b, dd in zip(i, j, dist, strict=True):
        if dd < best[a]:
            best[a], who[a] = dd, b
    return best, who


# --------------------------------------------------------------------------
# MACE-MP-0
# --------------------------------------------------------------------------


class MaceMPDetector:
    """OOD detector for MACE-MP-0 (MPtrj-trained, 89 elements, near-equilibrium)."""

    scorer = "mace-mp-0"
    elements = MACE_MP0_ATOMIC_NUMBERS

    # ---- before compute -------------------------------------------------

    def assess_structure(self, atoms: Atoms) -> OODReport:
        reasons: list[str] = []
        signals: dict[str, float] = {}
        severities: list[float] = []
        hard = False

        symbols = [str(s) for s in atoms.get_chemical_symbols()]
        unknown = sorted(
            {s for s in symbols if atomic_numbers.get(s, 0) not in self.elements}
        )
        signals["unknown_elements"] = float(len(unknown))
        if unknown:
            hard = True
            severities.append(1.0)
            reasons.append(
                f"{', '.join(unknown)} {'is' if len(unknown) == 1 else 'are'} outside "
                f"MACE-MP-0's {len(self.elements)}-element training set, so the model has "
                f"no learned representation for {'it' if len(unknown) == 1 else 'them'} "
                f"at all — any energy it returns is meaningless."
            )

        if len(atoms) < 2:
            reasons.append(
                "Single-atom input: geometry checks do not apply, and a lone atom has no "
                "neighbours inside the model's 6.0 A cutoff."
            )
            severities.append(1.0)
            hard = True
        else:
            nn, who = _nearest_neighbours(atoms)
            numbers = atoms.get_atomic_numbers()

            # (2) close contacts
            fractions = np.array(
                [
                    nn[i] / _covalent_sum(int(numbers[i]), int(numbers[who[i]]))
                    if np.isfinite(nn[i])
                    else np.inf
                    for i in range(len(atoms))
                ]
            )
            worst = int(np.argmin(fractions))
            frac = float(fractions[worst])
            signals["min_contact_fraction"] = round(frac, 4) if np.isfinite(frac) else -1.0
            if np.isfinite(frac) and frac < CLOSE_CONTACT_WARN:
                pair = f"{symbols[worst]}-{symbols[int(who[worst])]}"
                csum = _covalent_sum(int(numbers[worst]), int(numbers[int(who[worst])]))
                detail = (
                    f"{pair} contact of {nn[worst]:.2f} A is {frac:.2f}x the covalent-radius "
                    f"sum ({csum:.2f} A)"
                )
                if frac < CLOSE_CONTACT_HARD:
                    hard = True
                    severities.append(1.0)
                    reasons.append(
                        f"{detail}. Below {CLOSE_CONTACT_HARD:.2f}x no relaxed crystal in "
                        f"MACE-MP-0's training data exists; the model is extrapolating into "
                        f"a repulsive wall it never saw."
                    )
                else:
                    severities.append(
                        0.6 * _ramp(-frac, -CLOSE_CONTACT_WARN, -CLOSE_CONTACT_HARD)
                    )
                    reasons.append(
                        f"{detail}, short of the {CLOSE_CONTACT_WARN:.2f}x seen in relaxed "
                        f"structures — strained, though still in a plausible range."
                    )

            # (3) isolated atoms
            far = float(np.max(nn[np.isfinite(nn)])) if np.any(np.isfinite(nn)) else 0.0
            signals["max_nn_distance_A"] = round(far, 3)
            idx = int(np.argmax(np.where(np.isfinite(nn), nn, -np.inf)))
            csum = (
                _covalent_sum(int(numbers[idx]), int(numbers[int(who[idx])]))
                if who[idx] >= 0
                else 1.0
            )
            if far > ISOLATION_CUTOFF_A:
                hard = True
                severities.append(1.0)
                reasons.append(
                    f"{symbols[idx]} (atom {idx}) has no neighbour within {far:.1f} A, beyond "
                    f"MACE-MP-0's {ISOLATION_CUTOFF_A:.1f} A cutoff — it is invisible to every "
                    f"other atom, so its energy contribution is a free-atom reference, not "
                    f"chemistry."
                )
            elif far > ISOLATION_WARN_A and far > ISOLATION_WARN_FACTOR * csum:
                severities.append(0.75)
                reasons.append(
                    f"{symbols[idx]} (atom {idx}) sits {far:.2f} A from its nearest neighbour, "
                    f"{far / csum:.1f}x the covalent-radius sum — far looser than the packed "
                    f"crystals MACE-MP-0 was trained on."
                )

        score = max(severities) if severities else 0.0
        return OODReport(
            scorer=self.scorer, score=score, hard=hard, reasons=reasons, signals=signals
        )

    # ---- after compute --------------------------------------------------

    def assess_results(
        self,
        *,
        relax: dict[str, Any] | None = None,
        neb: dict[str, Any] | None = None,
    ) -> OODReport:
        reasons: list[str] = []
        signals: dict[str, float] = {}
        severities: list[float] = []
        hard = False

        if relax is not None:
            # (4) force residual: did the optimizer actually reach a minimum?
            fmax = float(relax.get("max_force", 0.0))
            signals["residual_force_eV_A"] = round(fmax, 4)
            if fmax > FORCE_WARN_EV_A:
                sev = _ramp(fmax, FORCE_WARN_EV_A, FORCE_HARD_EV_A)
                severities.append(sev)
                converged = bool(relax.get("converged", False))
                reasons.append(
                    f"Relaxation left a residual force of {fmax:.3f} eV/A "
                    f"({'did not converge' if not converged else 'converged flag set'} after "
                    f"{relax.get('steps_taken', '?')} steps), above the {FORCE_WARN_EV_A:.2f} "
                    f"eV/A that marks a settled geometry — the reported energy is not a "
                    f"minimum."
                )

            # (5) how far the input was from any equilibrium the model has seen
            n_atoms = int(relax.get("n_atoms", 0) or 0)
            drop_total = relax.get("relaxation_drop_ev")
            if drop_total is not None and n_atoms:
                drop = float(drop_total) / n_atoms
                signals["relaxation_drop_eV_atom"] = round(drop, 4)
                if drop > DROP_WARN_EV_ATOM:
                    severities.append(_ramp(drop, DROP_WARN_EV_ATOM, DROP_HARD_EV_ATOM))
                    reasons.append(
                        f"The input relaxed downhill by {drop:.3f} eV/atom, more than the "
                        f"{DROP_WARN_EV_ATOM:.2f} eV/atom typical of an already-equilibrated "
                        f"cell — it started far from any structure in MACE-MP-0's "
                        f"relaxation-trajectory training set."
                    )
            disp = relax.get("max_displacement_A")
            if disp is not None:
                signals["max_displacement_A"] = round(float(disp), 3)

        if neb is not None:
            if not bool(neb.get("converged", False)):
                severities.append(0.7)
                reasons.append(
                    f"The NEB did not converge in {neb.get('steps', '?')} steps, so the "
                    f"reported barrier is whatever the band had reached, not a located "
                    f"saddle point."
                )
            stretch = _neb_stretch(neb)
            signals.update({k: v for k, v in stretch.items() if v is not None})
            ratio = stretch.get("saddle_stretch_ratio")
            if ratio is not None and ratio > STRETCH_WARN:
                severities.append(_ramp(ratio, STRETCH_WARN, STRETCH_HARD))
                reasons.append(
                    f"At the saddle the migrating ion's nearest-neighbour distance is "
                    f"{ratio:.2f}x its value at the relaxed endpoint — a deliberately "
                    f"non-equilibrium geometry, and MACE-MP-0 was trained on relaxation "
                    f"trajectories, so a transition state is an extrapolation by construction."
                )
            frac = stretch.get("path_min_contact_fraction")
            if frac is not None and frac < CLOSE_CONTACT_HARD:
                hard = True
                severities.append(1.0)
                reasons.append(
                    f"Somewhere along the path the migrating ion is squeezed to {frac:.2f}x "
                    f"the covalent-radius sum of its closest neighbour, inside the "
                    f"{CLOSE_CONTACT_HARD:.2f}x floor — that image's energy is not physical."
                )

        score = max(severities) if severities else 0.0
        return OODReport(
            scorer=self.scorer, score=score, hard=hard, reasons=reasons, signals=signals
        )


def _neb_stretch(neb: dict[str, Any]) -> dict[str, float | None]:
    """Geometric extrapolation along a NEB path, from the artifact payload.

    Computed here rather than in the worker so the validated `op_neb` physics is
    untouched: this reads only the frames it already returns.
    """
    path = neb.get("path") or {}
    frames = path.get("frames")
    energies = path.get("energies") or neb.get("energies")
    symbols = path.get("symbols")
    mobile = path.get("mobile_index")
    out: dict[str, float | None] = {
        "saddle_stretch_ratio": None,
        "path_min_contact_fraction": None,
    }
    if not frames or not symbols or mobile is None or not energies:
        return out

    cell = path.get("cell")
    pbc = bool(path.get("pbc", cell is not None))
    mobile = int(mobile)
    others = [i for i in range(len(symbols)) if i != mobile]
    if not others:
        return out

    def mobile_nn(positions) -> tuple[float, int]:
        atoms = Atoms(
            symbols=list(symbols),
            positions=np.asarray(positions, dtype=float),
            cell=np.asarray(cell, dtype=float) if cell is not None else None,
            pbc=pbc,
        )
        d = np.asarray(atoms.get_distances(mobile, others, mic=pbc), dtype=float)
        k = int(np.argmin(d))
        return float(d[k]), others[k]

    endpoint_nn, _ = mobile_nn(frames[0])
    saddle = int(np.argmax(np.asarray(energies, dtype=float)))
    saddle_nn, _ = mobile_nn(frames[saddle])
    if endpoint_nn > 0:
        out["saddle_stretch_ratio"] = round(saddle_nn / endpoint_nn, 4)

    z_mobile = atomic_numbers.get(str(symbols[mobile]), 0)
    worst = np.inf
    for positions in frames:
        d, j = mobile_nn(positions)
        csum = _covalent_sum(z_mobile, atomic_numbers.get(str(symbols[j]), 0))
        worst = min(worst, d / csum if csum else np.inf)
    if np.isfinite(worst):
        out["path_min_contact_fraction"] = round(float(worst), 4)
    return out


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------


@runtime_checkable
class OODDetector(Protocol):
    scorer: str

    def assess_structure(self, atoms: Atoms) -> OODReport: ...

    def assess_results(
        self, *, relax: dict[str, Any] | None = ..., neb: dict[str, Any] | None = ...
    ) -> OODReport: ...


_DETECTORS: dict[str, OODDetector] = {MaceMPDetector.scorer: MaceMPDetector()}


def for_scorer(name: str) -> OODDetector:
    """The detector for a scorer. Raises rather than returning a silent no-op,
    because a scorer with no OOD model must not look like a clean one."""
    try:
        return _DETECTORS[name]
    except KeyError:
        raise KeyError(
            f"no OOD detector registered for scorer {name!r}; known: {sorted(_DETECTORS)}"
        ) from None


def register(detector: OODDetector) -> None:
    _DETECTORS[detector.scorer] = detector


def assess_structure(atoms: Atoms | dict[str, Any], *, scorer: str = "mace-mp-0") -> OODReport:
    """Pre-compute check, for the Skeptic: elements and geometry only."""
    if isinstance(atoms, dict):
        atoms = dict_to_atoms(atoms)  # type: ignore[arg-type]
    return for_scorer(scorer).assess_structure(atoms)


def assess_results(
    *,
    scorer: str = "mace-mp-0",
    relax: dict[str, Any] | None = None,
    neb: dict[str, Any] | None = None,
) -> OODReport:
    """Post-compute check: convergence, relaxation drop, path geometry."""
    return for_scorer(scorer).assess_results(relax=relax, neb=neb)
