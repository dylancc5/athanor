# ATHANOR — demo video script

**~561 words · reads to about 224 seconds.**
**Canonical copy lives in Dylan's Notion page "temp script" — this file mirrors it.**

Read the **SAY** lines aloud. `//` marks a breath; a visual transition lands there.
The line to protect is "And here the prediction doesn't hold." — let it land dry.

---


## 1 · Open — the hook

**SCREEN:** Title card, then the dashboard mid-campaign.

**SAY:**
> The catalyst for materials innovation is here. ATHANOR is a research platform that takes a material you need, proposes how to get there, and tests it against real physics — thousands of times faster than a lab can. // Most AI-for-science tools generate plausible candidates. This one finds out which ones survive contact with reality.


## 2 · The problem

**SCREEN:** A DFT cost figure, then a stream of generated structures with nothing validating them.

**SAY:**
> Materials discovery has two problems. Simulating a single candidate properly costs hundreds of CPU-hours — a serious screen is a supercomputer allocation and a year of someone's PhD. And testing in the lab first wastes thousands of hours on null results. //

> Meanwhile generative models propose candidates faster than anyone can check them, with no idea when they're guessing. A model trained on stable crystals will answer confidently about a structure nothing like anything it has seen. So you get a pile of plausible candidates and no way to know which ones are real.


## 3 · What it does

**SCREEN:** Type the goal; the spec materialises with objectives and units.

**SAY:**
> You give ATHANOR the material you need in one sentence — find a solid-state lithium electrolyte with a low migration barrier that survives contact with lithium metal. // It turns that into a formal specification with real objectives and units, then runs a multi-round research campaign against it, autonomously.


## 4 · How it works

**SCREEN:** Hypothesis tree growing; agent names as lower-thirds; tech slide here.

**SAY:**
> Underneath are four Claude agents, deliberately set against each other. A strategist commits to a hypothesis and states up front what result would disprove it. A generator proposes candidates. A skeptic rejects the ones that are unsynthesisable, or outside what the physics models can be trusted on. An analyst holds the hypothesis to the standard set before any data arrived.

> And the physics is real. Migration barriers come from nudged elastic band calculations on MACE, a machine-learned potential trained on Materials Project data. Framework chemistry uses Meta's Open Catalyst models. // Every number on screen is computed by the same class of models frontier labs use for materials science — not guessed at by a language model.


## 5 · The demo

**SCREEN:** Candidates, vetoes, the NEB lithium hop (hold 5s), measurements table with flags, then the verdict.

**SAY:**
> Here's ATHANOR working. It proposes that in this family of materials, the more stable a compound is, the better lithium moves through it — which would be convenient, because it would collapse the search to a single axis.

> It generates candidates, the skeptic screens them, and it computes the real barriers. That animation is the actual calculated path of a lithium ion through the lattice — the thing that determines whether the material conducts at all. // Every measurement carries how far the model can be trusted, and a flag when it's extrapolating beyond its training data.

> And here the prediction doesn't hold. // The system says so, against the criterion it set before seeing any data, records what it learned, and carries it into the next round. That's the difference between a search engine and a method — it gets better at the problem instead of just returning more answers.


## 6 · The close

**SCREEN:** Proposal panel, compute ledger, then the campaign archetypes side by side.

**SAY:**
> Every campaign ends with something a lab can act on: a synthesis route, a validation protocol, the properties that make the material a fit — and a clear statement of what the models can't see, which is what makes the rest of it trustworthy.

> And the possibilities are wide open. The same loop designs frameworks that pull drinking water out of desert air, finds drug formulations that survive heat without refrigeration, and screens materials for clean energy. // ATHANOR is one interface over a whole stack of materials models — where your creativity is the limit on what you can ask for.


---

## Editing notes (mine, not read aloud)

- PIP: Dylan bottom-right ~22% width; drop to ~15% over the NEB animation and the verdict.
- Full-screen Dylan for the first 6s of §1 and the last 8s of §6 only.
- Hold the NEB lithium-hop at least 5s — the most convincing visual in the video.
- Tech slide under §4's second block.
- Captions burned in; judges may watch muted.
