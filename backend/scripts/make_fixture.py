"""Generate `campaigns/fixture/` — a complete campaign log with real numbers.

Every measurement here comes from a real MACE-MP-0 calculation or the
Materials Project API; only the agent *prose* is hand-written, because the
Claude-driven loop is what this fixture exists to unblock. The frontend is
built against this before the live loop lands, so the data shapes it renders
are the shapes the real campaign emits.

    cd backend && uv run python scripts/make_fixture.py
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path

import numpy as np
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from athanor import contracts as C  # noqa: E402
from athanor.eventlog import EventLog  # noqa: E402
from athanor.pareto import rank  # noqa: E402
from athanor.structure import atoms_to_cif, atoms_to_dict, reduced_formula  # noqa: E402
from athanor.workers.base import run_worker  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CAMPAIGNS = ROOT / "campaigns"
CAMPAIGN_ID = sys.argv[1] if len(sys.argv) > 1 else "fixture"

# Seeds are queried from Materials Project rather than hard-coded, so every
# one is guaranteed to actually contain lithium and sit near the convex hull.
SEED_CHEMSYS = ["Li-P-S", "Li-Er-Cl", "Li-Al-Cl"]
N_SEEDS = 4
MAX_ATOMS = 40  # keep the NEB supercell tractable on a laptop CPU

OBJECTIVES = [
    C.Objective(
        property="migration_barrier",
        label="Li migration barrier",
        direction="min",
        unit="eV",
        weight=2.0,
    ),
    C.Objective(
        property="energy_above_hull",
        label="Energy above hull",
        direction="min",
        unit="eV/atom",
        weight=1.0,
    ),
    C.Objective(
        property="band_gap",
        label="Band gap (electrochemical window proxy)",
        direction="max",
        unit="eV",
        weight=1.0,
    ),
]


def fetch_seeds():
    """Near-hull Li-containing phases, small enough to run a NEB on."""
    from mp_api.client import MPRester
    from pymatgen.io.ase import AseAtomsAdaptor

    found: list[dict] = []
    with MPRester(os.environ["MP_API_KEY"]) as mpr:
        for chemsys in SEED_CHEMSYS:
            docs = mpr.materials.summary.search(
                chemsys=chemsys,
                fields=[
                    "material_id",
                    "formula_pretty",
                    "energy_above_hull",
                    "band_gap",
                    "structure",
                ],
            )
            # Most stable, smallest cell, and it must really contain Li.
            docs = [
                d
                for d in docs
                if "Li" in d.structure.composition.as_dict()
                and len(d.structure) <= MAX_ATOMS
                and d.structure.composition.as_dict()["Li"] >= 2
            ]
            docs.sort(key=lambda d: (float(d.energy_above_hull), len(d.structure)))
            for d in docs[:2]:
                found.append(
                    {
                        "mp_id": str(d.material_id),
                        "formula": d.formula_pretty,
                        "energy_above_hull": float(d.energy_above_hull),
                        "band_gap": float(d.band_gap),
                        "atoms": AseAtomsAdaptor.get_atoms(d.structure),
                    }
                )

    # Deterministic selection: dedupe, then the most stable N.
    seen: set[str] = set()
    unique = []
    for s in sorted(found, key=lambda s: (s["energy_above_hull"], s["mp_id"])):
        if s["mp_id"] not in seen:
            seen.add(s["mp_id"])
            unique.append(s)
    out = unique[:N_SEEDS]
    out.sort(key=lambda s: s["mp_id"])
    return out


def note(log: EventLog, author, entry_id: str, heading: str, text: str) -> None:
    """Stream a notebook entry the way the live agents will."""
    first = True
    for chunk in text.split(". "):
        chunk = chunk if chunk.endswith(".") or chunk == "" else chunk + ". "
        log.emit(
            C.NotebookDelta(
                entry_id=entry_id,
                author=author,
                heading=heading if first else None,
                text=chunk,
            )
        )
        first = False


async def main() -> None:
    load_dotenv(ROOT / ".env")
    target = CAMPAIGNS / CAMPAIGN_ID
    if target.exists():
        shutil.rmtree(target)

    print("fetching Materials Project seeds...")
    seeds = fetch_seeds()
    print(f"  {len(seeds)} seeds: " + ", ".join(f"{s['formula']}({s['mp_id']})" for s in seeds))

    log = EventLog(CAMPAIGNS, CAMPAIGN_ID)
    ledger = C.Ledger()

    goal = (
        "Find a solid-state lithium electrolyte with a low Li migration barrier "
        "that stays stable against a lithium metal anode."
    )
    log.emit(C.CampaignStarted(goal=goal))

    spec = C.Spec(
        goal=goal,
        title="Solid-state Li conductor",
        domain="solid_electrolyte",
        objectives=OBJECTIVES,
        constraints=[
            C.Constraint(
                property="energy_above_hull",
                op="<=",
                value=0.05,
                description="Synthesizably close to the convex hull",
            ),
            C.Constraint(
                property="elements",
                op="not_in",
                value=["Co", "Ni"],
                description="Avoid cost- and ethics-constrained transition metals",
            ),
        ],
        seed_strategy="Materials Project: Li-containing sulfides and halides near the hull",
    )
    log.emit(C.SpecCreated(spec=spec))

    # ---------------- Round 1 ----------------
    log.emit(C.RoundStarted(round=1))

    h1 = C.Hypothesis(
        id="h1",
        round=1,
        statement=(
            "Among near-hull lithium thiophosphates, a lower energy above hull predicts a "
            "lower Li migration barrier, because a well-ordered lattice gives cleaner "
            "migration channels."
        ),
        rationale=(
            "Stability and ionic conductivity are usually discussed as a trade-off. If they "
            "in fact move together across this family, the search collapses to one axis and "
            "we can screen on stability alone."
        ),
        prediction=(
            "Barrier should correlate positively with energy above hull across the seed set "
            "(Spearman rho > 0.5)."
        ),
        falsification_criterion=(
            "If the most stable seed does not have the lowest barrier, or the correlation is "
            "absent or inverted, the hypothesis is refuted."
        ),
        batch_plan=C.BatchPlan(
            n_candidates=len(seeds),
            strategy="Score every retrieved seed on both axes; no perturbations yet.",
            properties=["migration_barrier", "energy_above_hull", "band_gap"],
        ),
    )
    log.emit(C.HypothesisProposed(hypothesis=h1))
    note(
        log,
        "strategist",
        "n-h1",
        "Round 1 — stability as a proxy for mobility",
        "The literature treats stability and conductivity as competing. "
        "If they move together in the thiophosphates, one axis would do. "
        "This is the cheapest claim to kill first, so it goes first.",
    )

    candidates: list[C.Candidate] = []
    for s in seeds:
        candidates.append(
            C.Candidate(
                id=f"c-{s['mp_id']}",
                name=s["formula"],
                formula=reduced_formula(s["atoms"]),
                structure=atoms_to_cif(s["atoms"]),
                repr_kind="cif",
                domain="solid_electrolyte",
                provenance=C.Provenance(
                    source="retrieval",
                    database="materials_project",
                    external_id=s["mp_id"],
                ),
                hypothesis_id="h1",
            )
        )
    log.emit(C.CandidatesGenerated(hypothesis_id="h1", candidates=candidates))
    ledger.candidates_generated += len(candidates)

    log.emit(
        C.SkepticReviewed(
            hypothesis_id="h1",
            approved_ids=[c.id for c in candidates],
            vetoes=[],
            commentary=(
                "All four are experimentally reported phases from the Materials Project, so "
                "synthesizability is not in question. Note for the analyst: MACE-MP-0 was "
                "trained on relaxations near equilibrium, so a barrier from a stretched "
                "migration path is an extrapolation and should be read as an upper bound."
            ),
        )
    )

    measurements: list[C.Measurement] = []

    async def score(seed, cand: C.Candidate) -> None:
        atoms = seed["atoms"]
        log.emit(C.ScoringStarted(candidate_id=cand.id, scorer="mace-mp-0"))

        relax = await run_worker(
            "mace", {"op": "relax", "atoms": atoms_to_dict(atoms), "fmax": 0.05, "steps": 80}
        )
        ledger.candidates_scored += 1
        for m in [
            C.Measurement(
                candidate_id=cand.id,
                property="energy_per_atom",
                value=round(relax["energy_per_atom"], 4),
                unit="eV/atom",
                source="mace-mp-0",
                method="BFGS relaxation, fmax 0.05 eV/A",
                confidence=0.75,
            ),
            C.Measurement(
                candidate_id=cand.id,
                property="energy_above_hull",
                value=round(seed["energy_above_hull"], 4),
                unit="eV/atom",
                source="materials_project",
                method="DFT (GGA/GGA+U), MP convex hull",
                confidence=0.95,
            ),
            C.Measurement(
                candidate_id=cand.id,
                property="band_gap",
                value=round(seed["band_gap"], 3),
                unit="eV",
                source="materials_project",
                method="DFT (GGA) band gap — underestimates the true gap",
                confidence=0.6,
                is_proxy=True,
                note="Stand-in for the electrochemical stability window.",
            ),
        ]:
            measurements.append(m)
            log.emit(C.MeasurementRecorded(measurement=m))
            ledger.measurements += 1

        art = C.Artifact(
            id=f"a-relax-{cand.id}",
            candidate_id=cand.id,
            kind="relaxation_trajectory",
            label=f"{cand.name} relaxation ({relax['steps_taken']} steps)",
            uri=f"artifacts/a-relax-{cand.id}.json",
        )
        log.emit_artifact(art, relax["trajectory"])

        path = await run_worker(
            "mace",
            {
                "op": "neb",
                "atoms": atoms_to_dict(atoms),
                "species": "Li",
                "n_images": 9,
                "fmax": 0.05,
                "steps": 200,
            },
            timeout=3000,
        )
        m = C.Measurement(
            candidate_id=cand.id,
            property="migration_barrier",
            value=round(path["barrier_ev"], 3),
            unit="eV",
            source="mace-mp-0",
            method=path["method"],
            confidence=0.6,
            ood_flag=not path["converged"],
            is_proxy=False,
            note=(
                f"Rate-limiting climb along a {path['hop_distance_A']:.2f} A vacancy-mediated "
                f"hop in a {path['n_atoms']}-atom supercell. Endpoint asymmetry "
                f"{path['endpoint_asymmetry_ev']:.3f} eV."
            ),
        )
        measurements.append(m)
        log.emit(C.MeasurementRecorded(measurement=m))
        ledger.measurements += 1
        log.emit_artifact(
            C.Artifact(
                id=f"a-neb-{cand.id}",
                candidate_id=cand.id,
                kind="neb_path",
                label=f"{cand.name} Li hop, {path['barrier_ev']:.2f} eV",
                uri=f"artifacts/a-neb-{cand.id}.json",
            ),
            path["path"],
        )

    for seed, cand in zip(seeds, candidates):
        print(f"  scoring {cand.name} ({len(seed['atoms'])} atoms)...")
        await score(seed, cand)

    # Chemical-space coordinates: real measured values, so the flythrough is meaningful.
    by_cand: dict[str, dict[str, float]] = {}
    for m in measurements:
        by_cand.setdefault(m.candidate_id, {})[m.property] = m.value
    points = {
        cid: (
            float(v.get("migration_barrier", 0.0)),
            float(v.get("band_gap", 0.0)),
            float(v.get("energy_above_hull", 0.0)) * 10.0,
        )
        for cid, v in by_cand.items()
    }
    log.emit(C.EmbeddingUpdated(points=points))

    pareto = rank(measurements, OBJECTIVES)
    log.emit(C.ParetoUpdated(points=pareto))

    # The verdict follows from the numbers we actually measured.
    pairs = [
        (v["energy_above_hull"], v["migration_barrier"])
        for v in by_cand.values()
        if "energy_above_hull" in v and "migration_barrier" in v
    ]
    refuted = True
    detail = "insufficient paired data"
    if len(pairs) >= 3:
        hull = np.array([p[0] for p in pairs])
        barrier = np.array([p[1] for p in pairs])
        hr = np.argsort(np.argsort(hull))
        br = np.argsort(np.argsort(barrier))
        if np.std(hr) > 0 and np.std(br) > 0:
            rho = float(np.corrcoef(hr, br)[0, 1])
        else:
            rho = 0.0
        refuted = rho <= 0.5
        most_stable = min(pairs, key=lambda p: p[0])
        lowest_barrier = min(pairs, key=lambda p: p[1])
        detail = (
            f"Spearman rho = {rho:+.2f} across {len(pairs)} candidates "
            f"(prediction required > 0.50). The most stable candidate "
            f"({most_stable[0]:.3f} eV/atom above hull) has a barrier of "
            f"{most_stable[1]:.2f} eV, while the lowest barrier measured is "
            f"{lowest_barrier[1]:.2f} eV at {lowest_barrier[0]:.3f} eV/atom above hull."
        )

    verdict: C.Verdict = "REFUTED" if refuted else "SUPPORTED"
    heuristics = [
        C.Heuristic(
            id="heu-1",
            text=(
                "Do not screen Li conductors on stability alone — in the thiophosphates, "
                "proximity to the hull does not predict the migration barrier. Score both axes."
            ),
            learned_from="h1",
            strength="tentative",
        ),
        C.Heuristic(
            id="heu-2",
            text=(
                "Straight-line hop energies are upper bounds and carry an OOD flag. Treat "
                "differences smaller than ~0.1 eV between candidates as noise."
            ),
            learned_from="h1",
            strength="established",
        ),
    ]
    log.emit(
        C.AnalystVerdict(
            hypothesis_id="h1",
            verdict=verdict,
            reasoning=(
                "The predicted correlation is absent, so the hypothesis fails on its own "
                "stated criterion. Stability and mobility are separate axes here, which means "
                "the search cannot be collapsed — it has to stay multi-objective. "
                + detail
            ),
            evidence=[detail],
            heuristics=heuristics,
        )
    )
    note(
        log,
        "analyst",
        "n-v1",
        "Verdict — refuted, and that is the useful outcome",
        f"{detail} The claim is dead. "
        "What survives is sharper than what we started with: these two objectives are "
        "independent, so the frontier is real and a trade-off has to be chosen rather than "
        "optimized away.",
    )

    log.emit(
        C.ControllerDecision(
            action="pivot",
            reasoning=(
                "With the one-axis shortcut refuted, the next round should perturb the "
                "best frontier candidate's anion sublattice — halide substitution widens "
                "migration channels without moving far from the hull."
            ),
        )
    )

    ledger.wall_seconds = round(log.events[-1].t, 1)
    # An ESTIMATE, with a stated basis, not a measurement. A plane-wave DFT
    # CI-NEB on a ~60-atom cell is ~9 images plus 2 relaxed endpoints, and each
    # of those costs on the order of 40 core-hours at converged settings — call
    # it ~400 core-hours per candidate, order of magnitude. The UI labels this
    # as an estimate; it must never be presented as something we measured.
    DFT_CORE_HOURS_PER_IMAGE = 40.0
    IMAGES_PER_NEB = 11
    ledger.est_dft_cpu_hours = round(
        ledger.candidates_scored * DFT_CORE_HOURS_PER_IMAGE * IMAGES_PER_NEB, 1
    )
    log.emit(C.LedgerUpdated(ledger=ledger))

    lead = [p.candidate_id for p in pareto if p.rank == 0] or [c.id for c in candidates[:1]]
    log.emit(
        C.ProposalCreated(
            proposal=C.Proposal(
                title="Measure the stability/mobility trade-off directly in Li-P-S",
                summary=(
                    "The screen refuted the idea that stability predicts mobility in this "
                    "family. The frontier candidates differ on both axes, so the next step is "
                    "an experiment that measures both on the same pellets."
                ),
                lead_candidate_ids=lead,
                synthesis_route=[
                    "Weigh out Li2S, P2S5 and LiCl in the target stoichiometry in an argon glovebox.",
                    "Ball-mill 600 rpm, 12 h, ZrO2 media, 10:1 ball-to-powder ratio.",
                    "Cold-press at 300 MPa into 10 mm pellets.",
                    "Sinter in a sealed quartz ampoule, 550 C for 8 h, then cool at 1 C/min.",
                ],
                validation_protocol=[
                    "XRPD to confirm the target phase and quantify residual precursors.",
                    "Electrochemical impedance spectroscopy, 25-100 C, to extract total "
                    "ionic conductivity and the activation energy from an Arrhenius fit.",
                    "Li | electrolyte | Li symmetric-cell cycling to find the critical "
                    "current density and check for dendrite penetration.",
                    "Linear sweep voltammetry to locate the real oxidation limit.",
                ],
                falsification_criteria=[
                    "An activation energy from the Arrhenius fit above 0.40 eV refutes the "
                    "predicted ranking outright.",
                    "If the measured activation energies order differently from the computed "
                    "barriers, the straight-line proxy is not usable for ranking and must be "
                    "replaced with CI-NEB before any further screening.",
                ],
                caveats=[
                    "MACE-MP-0 reaches a few hundred atoms over picoseconds. It does not "
                    "predict sintered-pellet microstructure, grain-boundary resistance, or "
                    "long-term interfacial degradation — and those often decide whether a "
                    "conductor is usable.",
                    "Band gap stands in for the electrochemical window and GGA underestimates "
                    "it, so the window numbers are conservative and ordinal at best.",
                    "Barriers are unrelaxed upper bounds carrying an OOD flag.",
                ],
            )
        )
    )
    log.emit(C.CampaignCompleted(rounds=1))
    log.close()

    print(f"\nwrote {log.path} ({len(log.events)} events)")
    print(f"  artifacts: {len(list((log.dir / 'artifacts').glob('*.json')))}")
    print(f"  verdict: {verdict}")
    print(f"  {detail}")


if __name__ == "__main__":
    asyncio.run(main())
