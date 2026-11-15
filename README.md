# ATHANOR

**An autonomous AI scientist for materials discovery.**

**[Try the live demo →](https://athanor-dylancc5-7738.vercel.app/)** · replay mode, no sign-in, no backend required.

You describe the material you need in one sentence. ATHANOR turns it into a formal
specification, proposes falsifiable hypotheses, invents candidate structures, tests them
against real physics, and hands back a synthesis route a lab could run on Monday.

---

## The problem

Materials discovery is the bottleneck behind almost every hard technology problem — batteries
that don't degrade, carbon capture that pays for itself, medicines that survive without a cold
chain, materials that make clean energy cheap.

And it moves at the speed of a very expensive guess.

Simulating a single candidate properly, with density functional theory, costs hundreds of
CPU-hours. A serious screen is a supercomputer allocation and a year of someone's PhD. Testing
in the lab first burns thousands of hours on null results.

Generative models were supposed to fix this. Instead they moved the bottleneck: they now
propose candidates faster than anyone can check them, and they have no idea when they're
guessing. A model trained on stable crystals will answer confidently about a structure nothing
like anything it has ever seen. You get a pile of plausible answers and no way to know which
ones are real.

## What ATHANOR does

It closes the loop. Not *generate candidates* — **run the research program.**

One sentence in. A testable experimental proposal out. In between, a complete campaign:
hypotheses with pre-registered falsification criteria, candidates invented and screened, real
physics computed, results judged against the standard set before the data arrived, and
whatever was learned carried into the next round.

A screen that takes a supercomputer allocation runs on a laptop in minutes.

---

## How it works

**Four Claude agents, deliberately set against each other.**

| Agent | Job |
|---|---|
| **Strategist** | Commits to a hypothesis and states up front what result would disprove it |
| **Generator** | Invents candidates — database seeds plus targeted structural edits |
| **Skeptic** | Rejects what's unsynthesizable, or beyond what the physics models can be trusted on |
| **Analyst** | Holds the hypothesis to the criterion written before any data existed |
| **Controller** | Decides whether to continue, pivot, branch, or converge |

**The physics is real.** Migration barriers come from climbing-image nudged elastic band
calculations on **MACE**, a machine-learned interatomic potential trained on Materials Project
data. Framework chemistry runs on **Meta's Open Catalyst** models. Molecular systems use
**GFN2-xTB** semi-empirical quantum chemistry. Structures and convex-hull energies come from the
**Materials Project**. Nothing on screen is a language model guessing at a number.

**Everything is an event log.** The backend appends typed events; the interface is a pure
function of that log. Campaigns replay deterministically, you can scrub to any moment in a
research program's history, and the frontend's types are generated from the backend's — so they
cannot drift.

```
backend/athanor/
  contracts.py     frozen types: Candidate, Objective, Spec, Measurement, Hypothesis, Event
  agents/          Strategist · Generator · Skeptic · Analyst · Controller
  loop/            campaign orchestration
  scorers/         physics engines behind one Scorer interface
  workers/         out-of-process compute, one isolated environment each
web/
  components/three/   crystals, migration paths, pore surfaces, hypothesis trees
  lib/campaign-state  the reducer the entire UI is derived from
```

## Why it generalizes

The physics engine sits behind a single `Scorer` interface, so swapping it is a config change
rather than a rewrite. The same loop runs on completely different science:

- **Solid-state battery electrolytes** — lithium migration barriers, electrochemical stability
- **Water-harvesting frameworks** — pulling drinking water out of desert air
- **Drug formulation stability** — medicines that survive heat without refrigeration
- **Clean energy materials** — screening for the properties that decide cost

**And the stack underneath keeps getting better.** The architecture is built to absorb what
frontier labs ship next: **Microsoft's MatterGen** to invent candidates outright rather than
perturb known ones, **DeepMind's GNoME** and its map of 2.2 million new crystals as a search
space, **Meta's universal atomic models** as a drop-in physics upgrade, **NVIDIA's ALCHEMI** to
run that physics roughly 100× faster.

ATHANOR is the method. The models are the substrate — and the substrate improves monthly.

---

## Built to be checked

What makes a screen useful isn't how confident it sounds. It's whether you can tell which
numbers to trust.

Every measurement carries its method, a confidence, and a flag when the model is extrapolating
beyond its training data. Proxies say what they stand in for. When a calculation fails, the
candidate is recorded as failed — the system never substitutes a plausible number. Every
campaign states its own capability boundary: these models reach a few hundred atoms over
picoseconds, and say nothing about manufacturability or device lifetime.

That discipline is load-bearing. The hero measurement — the lithium migration barrier — took
three implementations to get right. A straight-line interpolation gives ~14 eV, because the
path drives the ion through a neighbouring atom. Relaxing the endpoints without constraint
gives 0.003 eV, because the ion drifts off its site and the saddle point disappears. The
version that survives expands to a supercell, creates the vacancy that mediates real migration,
pins the hopping ion, runs climbing-image NEB, and scores the barrier as the maximum uphill
climb — because migration passes through a metastable interstitial that the naive metric hides.

**Validated against published values: Li₃PS₄ = 0.28 eV** (literature 0.2–0.5 eV).

Two of those three implementations looked entirely reasonable and were wrong by orders of
magnitude. That is precisely the failure mode the Skeptic and the extrapolation flags exist to
catch.

---

## Running it

Requires [uv](https://docs.astral.sh/uv/), Node 20+, and an Anthropic API key.

```bash
git clone https://github.com/dylancc5/athanor && cd athanor
cp .env.example .env          # add ANTHROPIC_API_KEY and a free MP_API_KEY

cd backend && uv sync && make envs    # one isolated env per physics engine
uv run uvicorn athanor.api:app --port 8000

cd ../web && npm install && npm run dev
```

Replaying a recorded campaign needs no API key and no model weights. Live campaigns spend real
money and real compute, so they're off by default:

```bash
ATHANOR_LIVE=1 uv run uvicorn athanor.api:app --port 8000
```

Compute runs out-of-process, one environment per scorer — torch and tblite each link their own
OpenMP runtime and abort when imported together — which has the side benefit that every
calculation is independently reproducible.

## License

MIT. The underlying models carry their own: MACE-MP-0 (MIT), Open Catalyst checkpoints,
tblite (LGPL), RDKit (BSD).
