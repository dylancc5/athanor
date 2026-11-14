# ATHANOR — Autonomous Research Campaign Platform

**One line:** An agentic platform that runs multi-round scientific research campaigns —
proposes falsifiable hypotheses, tests them against physics-based models, refutes its own
ideas, learns across rounds, and ends with a testable experimental proposal.

**Posture:** sell the vision. Breadth of domain coverage + the self-refuting loop are the pitch.
Scientific honesty is a *feature* and is surfaced in the UI (confidence, OOD flags, proxy labels).

Repo: https://github.com/dylancc5/athanor · Architecture notes: `.claude/project-context.md`

---

## Capability boundary (stated in every closing proposal)
Reaches: anything decided by a few hundred atoms over a few picoseconds.
Does NOT reach: bulk mechanical properties, long-timescale kinetics, device-level
performance, cost/manufacturability — those come from retrieval + heuristics.

---

## Phase 0 — Foundations ✅ DONE
- [x] `Candidate` / `Objective` / `Spec` / `Measurement` / `Hypothesis` / `Artifact` / `Proposal` / `Ledger`
- [x] `Scorer` and `Generator` protocols
- [x] Typed event union + append-only JSONL campaign log
- [x] **Replay mode** — deterministic replay verified (same log → identical state, twice)
- [x] Multi-objective Pareto ranking (non-dominated sort, verified)
- [x] Out-of-process worker harness — forced by `OMP: Error #15` between torch and tblite
- [x] Isolated uv env per scorer (`backend/Makefile`: server / mace / xtb / fairchem)
- [x] TS contracts generated from pydantic, discriminants forced required so the union narrows
- [x] Fixture campaign from real calculations, for frontend development
- [x] Public repo + MIT license + README

### Scorers verified running locally
- [x] MACE-MP-0 `medium`, CPU/float32 (MPS cannot hold the float64 model) — 32-atom energy in ~2 s
- [x] GFN2-xTB via tblite — molecular **and periodic** both work
- [x] RDKit
- [x] Materials Project API
- [x] ODAC23 `EquiformerV2-S2EF-ODAC` checkpoint loads (Python 3.11 / torch 2.4.1 / scipy 1.14.1)

### Hero measurement — validated
- [x] Vacancy-mediated CI-NEB migration barrier: supercell ≥8 Å, vacancy created, **hopping ion pinned**
      during endpoint relaxation, barrier = **maximum uphill climb** (not peak − endpoint, which hides
      the metastable interstitial). **Li₃PS₄ = 0.280 eV vs literature 0.2–0.5.** Li₃ErCl₆ = 0.170 eV.
      Two earlier implementations were silently wrong by orders of magnitude — see project-context.md.

---

## Phase 1 — Parallel build 🔄 IN PROGRESS (6 agents, one directory each)
- [ ] **A** — campaign loop, Claude agents (Strategist / Skeptic / Analyst / Controller / intake /
      proposal), generator with information-gain selection, FastAPI + SSE + replay endpoints
- [ ] **B** — atomistic scorer, MACE worker extensions, Materials Project layer with disk cache,
      real OOD detector, scorer registry
- [ ] **C** — xTB worker (molecular-crystal lattice energy), ODAC worker (adsorption energy),
      pore geometry → void grid, RDKit + retrieval scorers
- [ ] **D** — event reducer, app shell, hypothesis board with REFUTED state, live Pareto, streaming
      lab notebook, measurements table, compute ledger, closing panel, timeline scrubber, tour mode
- [ ] **E** — CIF parser, ball-and-stick, unit cells, coordination polyhedra, trajectory playback,
      NEB ion-migration tube, void isosurface (marching cubes), adsorption sites
- [ ] **F** — hypothesis tree with refuted branches going dark, 3D chemical-space flythrough,
      Pareto frontier as a real surface

## Phase 2 — Campaigns
- [ ] **HERO — solid-state Li conductor** · periodic crystal lattice · MACE-MP-0
      objectives: migration barrier vs. electrochemical window vs. energy above hull
- [ ] **MOF for atmospheric water harvesting** · porous framework · ODAC23 + MACE
      objectives: water adsorption vs. regeneration-energy proxy vs. framework stability
      (Yaghi lab @ Berkeley pioneered this — local credibility)
- [ ] **Drug thermostability — cold-chain-free medicine** · molecular crystal · GFN2-xTB + RDKit
      objectives: polymorph lattice-energy stability vs. solubility proxy vs. degradation proxy
      stake: medicine that survives without refrigeration in hot, low-resource regions
- [ ] Record all three as golden event logs; rehearse the domain-switch generality proof

## Phase 3 — Ship
- [ ] Static replay build → Vercel (CLI already authenticated as `dylancc5-7738`)
- [ ] Verify the live URL in Chrome, console clean
- [ ] README architecture diagram

## Phase 4 — Video
- [x] Script drafted → `video/script.md` (~3:50)
- [x] Playwright recorder → `video/record.mjs` (drives `?tour=1`, 1080p, reports console errors)
- [ ] Record the tour for all three campaigns
- [ ] Remotion title cards + tech slide + captions
- [ ] Teleprompter page for Dylan's take
- [ ] Dylan records webcam → `video/input/dylan.mov`
- [ ] Retime cuts to his delivery, add PIP, export YouTube-ready MP4

---

## Decisions
- Name → ATHANOR
- Hero campaign → solid-state Li conductor
- Campaign count → 3, chosen as distinct visual archetypes
- **Campaign 3 → molecular-crystal polymorph stability. NO proteins, docking, or binding affinity;
  Boltz-2 dropped entirely.**
- Stack: Next.js 15 + React 19 + react-three-fiber v9 (single rendering substrate, no 3Dmol.js)
  + FastAPI
- Model split: Opus 5.5 for Strategist/Skeptic/Analyst/Controller, Haiku 5.5 for parsing
- Public demo is replay-only; the goal input politely declines to spend API budget
- CUT: PFAS scavenger (archetype collides with MOF), green ammonia catalyst (slab = flat gray plane)
- AVOID: superconductors (Tc not predictable from MLIPs — would be fiction);
  MACE-OMAT-0 / MACE-OFF23 (academic-only licensing)
- Reserve archetypes: twisted 2D bilayer moiré, rare-earth-free magnets, Mars regolith ISRU

## Review
_(fill in when done)_
