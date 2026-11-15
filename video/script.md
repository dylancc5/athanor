# ATHANOR — demo video script

**~483 words · reads to about 3:00 at a normal conversational pace.**
**Canonical copy lives in Dylan's Notion page "temp script" — this file mirrors it.**

Read the **SAY** lines aloud, straight through. Don't chase the timecodes — the screen
recording is cut to your voice afterwards, so natural delivery beats precision. `//`
marks a good place to breathe; a visual transition lands there.

Tone: a researcher showing a colleague something that works, not a founder pitching.
The strongest moment is you saying it proved itself wrong — don't rush that line.

---


## 1 · Open — the hook

**SCREEN:** Title card, then the hypothesis board with a card flipping to REFUTED.

**SAY:**
> This is a research platform that proposes a scientific hypothesis, tests it against real physics, and then tries to prove itself wrong. // That last part is the point. Most AI-for-science tools are built to generate plausible answers. This one is built to attack its own.


## 2 · The problem

**SCREEN:** A DFT cost figure, then a stream of generated structures with nothing validating them.

**SAY:**
> Materials discovery has two problems. Simulating a single candidate properly costs hundreds of CPU-hours — a serious screen is a supercomputer allocation and a year of someone's PhD. //

> And generative models now propose candidates faster than anyone can check them, with no idea when they're guessing. A model trained on stable crystals will answer confidently about a structure nothing like anything it has seen. // So you get a pile of plausible candidates and no way to know which ones are real.


## 3 · What it does

**SCREEN:** Type the goal; the spec materialises with objectives and units.

**SAY:**
> ATHANOR is built on a different instinct: a result you can't falsify isn't a result.

> You give it a goal in one sentence — find a solid-state lithium electrolyte with a low migration barrier that survives contact with lithium metal. // It turns that into a formal specification, then runs a multi-round research campaign against it.


## 4 · How it works

**SCREEN:** Hypothesis tree growing; agent names as lower-thirds; lab notebook streaming. Tech slide here.

**SAY:**
> Underneath are four Claude agents, deliberately set against each other. A strategist writes a hypothesis with an explicit falsification criterion — the condition under which it would admit it was wrong. A generator proposes candidates. A skeptic vetoes the ones that are unsynthesisable, or outside what the physics models can actually be trusted on. An analyst judges the hypothesis against its own criterion.

> And the physics is real. Migration barriers come from nudged elastic band calculations on MACE, a machine-learned potential trained on Materials Project data. Framework chemistry uses Meta's Open Catalyst models. // Nothing here is a language model guessing at a number.


## 5 · The demo — the refutation

**SCREEN:** Candidates, vetoes, the NEB lithium hop (hold 5s), measurements table with OOD and PROXY flags, then REFUTED, then the heuristic written back.

**SAY:**
> So watch what it does. // It hypothesises that in this family of materials, the more stable a compound is, the better lithium moves through it — which would be convenient, because it would collapse the search to a single axis.

> It generates candidates, the skeptic screens them, and it computes the real barriers. That animation is the actual calculated path of a lithium ion through the lattice. // Every number carries a confidence, and a flag when the model is extrapolating beyond its training data.

> And the hypothesis fails. // The correlation it predicted isn't there. It marks it refuted — against the criterion it set for itself before seeing any data — writes down what it learned, and carries that into the next round.


## 6 · The close

**SCREEN:** Proposal panel, compute ledger, then the three campaign archetypes side by side.

**SAY:**
> Every campaign ends with something a lab can act on: a synthesis route, a validation protocol, and an honest list of what these models cannot tell you. // The same loop runs on water-harvesting frameworks and drug stability without changing a line of code, because the physics engine is swappable behind one interface.

> What generalises isn't the chemistry. It's the loop. Hypothesise, test, refute, learn. // That's ATHANOR — and everything you just saw ran on a laptop.


---

## Editing notes (mine, not read aloud)

- PIP: Dylan bottom-right, ~22% width; drop to ~15% during the NEB animation and the
  refutation so the screen carries them.
- Full-screen Dylan for the first 6s of §1 and the last 8s of §6 only.
- The REFUTED transition must land on the word "fails" in §5. Cut everything else to that.
- Hold the NEB lithium-hop at least 5s — the most visually convincing thing in the video.
- No music under §5 narration; let the refutation land dry.
- Captions burned in (judges may watch muted).
