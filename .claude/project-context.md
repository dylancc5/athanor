# ATHANOR — project context

Autonomous research campaign platform for a hackathon. Repo: https://github.com/dylancc5/athanor (public, MIT).
Deliverables: working product, public repo, replay-mode public site, demo video Dylan narrates.

## Hard-won architecture decisions

**Compute runs out-of-process, one uv env per scorer.** Not a style choice: torch (MACE, fairchem) and
tblite each link their own copy of libomp and **abort the process** with `OMP: Error #15` when imported
together. fairchem additionally needs Python 3.11 + torch 2.4.1 + scipy 1.14.1 (it imports
`scipy.special.sph_harm`, removed in scipy 1.17). The server env therefore holds **no torch and no
tblite**. Everything goes through `athanor/workers/base.py::run_worker(name, request)` over JSON on
stdin/stdout. Envs built by `backend/Makefile`.

**Server env needs scipy >= 1.15** (mp-api imports `scipy.interpolate.make_splrep`), while the mace and
fairchem envs need scipy < 1.15. Another reason the envs are separate.

**MACE runs on CPU at float32.** `device="mps"` fails outright: the MPS backend cannot hold the float64
model. CPU is fast enough — ~2 s for a 32-atom energy including model load.

**The event log is the only state.** Backend appends typed events; UI is a pure function of the log.
Gives deterministic replay (so the public site needs no backend and no API spend), a nearly-free
timeline scrubber, and one source of truth. `web/lib/contracts.ts` is **generated** from
`backend/athanor/contracts.py` via `scripts/gen_schema.py` + `npm run gen:types`; never edit it by hand.
The generator forces event `type` discriminants into `required` so the TS union narrows.

**Migration barrier — the hero number, and three implementations were wrong before this one.**
Straight-line interpolation: ~14 eV (drives the ion through a neighbour). Unconstrained endpoint
relaxation: 0.003 eV (the ion drifts off its site and the saddle vanishes). Correct: expand to a >=8 A
supercell, remove one mobile ion to create the vacancy that mediates real migration, **pin the hopping
ion** during endpoint relaxation, CI-NEB, and score the barrier as the **maximum uphill climb** along the
profile (`_max_climb`) rather than peak-minus-endpoint — migration passes through a metastable
interstitial that the naive metric hides. Validated: **Li3PS4 = 0.280 eV** vs literature 0.2-0.5.
Any change here must re-verify that number.

## Scope decisions

- **No proteins, docking, or binding affinity anywhere.** Campaign 3 is molecular-crystal polymorph
  stability and formulation only. Boltz-2 was dropped.
- Three campaigns chosen as distinct visual archetypes: Li conductor (periodic lattice, HERO),
  MOF water harvesting (porous framework), drug thermostability (molecular crystal).
- Avoid superconductors — Tc is not predictable from these potentials and would be fiction.
- Avoid MACE-OMAT-0 and MACE-OFF23 (academic-only / ASL licensing). MACE-MP-0 is MIT.

## Conventions

- **Scientific honesty is the product.** Never invent, interpolate or estimate a number. Every
  `Measurement` carries truthful `confidence`, `ood_flag`, `is_proxy`, and `method`. A proxy's `note`
  says what it stands in for. Failures go in `ScoreResult.failed` — never substitute a plausible value.
- Every closing proposal states the capability boundary: a few hundred atoms over picoseconds; nothing
  about bulk mechanical properties, long-timescale kinetics, device performance, or manufacturability.
- Models: `claude-opus-5-5` for Strategist/Skeptic/Analyst/Controller, `claude-haiku-5-5` for parsing.
  Forced `tool_choice`, `budget_tokens`, `thinking: disabled`, and assistant prefill are all 400 errors
  on these models — use structured outputs and `output_config.effort`.
- Public site: replay only. Live campaigns gated behind `ATHANOR_LIVE=1`; the API returns 403 otherwise.
- Vercel CLI is already authenticated as `dylancc5-7738`.
- Screen recording uses Playwright (`video/record.mjs`) against the self-driving tour at `?tour=1`,
  not Claude in Chrome (which only produces GIFs).
