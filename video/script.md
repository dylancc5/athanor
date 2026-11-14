# ATHANOR — demo video script

**Target runtime:** ~3:50. **Narration:** Dylan, one continuous take, picture-in-picture over the screen recording.

**How to use this:** read the **SAY** lines aloud, straight through, at a normal conversational pace (~150 words/min). Don't try to hit the timecodes — they're for my edit, not for you. The screen recording is cut *to your voice* afterwards, so a natural delivery beats a precise one. Pauses marked `//` are good places to breathe; I'll land a visual transition there.

Tone: you're a researcher showing a colleague something that works, not a founder pitching. Confident, specific, unhurried. The strongest moment in the whole video is you saying the system refuted its own hypothesis — don't rush that line or apologize for it.

---

## 1. Cold open — the hook (0:00–0:22)

**SCREEN:** ATHANOR title card, then straight into the hypothesis board with one card already flipping to REFUTED.

**SAY:**
> Here's a research platform proposing a scientific hypothesis, testing it against real physics, and then proving itself wrong. // That last part is the point. Most AI-for-science tools are built to generate plausible answers. This one is built to destroy its own.

---

## 2. The problem (0:22–1:00)

**SCREEN:** Simple visual — a DFT cost figure, then a stream of generated structures with no validation attached.

**SAY:**
> Computational materials discovery has two problems. // The first is cost. The standard method, density functional theory, runs hundreds of CPU-hours per candidate. A serious screen is a supercomputer allocation and a year of someone's PhD.
>
> The second problem is newer, and worse. Generative models now propose candidate materials faster than anyone can check them — and they have no idea when they're guessing. A model trained on stable crystals will answer confidently about a structure nothing like anything it has ever seen, and nothing in the output tells you that. // So you end up with a pile of plausible candidates and no way to know which ones are real.

---

## 3. What ATHANOR does (1:00–1:30)

**SCREEN:** Type the goal, watch the Spec materialize with objectives and units.

**SAY:**
> ATHANOR is built around a different instinct: a result you can't falsify isn't a result.
>
> You give it a research goal in one sentence. Here: find a solid-state lithium electrolyte with a low migration barrier that survives contact with lithium metal. // It turns that into a formal specification — real objectives, real units, real constraints — and then runs a multi-round research campaign against it.

---

## 4. How it works (1:30–2:05)

**SCREEN:** Hypothesis tree growing; cut to the four agent panels as each is named; then the lab notebook streaming prose.

**SAY:**
> Under the hood there are four reasoning agents, deliberately set against each other. Claude Opus writes a hypothesis with an explicit falsification criterion — the condition under which it would admit it was wrong. A generator proposes candidates. A skeptic vetoes the ones that are unsynthesizable or outside what the physics models can actually be trusted on. And an analyst judges the hypothesis against its own stated criterion.
>
> The physics is real. Migration barriers come from climbing-image nudged elastic band calculations on MACE, a machine-learned potential trained on Materials Project data. Framework adsorption uses Meta's Open Catalyst models. Molecular systems use semi-empirical quantum chemistry. // Nothing here is a language model guessing at a number.

---

## 5. The demo — the refutation (2:05–3:05)

**SCREEN:** The campaign running: candidates generated, skeptic vetoing, NEB animation of the lithium ion hopping through the lattice, measurements table filling with confidence and OOD flags, then the verdict flipping to REFUTED, then the heuristic being written back.

**SAY:**
> So watch what actually happens. // The system hypothesizes that in this family of materials, the more stable a compound is, the better lithium moves through it — which would be convenient, because it would collapse the search to a single axis.
>
> It generates candidates, the skeptic screens them, and then it computes the real barriers. This is a lithium ion migrating through the lattice — that animation is the actual calculated path. // Every number comes with a confidence, and a flag when the model is extrapolating beyond what it was trained on.
>
> And the hypothesis fails. // The correlation it predicted isn't there. The most stable candidate isn't the best conductor. The analyst marks it refuted, against the criterion it set for itself before seeing any data.
>
> Then it does the thing that makes this a research platform instead of a search engine: it writes down what it learned — don't screen this family on stability alone — and carries that into the next round. The refuted branch goes dark in the tree, and the campaign gets smarter.

---

## 6. The close — what it means (3:05–3:50)

**SCREEN:** The closing proposal panel: synthesis route, validation protocol, falsification criteria, caveats. End on the compute ledger, then the three campaign archetypes side by side.

**SAY:**
> Every campaign ends with something a lab can act on: a synthesis route, a validation protocol, the specific measurements that would prove it wrong — and an honest list of what these models cannot tell you. They reach a few hundred atoms over picoseconds. They say nothing about manufacturability or lifetime, and the proposal admits it.
>
> The same loop runs on completely different science without changing the code — water-harvesting frameworks, drug formulation stability — because the physics engine is swappable behind one interface. // What's generalizable isn't the chemistry. It's the loop: hypothesize, test, refute, learn.
>
> That's ATHANOR. It's open source, and everything you just saw ran on a laptop.

---

## Editing notes (mine, not read aloud)

- PIP: Dylan bottom-right, ~22% width, rounded, soft shadow; drop to ~15% during the NEB animation and the refutation beat so the screen carries it.
- Full-screen Dylan for the first 6 seconds of §1 and the last 8 seconds of §6 only.
- Title cards: ATHANOR cold open; one lower-third naming each agent as it's mentioned in §4; one tech slide (Claude Opus 5.5 · MACE · Meta FAIR Open Catalyst · GFN2-xTB · Materials Project · RDKit) held ~4s under §4.
- The REFUTED transition must land exactly on the word "fails" in §5. Cut everything else to fit that sync point.
- Hold the NEB lithium-hop animation at least 5 seconds — it's the most visually convincing thing in the video.
- No music under §5 narration, or light bed only; let the refutation land dry.
- Captions burned in throughout (judges may watch muted).
- Record a 3-second silent head and tail for breathing room.
