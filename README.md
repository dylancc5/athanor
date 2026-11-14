# ATHANOR

**An agentic platform that runs multi-round scientific research campaigns — and tries to refute its own hypotheses.**

**[Try the live demo →](https://athanor-dylancc5-7738.vercel.app/)** · replay mode, no sign-in, no backend required.

You give it a research goal in a sentence. It writes a falsifiable hypothesis, generates candidate materials, tests them against physics-based atomistic models, and then does the thing that actually makes research work: it tries to kill its own idea. When a hypothesis is refuted, the refutation is written into a lab notebook as a reusable heuristic, and the next round is smarter for it. The campaign ends with a synthesis route and a validation protocol a real lab could run on Monday.

Most "AI for science" demos generate plausible-looking molecules. ATHANOR is built around the opposite instinct: **a result you can't falsify isn't a result.**

---

## The problem

Computational materials screening has a throughput problem and a credibility problem.

The throughput problem: density functional theory, the workhorse of first-principles materials simulation, costs hundreds of CPU-hours per candidate. A serious screen is a supercomputer allocation and a PhD student's year.

The credibility problem is worse, and newer. Generative models now propose candidate structures far faster than anyone can check them, and they have no idea when they're extrapolating. A model trained on near-equilibrium crystal relaxations will answer confidently about a geometry nothing like its training data, and nothing in the output says so. The result is a pile of plausible candidates with no attached notion of which ones are believable.

## How ATHANOR addresses it

**Machine-learned interatomic potentials instead of DFT.** MACE-MP-0 reproduces DFT forces at a fraction of the cost. A migration-barrier calculation that would be hundreds of CPU-hours runs in minutes on a laptop.

**An adversarial agent loop instead of a generation pipeline.** Four reasoning agents with different jobs, deliberately in tension:

| Agent | Job |
|---|---|
| **Strategist** | Writes a hypothesis with a prediction and an explicit falsification criterion |
| **Generator** | Proposes candidates — retrieval seeds plus targeted perturbations |
| **Skeptic** | Vetoes candidates that are out-of-distribution, implausible, or unsynthesizable |
| **Analyst** | Judges the hypothesis against *its own stated criterion* and writes back what was learned |
| **Controller** | Decides whether to continue, pivot, branch, or converge |

The Analyst is empowered to return **REFUTED**, and in the recorded campaigns it does. That is the product working, not failing.

**Honesty as a first-class data type.** Every measurement carries `confidence`, an `ood_flag`, an `is_proxy` marker, and the method that produced it. Proxies say what they're standing in for. When a calculation fails, the candidate is recorded as failed — the system never substitutes a plausible number. The interface surfaces all of this rather than hiding it.

**A stated capability boundary.** These models reach roughly a few hundred atoms over a few picoseconds. They do *not* give bulk mechanical properties, long-timescale kinetics, device-level performance, or manufacturability. Every closing proposal says so in its own caveats section.

---

## Core technologies

- **Claude Opus 5.5** — Strategist, Skeptic, Analyst, Controller. **Claude Haiku 5.5** — goal parsing.
- **MACE-MP-0** — machine-learned interatomic potential covering 89 elements, trained on Materials Project relaxations.
- **Meta FAIR Open Catalyst (ODAC23)** — adsorption energetics in metal-organic frameworks.
- **GFN2-xTB** — semi-empirical quantum chemistry for molecular and molecular-crystal systems.
- **Materials Project** — experimentally-grounded structures, convex-hull energies, band gaps.
- **RDKit** — cheminformatics descriptors and synthetic accessibility.
- **ASE** — atomistic simulation environment; relaxations and climbing-image NEB.
- **Next.js + React Three Fiber** — the full 3D rendering substrate.
- **FastAPI** — event-streaming backend.

## How it's built

The whole system is **a single append-only event log**. The backend appends typed events; the interface is a pure function of that log. Three consequences that matter:

1. **Deterministic replay.** Any campaign replays exactly, which is why the public demo needs no backend and no API spend.
2. **Free time travel.** Because state is derived, the timeline scrubber is nearly free — drag through the history of a research program.
3. **One source of truth.** The frontend's TypeScript types are generated from the backend's Pydantic models, so they cannot drift.

Compute runs **out-of-process**, one isolated environment per scorer. This isn't fastidiousness: torch (MACE, fairchem) and tblite each link their own copy of libomp and abort the process when imported together, and fairchem needs its own Python and torch pin. Each scorer therefore runs behind a JSON-over-stdio worker, which also makes every calculation independently reproducible.

```
backend/athanor/
  contracts.py        frozen types: Candidate, Objective, Spec, Measurement, Hypothesis, Event
  eventlog.py         append-only JSONL log + live fan-out + deterministic replay
  pareto.py           multi-objective non-dominated sorting
  workers/            out-of-process scorers (mace, xtb, odac), one uv env each
  scorers/            Scorer implementations + registry
  agents/             Claude-backed Strategist / Skeptic / Analyst / Controller
  loop/               campaign orchestration
web/
  lib/contracts.ts    GENERATED from contracts.py — do not edit
  components/three/   structural + abstract 3D visualization
  components/panels/  hypothesis board, Pareto, lab notebook, proposal
campaigns/            recorded golden campaigns (event logs + artifacts)
```

### A note on the physics

The hero measurement is the lithium migration barrier, and getting it right took three attempts — which is instructive about this whole category of tool.

A straight-line interpolation between adjacent lithium sites gives barriers around **14 eV**: nonsense, because the path drives the ion through a neighbouring atom. Relaxing the endpoints without constraint gives **0.003 eV**: also nonsense, because the ion drifts off its site during relaxation and the saddle point disappears.

The implementation that survives: expand to a supercell so the ion can't see its own periodic image, remove one lithium to create the vacancy that mediates real migration, **pin the hopping ion** during endpoint relaxation, run climbing-image NEB, and score the barrier as the **maximum uphill climb** along the profile rather than peak-minus-endpoint — because migration in these materials passes through a metastable interstitial that the naive metric hides.

Validated against published values: **Li₃PS₄ = 0.28 eV** (literature 0.2–0.5 eV). The
recorded hero campaign in `campaigns/li-conductor/` reproduces it at 0.282 eV, alongside
0.138, 0.170 and 0.587 eV for three other lithium conductors.

Three plausible-looking implementations, two of them silently wrong by orders of magnitude. This is exactly the failure mode the Skeptic and the `ood_flag` exist to catch.

---

## Running it

Requires [uv](https://docs.astral.sh/uv/), Node 20+, and an Anthropic API key. First run downloads model weights (a few GB).

```bash
git clone <this repo> && cd athanor
cp .env.example .env     # add ANTHROPIC_API_KEY and a free MP_API_KEY

# backend: server env + one isolated env per scorer
cd backend && uv sync
make envs                # builds one isolated env per scorer; see backend/Makefile

# replay a recorded campaign — no API key, no model weights needed
uv run uvicorn athanor.api:app --port 8000

# interface
cd ../web && npm install && npm run dev
```

A live campaign spends real money on Claude and needs the model weights, so it's off by default:

```bash
ATHANOR_LIVE=1 uv run uvicorn athanor.api:app --port 8000
```

The public demo runs in replay mode only. If you type a goal there, it will politely decline to spend the author's API budget.

## License

MIT. The underlying models carry their own licenses — MACE-MP-0 (MIT), the Open Catalyst checkpoints, tblite (LGPL), and RDKit (BSD).
