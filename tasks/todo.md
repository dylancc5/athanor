# ATHANOR — Autonomous Research Campaign Platform
**One line:** An agentic platform that runs multi-round scientific research campaigns —
proposes falsifiable hypotheses, tests them against physics-based foundation models,
refutes its own ideas, learns across rounds, and ends with a testable experimental proposal.

**Posture:** sell the vision. Breadth of domain coverage + the self-refuting loop are the pitch.
No confidence/provenance UI for now (keep the fields in the data model; agents reason over them).

---

## Capability boundary
Reaches: anything decided by a few hundred atoms over a few picoseconds.
Does NOT reach: bulk mechanical properties, long-timescale kinetics, device-level
performance, cost/manufacturability — those come from retrieval + heuristics.

## Core contracts (build first — everything hangs off these)
- [ ] `Candidate {id, structure, repr_kind, domain, provenance}`
- [ ] `Objective {property, direction, target, weight, unit}`
- [ ] `Spec {objectives[], constraints[], domain, seed_strategy}`
- [ ] `Measurement {candidate_id, property, value, unit, source, confidence, ood_flag}` (no UI surface)
- [ ] `Scorer` protocol: `async score(Candidate[]) -> Measurement[]`
- [ ] `Generator` protocol: `propose(Spec, Notebook) -> Candidate[]`
- [ ] Typed event bus + append-only campaign event log (JSON)
- [ ] **Replay mode** — deterministic campaign replay from event log (demo insurance)

## The campaign loop
- [ ] Intake: NL goal -> Spec (Claude structured output)
- [ ] Lab Notebook: append-only hypotheses / verdicts / learned heuristics
- [ ] Strategist (Opus): Notebook -> falsifiable hypothesis + batch plan
- [ ] Generator: retrieval seeds + Claude-proposed perturbations
- [ ] Router: domain tag -> scorer + task head
- [ ] Skeptic (Opus): veto on OOD / implausible / unsynthesizable
- [ ] Analyst (Opus): SUPPORTED / REFUTED / INCONCLUSIVE + heuristic writeback
- [ ] Controller: continue / pivot / spawn parallel branch / converge
- [ ] Multi-objective Pareto ranking
- [ ] BO/active-learning layer for candidate selection within a hypothesis

## Scorer registry (ALL UNGATED — UMA is an optional upgrade, not a dependency)
- [ ] Atomistic scorer wraps `ase.calculators.Calculator` -> every engine below is a 1-line swap
- [ ] MACE-MP-0 `medium` (MIT, `pip install mace-torch`) — PRIMARY. bulk crystals, 89 elements
      device="mps", default_dtype="float32" on the M5; some e3nn ops fall back to CPU
- [ ] fairchem pre-UMA OC20 checkpoints (EquiformerV2 / GemNet-OC) — catalytic surfaces, ungated
- [ ] fairchem ODAC23 checkpoints — MOF + CO2 direct air capture, ungated
- [ ] GFN2-xTB via tblite — molecules/electrolytes/PFAS. real semi-empirical QM, no training cliff
- [ ] Boltz-2 (MIT, ungated) — protein-ligand complexes + affinity; precompute & hash-cache
- [ ] RDKit — descriptors, synthetic accessibility
- [ ] Retrieval scorer — Materials Project (free API key), PubChem, PDB
- [ ] OOD detector per scorer
- [ ] OPTIONAL: UMA (gated) — request in background; swap in if approval lands
      AVOID MACE-OMAT-0 (ASL / academic-only). ORB-v3 is Apache 2.0 but verify repo LICENSE.

## 3 demo campaigns — chosen as distinct VISUAL ARCHETYPES
- [ ] **HERO — Solid-state Li conductor** · archetype: periodic crystal lattice
      scorer: MACE-MP-0 | seeds: Materials Project Li-containing
      objectives: migration barrier vs electrochemical window vs energy-above-hull
      3D: lattice + animated NEB ion-migration tube
      synthesis: solid-state sintering | test: electrochemical impedance spectroscopy
- [ ] **MOF for atmospheric water harvesting** · archetype: porous framework
      scorer: fairchem ODAC23 checkpoints (ungated) + MACE
      objectives: water uptake vs regeneration energy vs framework stability
      3D: cage + translucent void isosurface + pores filling with water
      note: Yaghi lab @ Berkeley pioneered this — free local credibility
- [ ] **Drug thermostability — cold-chain-free medicine** · archetype: biomolecular / molecular crystal
      scorer: Boltz-2 (target binding, precomputed/cached) + GFN2-xTB (molecular crystal packing,
      ungated — NOT MACE-OFF23, that's ASL) + RDKit
      objectives: polymorph lattice-energy stability vs. solubility vs. degradation susceptibility
      3D: molecular crystal packing + protein-ligand complex (ribbon + pocket + ligand)
      stake: medicine that survives without refrigeration in hot, low-resource regions
      synthesis: crystallization / formulation screen
      test: accelerated stability study (ICH 40C / 75% RH) + DSC & XRPD for polymorph ID

CUT: PFAS scavenger (archetype collides with MOF), green ammonia catalyst (slab = flat gray plane)
AVOID: superconductors — Tc is not predictable from MLIPs; would be fiction
Alternates held in reserve: twisted 2D bilayer moire, rare-earth-free magnets (spin vectors),
Mars regolith ISRU, plastic depolymerization

## 3D (react-three-fiber as single rendering substrate; converter -> unified scene graph)
- [ ] Converters: CIF/POSCAR -> cells, SMILES -> molecules, PDB -> protein, slab+adsorbate
- [ ] Structural: unit cells, supercells, coordination polyhedra, MOF void isosurface,
      ball-and-stick, HOMO/LUMO isosurfaces, protein ribbon + pocket surface
- [ ] Dynamic: relaxation trajectory playback (free from the optimizer — keep the frames),
      Li-ion NEB migration path as animated tube, phonon modes, charge-density coloring
- [ ] Abstract (the differentiator): 3D chemical-space flythrough of all candidates,
      Pareto as a real 3D surface, hypothesis tree growing / refuted branches going dark

## Frontend
- [ ] Event-stream-driven UI (SSE); UI = pure fn of event log
- [ ] NL goal input -> Spec materializes
- [ ] Hypothesis board with REFUTED state (the money shot)
- [ ] Live Pareto frontier, candidates as points
- [ ] 3D viewer for EVERY output type: molecules, crystals, surface slabs,
      MOF cages, protein-ligand complexes (3Dmol.js; animate Li-ion pathway)
- [ ] Self-writing Lab Notebook panel (streaming prose)
- [ ] Closing panel: synthesis route + validation protocol + falsification criteria

## Demo prep
- [x] Materials Project API key — tested, working
- [x] Anthropic API key — tested, working
- [ ] Pull Boltz-2 weights; precompute + cache demo complexes
- [ ] Record golden campaigns to event logs
- [ ] Rehearse the 15-second domain-switch generality proof

---

## Decisions
- Name -> ATHANOR
- Hero campaign -> solid-state Li conductor
- Campaign count -> 3, by visual archetype
- Campaign 3 framing -> drug thermostability (NOT the antibiotic framing)
- Stack: Next.js + FastAPI (assumed)
- Model split: Opus for Strategist/Skeptic/Analyst, Haiku for parsing

## Review
_(fill in when done)_
