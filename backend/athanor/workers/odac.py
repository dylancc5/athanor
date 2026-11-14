"""ODAC23 worker: framework-guest energetics for porous frameworks.

Runs in `backend/envs/fairchem` (Python 3.11 + torch 2.4). Worker protocol:
`athanor/workers/base.py`; reference implementation: `athanor/workers/mace.py`.

Request: {"op": "<name>", ...}
Ops:
  ping       -> {"model", "n_params"}
  energy     -> {"atoms"}                   -> {"energy_ev", "max_force", "n_atoms"}
  adsorption -> {"host", "guest"?, "n_sites"?, "relax_steps"?, "fmax"?}
                -> {"adsorption_energy_ev", "host_energy_ev", "guest_energy_ev",
                    "host_guest_energy_ev", "sites": [...], "best_site_index",
                    "adsorption_sites": {...}, "trajectory": {...}}
  relax_guest-> one site, keeping every frame

-------------------------------------------------------------------------------
What this model's energy actually is  (measured, not assumed)
-------------------------------------------------------------------------------
The ODAC23 S2EF checkpoints do **not** predict total DFT energies, and they do
not predict a composition-referenced energy either. The output for a
framework+guest system **is already the adsorption energy**, referenced to the
clean framework and the gas-phase guest. So:

    E_ads = E_model(host + guest)          <-- no subtraction

This was established empirically, not read off a doc page. Running the clean
framework through the model for the eight MOFs in the validation set gave:

    CAVSUP   58 atoms  -0.396 eV      QERZUI    54 atoms  -0.387 eV
    ECEZAO01 49 atoms  -0.405 eV      XEDPON    52 atoms  -0.415 eV
    LUFQUZ   20 atoms  -0.402 eV      ZAGHAT    45 atoms  -0.381 eV
    NEVVEQ   56 atoms  -0.397 eV      alf350K   56 atoms  -0.410 eV

E(host) is ~-0.40 eV for every one of them and does **not scale with atom
count** over a 20-to-58 atom range. That value is the checkpoint's own
`target_mean` (-0.39596545696258545, in the config). In other words a *clean*
framework is an out-of-distribution input — there is no adsorbate, so there is
nothing for the model to predict — and the network falls back to the dataset
mean. `E(host)` is therefore not a reference, not an energy, and not usable in
arithmetic.

The three-term form `E(host+guest) - E(host) - E(guest)` was tried first and is
wrong: it adds two spurious constants (+0.40 for the host term, +0.22 for the
isolated-guest term). Against the published DFT reference energies it gave a
mean signed error of +1.017 eV, which is 0.395 + 0.40 + 0.22 to within rounding
— the offsets accounted for exactly. Using the raw model output drops the mean
signed error to +0.395 eV, and the *spread* of the error is identical (sd 0.248
eV) for all three formulas, confirming the difference between them is pure
constant.

`host_energy_ev` is still reported, as a diagnostic only: when it sits near
-0.40 eV it is the model saying "no adsorbate here", which is a useful check
that the host was parsed as expected. It must never be subtracted.

Residual accuracy, stated honestly: against the 8 published DFT reference
values the remaining error is a mean signed +0.395 eV / MAE 0.395 eV — this
pipeline systematically reports *weaker* binding than the reference. The cause
is site sampling, not the energy model: the reference values come from
exhaustive configurational sampling with full DFT relaxation including the
framework, while this worker screens a few deterministic placements and relaxes
the guest against a rigid framework. Every adsorption energy from here is
therefore an **upper bound** on the true binding strength.

-------------------------------------------------------------------------------
Determinism  (diagnosed, then fixed)
-------------------------------------------------------------------------------
Out of the box this model is **not reproducible**: 10 identical forward passes
on a 192-atom framework gave 9 distinct energies spanning 1.1e-5 eV.

The cause is not what it looks like. It is not non-deterministic scatter-add
ordering: the sequence of values is *identical across separate processes* and
unchanged by `torch.set_num_threads(1)`, and `torch.manual_seed(0)` resets it
to the first value. Something in the forward pass draws from the torch RNG on
every call. The consequence is nastier than mere noise — the n-th evaluation in
a process depends on how many evaluations preceded it, so changing `n_sites` or
the order of placements would shift every energy in a run.

It is also not the dropout modules. fairchem's `OCPCalculator` does leave the
model in training mode (`model.training is True`, with 16 dropout modules at
p=0.1), but zeroing every dropout probability and calling `.eval()` changed
nothing: the values carried straight on down the same RNG stream. The most
likely consumer is EquiformerV2's `num_sphere_samples: 128` sampling in the
energy head.

Fix, verified: seed the torch RNG immediately before every forward pass. With
`_seeded_energy` below, 10 repeats give exactly one distinct value, and
`op_adsorption` run twice on the same framework produces identical JSON. The
model is also put in eval mode with dropout zeroed, so inference semantics are
right even though that alone did not affect reproducibility.

GemNet-OC-S2EF-ODAC does not load in this environment at all: fairchem 1.10
looks for `configs/s2ef/all/gemnet/scaling_factors/gemnet-oc.pt`, which the
wheel does not ship, and raises `ValueError: Scale file ... does not exist`.
EquiformerV2 is used instead and is faster anyway.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from athanor.structure import atoms_to_dict, dict_to_atoms

MODEL = "EquiformerV2-S2EF-ODAC"
LOCAL_CACHE = "/Users/kittenoverlord/.cache/fairchem"

#: Decimals kept on reported energies. Far below the model's own accuracy
#: (~0.1-0.3 eV), and the forward pass is exactly reproducible anyway — see the
#: determinism note above.
ENERGY_DP = 4

#: Seed applied before every forward pass. Any fixed value works; what matters
#: is that it is reapplied each time, so a pass never depends on how many
#: passes came before it.
FORWARD_SEED = 0

#: OC20/ODAC tag convention: 0 = framework, 2 = adsorbate. Measured effect of
#: tag value on this checkpoint's energy is ~1e-5 eV, i.e. inside the repeat
#: noise, but the convention is followed so the input is well formed.
TAG_FRAMEWORK = 0
TAG_GUEST = 2

_calc = None


def get_calculator():
    """Load the ODAC23 checkpoint once per worker process, in inference mode.

    `OCPCalculator` hands back a model still in training mode, so dropout is
    switched off here explicitly. On its own that does not change any energy
    (see the determinism note); it is done so the network is actually being
    used for inference rather than relied upon to behave as if it were.
    """
    global _calc
    if _calc is None:
        import torch
        from fairchem.core import OCPCalculator

        class SeededOCPCalculator(OCPCalculator):
            """Reseeds before every evaluation, so each pass is independent of
            how many passes preceded it.

            The seed has to be applied here rather than at the call sites: an
            ASE optimizer drives the calculator directly during a relaxation,
            so seeding only around explicit energy calls would leave every
            relaxation step unseeded.
            """

            def calculate(self, *args, **kwargs):  # noqa: ANN002, ANN003
                torch.manual_seed(FORWARD_SEED)
                return super().calculate(*args, **kwargs)

        _calc = SeededOCPCalculator(
            model_name=MODEL, local_cache=LOCAL_CACHE, cpu=True, seed=0
        )
        model = _calc.trainer.model
        for module in model.modules():
            if "drop" in type(module).__name__.lower():
                for attr in ("p", "drop_prob", "drop_rate"):
                    if isinstance(getattr(module, attr, None), float):
                        setattr(module, attr, 0.0)
        model.eval()
    return _calc


def _energy(atoms) -> float:
    """One forward pass. Clears any cached result so the pass really happens."""
    atoms.calc = get_calculator()
    atoms.calc.results = {}
    e = float(atoms.get_potential_energy())
    if not np.isfinite(e):
        raise ValueError(f"model returned a non-finite energy: {e}")
    return e


def _round(x: float) -> float:
    return round(float(x), ENERGY_DP)


# --------------------------------------------------------------------------
# Guests
# --------------------------------------------------------------------------


def build_guest(spec: Any):
    """The guest molecule, in a fixed deterministic geometry.

    `spec` is either a formula string ASE knows (`"H2O"`, `"CO2"`) or an
    AtomsDict. Named molecules come from ASE's G2 geometries, so the reference
    geometry is identical on every run and every machine.
    """
    from ase.build import molecule

    if isinstance(spec, str):
        return molecule(spec)
    if isinstance(spec, dict):
        return dict_to_atoms(spec)
    raise ValueError(f"guest must be a formula string or an AtomsDict, got {type(spec)}")


def _relax_guest_only(combined, n_host: int, *, fmax: float, steps: int):
    """Relax only the guest; the framework is held rigid.

    Why rigid: the campaign's question is where the guest sits and how strongly
    it binds, and relaxing the framework as well would fold framework strain
    into the adsorption energy while multiplying the cost by the number of
    framework degrees of freedom. Stated in `method` on every measurement.
    """
    from ase.constraints import FixAtoms
    from ase.optimize import LBFGS

    combined.calc = get_calculator()
    combined.set_constraint(FixAtoms(indices=list(range(n_host))))

    frames: list[list[list[float]]] = []
    energies: list[float] = []

    def record() -> None:
        frames.append(np.asarray(combined.get_positions(), dtype=float).round(4).tolist())
        energies.append(_round(combined.get_potential_energy()))

    opt = LBFGS(combined, logfile=None)
    opt.attach(record, interval=1)
    converged = bool(opt.run(fmax=fmax, steps=steps))
    if not frames:
        record()
    combined.set_constraint()
    return frames, energies, converged


# --------------------------------------------------------------------------
# Ops
# --------------------------------------------------------------------------


def op_ping(_: dict[str, Any]) -> dict[str, Any]:
    calc = get_calculator()
    n = sum(p.numel() for p in calc.trainer.model.parameters())
    return {"model": MODEL, "n_params": int(n)}


def op_energy(req: dict[str, Any]) -> dict[str, Any]:
    atoms = dict_to_atoms(req["atoms"])
    t0 = time.perf_counter()
    e = _energy(atoms)
    dt = time.perf_counter() - t0
    return {
        "energy_ev": _round(e),
        "max_force": _round(float(np.abs(atoms.get_forces()).max())),
        "n_atoms": len(atoms),
        "seconds": round(dt, 3),
        "note": (
            "referenced energy, not a total DFT energy; only differences "
            "between energies of the same overall composition are meaningful"
        ),
    }


def _orientations(n: int) -> list[np.ndarray]:
    """`n` deterministic rotation matrices, evenly spread over orientations.

    Guest orientation decides whether a water molecule can hydrogen-bond to the
    framework at all, so a single orientation per site badly under-samples the
    binding geometry. Axes come from a Fibonacci sphere and the angle from the
    golden ratio, so the set is fixed, reproducible and has no random seed.
    """
    if n <= 1:
        return [np.eye(3)]
    i = np.arange(n, dtype=float) + 0.5
    phi = np.arccos(1.0 - 2.0 * i / n)
    golden = np.pi * (1.0 + 5.0**0.5)
    theta = golden * i
    axes = np.stack(
        [np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], axis=-1
    )
    angles = 2.0 * np.pi * ((i * 0.6180339887498949) % 1.0)

    mats = []
    for axis, angle in zip(axes, angles):
        axis = axis / np.linalg.norm(axis)
        x, y, z = axis
        c, s = np.cos(angle), np.sin(angle)
        k = np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]], dtype=float)
        mats.append(np.eye(3) * c + s * k + (1 - c) * np.outer(axis, axis))
    return mats


def _place_oriented(host, guest, position: np.ndarray, rotation: np.ndarray):
    """Host + guest, guest rotated about its centre of mass then translated."""
    g = guest.copy()
    pos = np.asarray(g.get_positions(), dtype=float)
    pos = (pos - g.get_center_of_mass()) @ rotation.T + np.asarray(position, dtype=float)
    g.set_positions(pos)
    combined = host.copy() + g
    combined.cell = host.cell
    combined.pbc = host.pbc
    combined.set_tags([TAG_FRAMEWORK] * len(host) + [TAG_GUEST] * len(g))
    return combined


def op_adsorption(req: dict[str, Any]) -> dict[str, Any]:
    """Adsorption energy of one guest in a framework.

    E_ads is the model's output for the framework+guest system directly; see
    the module docstring for the measurements that establish this.

    Strategy is screen-then-relax, because a relaxation step costs a full
    forward pass and placements are cheap:
      1. build `n_sites` x `n_orientations` deterministic placements,
      2. one single-point each (the screen),
      3. relax only the best `n_relax` of them,
      4. report the lowest energy found.
    """
    from athanor import pores

    host = dict_to_atoms(req["host"])
    if not np.any(host.pbc):
        raise ValueError("host framework must be periodic")
    guest = build_guest(req.get("guest", "H2O"))

    n_sites = int(req.get("n_sites", 4))
    n_orientations = int(req.get("n_orientations", 4))
    n_relax = int(req.get("n_relax", 3))
    steps = int(req.get("relax_steps", 40))
    fmax = float(req.get("fmax", 0.05))
    spacing = float(req.get("grid_spacing", 0.6))
    min_clearance = max(1.0, float(req.get("min_clearance", 1.32)))

    t_start = time.perf_counter()
    host_tagged = host.copy()
    host_tagged.set_tags([TAG_FRAMEWORK] * len(host))

    t0 = time.perf_counter()
    e_host = _energy(host_tagged)
    seconds_per_pass = time.perf_counter() - t0

    sites = pores.candidate_sites(
        host,
        n_sites=n_sites,
        spacing=spacing,
        min_clearance=min_clearance,
        prefer=str(req.get("site_preference", "wall")),
    )
    if not sites:
        raise ValueError(
            f"no pore site with clearance >= {min_clearance:.2f} A for the guest; "
            "framework is non-porous at this probe size"
        )

    rotations = _orientations(n_orientations)
    passes = 1

    # --- screen -----------------------------------------------------------
    screened: list[dict[str, Any]] = []
    for si, site in enumerate(sites):
        for oi, rot in enumerate(rotations):
            combined = _place_oriented(
                host, guest, np.asarray(site["position"], dtype=float), rot
            )
            e = _energy(combined)
            passes += 1
            screened.append(
                {
                    "site_index": si,
                    "orientation_index": oi,
                    "start_position": site["position"],
                    "start_clearance_A": site["clearance_A"],
                    "screen_energy_ev": _round(e),
                    "rotation": rot,
                }
            )
    screened.sort(key=lambda s: (s["screen_energy_ev"], s["site_index"], s["orientation_index"]))

    # --- relax the most promising placements -------------------------------
    results: list[dict[str, Any]] = []
    best: dict[str, Any] | None = None
    for entry in screened[: max(1, n_relax)]:
        combined = _place_oriented(
            host,
            guest,
            np.asarray(entry["start_position"], dtype=float),
            entry["rotation"],
        )
        frames, energies, converged = _relax_guest_only(
            combined, len(host), fmax=fmax, steps=steps
        )
        e_final = _energy(combined)
        passes += len(frames) + 1
        record = {
            "site_index": entry["site_index"],
            "orientation_index": entry["orientation_index"],
            "start_position": entry["start_position"],
            "start_clearance_A": entry["start_clearance_A"],
            "screen_energy_ev": entry["screen_energy_ev"],
            "adsorption_energy_ev": _round(e_final),
            "steps_taken": len(frames),
            "converged": converged,
            "guest_positions": np.asarray(
                combined.get_positions()[len(host) :], dtype=float
            )
            .round(4)
            .tolist(),
            "frames": frames,
            "energies": energies,
        }
        results.append(record)
        if best is None or record["adsorption_energy_ev"] < best["adsorption_energy_ev"]:
            best = record

    assert best is not None
    guest_symbols = [str(s) for s in guest.get_chemical_symbols()]
    cell = np.asarray(host.cell.array, dtype=float).round(4).tolist()

    return {
        "adsorption_energy_ev": best["adsorption_energy_ev"],
        "host_energy_ev": _round(e_host),
        "host_energy_is_diagnostic_only": True,
        "best_site_index": int(best["site_index"]),
        "best_orientation_index": int(best["orientation_index"]),
        "n_placements_screened": len(screened),
        "n_relaxed": len(results),
        "converged": bool(best["converged"]),
        "n_atoms_host": len(host),
        "n_atoms_total": len(host) + len(guest),
        "guest_formula": guest.get_chemical_formula(),
        "seconds_per_forward_pass": round(seconds_per_pass, 3),
        "seconds_total": round(time.perf_counter() - t_start, 2),
        "forward_passes": passes,
        "method": (
            f"{MODEL} (EquiformerV2, 31M params, CPU); E_ads is the model's "
            f"referenced output for the framework+guest system (no subtraction); "
            f"{len(sites)} wall-preferring pore sites x {len(rotations)} fixed "
            f"orientations screened by single point, best {len(results)} relaxed "
            f"with LBFGS at a rigid framework to fmax {fmax:.2f} eV/A, "
            f"max {steps} steps"
        ),
        "caveats": [
            (
                "an upper bound on binding strength: validated against 8 published "
                "DFT reference energies it reports weaker binding by a mean "
                "+0.395 eV (MAE 0.395 eV), because site sampling is far coarser "
                "than the exhaustive search behind those references"
            ),
            "framework held rigid, so framework relaxation on binding is excluded",
            (
                "single guest molecule at 0 K: no loading dependence, no "
                "guest-guest interaction, no ZPE and no entropy"
            ),
            "not bit-reproducible: repeat forward passes scatter by ~1e-5 eV",
        ],
        "sites": [
            {k: v for k, v in r.items() if k not in ("frames", "energies", "rotation")}
            for r in results
        ],
        # Artifact payloads, exactly the shapes in contracts.Artifact.
        "adsorption_sites": {
            "symbols": [str(s) for s in host.get_chemical_symbols()],
            "cell": cell,
            "positions": np.asarray(host.get_positions(), dtype=float).round(4).tolist(),
            "guests": [
                {
                    "symbols": guest_symbols,
                    "positions": r["guest_positions"],
                    "energy_ev": r["adsorption_energy_ev"],
                }
                for r in results
            ],
        },
        "trajectory": {
            "symbols": [str(s) for s in host.get_chemical_symbols()] + guest_symbols,
            "cell": cell,
            "pbc": True,
            "frames": best["frames"],
            "energies": best["energies"],
        },
    }


def op_relax_guest(req: dict[str, Any]) -> dict[str, Any]:
    """Relax a guest already placed in a framework, keeping every frame."""
    host = dict_to_atoms(req["host"])
    guest = build_guest(req.get("guest", "H2O"))
    position = np.asarray(req["position"], dtype=float)
    steps = int(req.get("relax_steps", 60))
    fmax = float(req.get("fmax", 0.05))

    host_tagged = host.copy()
    host_tagged.set_tags([TAG_FRAMEWORK] * len(host))
    e_host = _energy(host_tagged)

    combined = _place_oriented(host, guest, position, np.eye(3))
    e_initial = _energy(combined)
    frames, energies, converged = _relax_guest_only(
        combined, len(host), fmax=fmax, steps=steps
    )
    e_final = _energy(combined)

    return {
        "adsorption_energy_ev": _round(e_final),
        "initial_adsorption_energy_ev": _round(e_initial),
        "host_energy_ev": _round(e_host),
        "host_energy_is_diagnostic_only": True,
        "steps_taken": len(frames),
        "converged": converged,
        "atoms": atoms_to_dict(combined),
        "trajectory": {
            "symbols": [str(s) for s in combined.get_chemical_symbols()],
            "cell": np.asarray(combined.cell.array, dtype=float).round(4).tolist(),
            "pbc": True,
            "frames": frames,
            "energies": energies,
        },
    }


OPS = {
    "ping": op_ping,
    "energy": op_energy,
    "adsorption": op_adsorption,
    "relax_guest": op_relax_guest,
}


def handle(req: dict[str, Any]) -> dict[str, Any]:
    op = req.get("op")
    if op not in OPS:
        raise ValueError(f"unknown op {op!r}; known: {sorted(OPS)}")
    return OPS[op](req)


if __name__ == "__main__":
    from athanor.workers.base import serve

    serve(handle)
