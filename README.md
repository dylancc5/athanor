# ATHANOR

**An autonomous AI scientist for materials discovery.**

**[Try the live demo →](https://athanor-dylancc5-7738.vercel.app/)** · replay mode, no sign-in, no backend required.

You describe the material you need in one sentence. ATHANOR turns it into a formal
specification, proposes falsifiable hypotheses, invents candidate structures, tests them
against real physics, and hands back a synthesis route a lab could run.

---

## The problem

Materials discovery is the bottleneck behind almost every hard technology problem — batteries
that don't degrade, carbon capture that pays for itself, fragile medicines that survive without
cooling, materials that make clean energy cheap.

And it moves at the speed of a very expensive guess.

Simulating a single candidate properly, with density functional theory, costs hundreds of
CPU-hours, where a serious screen is a supercomputer allocation and years of someone's PhD.
Testing in the lab first burns thousands of hours on null results.

Generative models were supposed to fix this. Instead they moved the bottleneck: they now
propose candidates faster than anyone can check them, and they have no idea when they're
guessing. A model trained on stable crystals will answer confidently about a structure nothing
like anything it has ever seen. You get a pile of plausible answers and no way to know which
ones are real.

## What ATHANOR does

It closes the loop. Not *generate candidates* — **run the research program.**

One sentence in, a testable experimental proposal out. In between, a complete campaign:
hypotheses with pre-registered falsification criteria, candidates invented and screened, real
physics computed, results judged against the standard set before the data arrived, and whatever
was learned carried into the next round.

A rigorous testing platform that closes the gap from need to highly feasible material in
minutes.

---

## How it works

**Four Claude agents, deliberately set against each other.**

| Agent | Job |
| --- | --- |
| **Strategist** | Commits to a hypothesis and states up front what result would disprove it |
| **Generator** | Invents candidates — database seeds plus targeted structural edits |
| **Skeptic** | Rejects what's unsynthesizable, or beyond what the physics models can be trusted on |
| **Analyst** | Holds the hypothesis to the criterion written before any data existed |
| **Controller** | Decides whether to continue, pivot, branch, or converge |

**The physics is real.** Migration barriers come from climbing-image nudged elastic band
calculations on **MACE**, a machine-learned interatomic potential trained on Materials Project
data. Framework chemistry runs on **Meta's Open Catalyst** models. Molecular systems use
**GFN2-xTB** semi-empirical quantum chemistry. Structures and convex-hull energies come from the
**Materials Project**.

## Why it generalizes

The physics engine sits behind a single `Scorer` interface, so swapping it is a config change
rather than a rewrite. The same loop runs on completely different science and has the potential
to accelerate the research and development cycle for things like:

- **Solid-state battery electrolytes** — lithium migration barriers, electrochemical stability
- **Water-harvesting frameworks** — pulling drinking water out of desert air
- **Drug formulation stability** — medicines that survive heat without refrigeration
- **Clean energy materials** — screening for the properties that decide cost

**And the stack underneath is self-improving.** The architecture is built to absorb what
frontier labs ship next: **Microsoft's MatterGen** to invent candidates outright rather than
perturb known ones, **DeepMind's GNoME** and its map of 2.2 million new crystals as a search
space, **Meta's universal atomic models** as a drop-in physics upgrade, **NVIDIA's ALCHEMI** to
run that physics roughly 100× faster.

ATHANOR is the method. The models are the substrate, and the substrate improves each time
frontier labs ship a new physical AI model.

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

### Layout

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

The backend appends typed events and the interface is a pure function of that log, so campaigns
replay deterministically and the frontend's types are generated from the backend's — they
cannot drift.

## License

MIT. The underlying models carry their own: MACE-MP-0 (MIT), Open Catalyst checkpoints,
tblite (LGPL), RDKit (BSD).
