"""Core contracts for ATHANOR. Everything else hangs off these types.

The campaign event log is the single source of truth: the backend appends
events, and the UI is a pure function of the log (live over SSE, or replayed
from a JSONL file). `web/lib/contracts.ts` is generated from this module by
`scripts/gen_ts.py` — do not edit it by hand.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Protocol, Union, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------
# Domain objects
# --------------------------------------------------------------------------

Domain = Literal["solid_electrolyte", "mof_water", "drug_stability"]
ReprKind = Literal["cif", "smiles", "pdb", "xyz"]


class Provenance(Model):
    """Where a candidate came from."""

    source: Literal["retrieval", "perturbation", "user"]
    database: str | None = None  # e.g. "materials_project", "pubchem", "cod", "pdb"
    external_id: str | None = None  # e.g. "mp-985583"
    parent_id: str | None = None  # candidate this one was derived from
    operation: str | None = None  # human-readable edit, e.g. "substitute 25% S -> Cl"


class Candidate(Model):
    id: str
    name: str  # short display label, e.g. "Li6PS5Cl" or "MOF-303 (Al)"
    formula: str | None = None
    structure: str  # serialized structure in `repr_kind` format
    repr_kind: ReprKind
    domain: Domain
    provenance: Provenance
    hypothesis_id: str | None = None


class Objective(Model):
    property: str  # machine key, matches Measurement.property
    label: str  # display label
    direction: Literal["min", "max", "target"]
    target: float | None = None
    weight: float = 1.0
    unit: str


class Constraint(Model):
    property: str
    op: Literal["<", "<=", ">", ">=", "==", "in", "not_in"]
    value: float | str | list[str]
    description: str


class Spec(Model):
    goal: str  # the user's natural-language goal, verbatim
    title: str
    domain: Domain
    objectives: list[Objective]
    constraints: list[Constraint] = []
    seed_strategy: str


class Measurement(Model):
    candidate_id: str
    property: str
    value: float
    unit: str
    source: str  # scorer name, e.g. "mace-mp-0" or "materials_project"
    method: str | None = None  # e.g. "CI-NEB, 5 images"
    confidence: float = Field(ge=0.0, le=1.0)
    ood_flag: bool = False
    is_proxy: bool = False  # true when the value stands in for the real property
    note: str | None = None


class Artifact(Model):
    """Heavy visual payload attached to a candidate (kept out of the event log).

    Stored as JSON at `<campaign_dir>/artifacts/<id>.json`; events carry only
    this descriptor. Payload shapes by kind:
      relaxation_trajectory: {symbols[], cell[3][3]|null, pbc, frames[[x,y,z]...], energies[]}
      neb_path:              {symbols[], cell, frames[...], energies[], mobile_index, barrier_ev}
      void_grid:             {cell, shape[3], values[] (flat, 0..1), void_fraction, pore_diameter_A}
      adsorption_sites:      {symbols[], cell, positions[], guests[{symbols[],positions[],energy_ev}]}
      complex:               {pdb, ligand_resname, pocket_residues[], affinity?}
      crystal_packing:       {symbols[], cell, positions[], molecules[[atom indices]]}
      orbital:               {symbols[], positions[], grid{origin,axes,shape,values[]}, which}
    """

    id: str
    candidate_id: str
    kind: Literal[
        "relaxation_trajectory",
        "neb_path",
        "void_grid",
        "adsorption_sites",
        "complex",
        "crystal_packing",
        "orbital",
    ]
    label: str
    uri: str  # relative to the campaign directory


class BatchPlan(Model):
    n_candidates: int
    strategy: str  # how candidates will be chosen to test the hypothesis
    properties: list[str]  # which measurements decide it


class Hypothesis(Model):
    id: str
    parent_id: str | None = None  # hypothesis this one grew out of (tree edge)
    round: int
    branch: str = "main"
    statement: str  # the falsifiable claim
    rationale: str
    prediction: str  # what we expect to measure if it holds
    falsification_criterion: str  # what result would refute it
    batch_plan: BatchPlan


Verdict = Literal["SUPPORTED", "REFUTED", "INCONCLUSIVE"]


class Heuristic(Model):
    id: str
    text: str
    learned_from: str  # hypothesis id
    strength: Literal["tentative", "established"]


class Veto(Model):
    candidate_id: str
    category: Literal["ood", "implausible", "unsynthesizable", "duplicate", "off_spec"]
    reason: str


class ParetoPoint(Model):
    candidate_id: str
    rank: int  # 0 = on the frontier
    values: dict[str, float]  # property -> value
    scalar_score: float  # weighted, normalized, higher is better


class Proposal(Model):
    """The closing experimental proposal."""

    title: str
    summary: str
    lead_candidate_ids: list[str]
    synthesis_route: list[str]  # ordered steps
    validation_protocol: list[str]
    falsification_criteria: list[str]
    caveats: list[str]  # what the models cannot tell us (capability boundary)


class Ledger(Model):
    candidates_generated: int = 0
    candidates_vetoed: int = 0
    candidates_scored: int = 0
    measurements: int = 0
    llm_calls: int = 0
    llm_input_tokens: int = 0
    llm_output_tokens: int = 0
    scorer_seconds: float = 0.0
    wall_seconds: float = 0.0
    est_dft_cpu_hours: float = 0.0  # what the same screen would cost with DFT


# --------------------------------------------------------------------------
# Events
# --------------------------------------------------------------------------


class CampaignStarted(Model):
    type: Literal["campaign.started"] = "campaign.started"
    goal: str
    recorded: bool = False  # true when emitted by replay


class SpecCreated(Model):
    type: Literal["spec.created"] = "spec.created"
    spec: Spec


class RoundStarted(Model):
    type: Literal["round.started"] = "round.started"
    round: int


class HypothesisProposed(Model):
    type: Literal["hypothesis.proposed"] = "hypothesis.proposed"
    hypothesis: Hypothesis


class CandidatesGenerated(Model):
    type: Literal["candidates.generated"] = "candidates.generated"
    hypothesis_id: str
    candidates: list[Candidate]


class SkepticReviewed(Model):
    type: Literal["skeptic.reviewed"] = "skeptic.reviewed"
    hypothesis_id: str
    approved_ids: list[str]
    vetoes: list[Veto]
    commentary: str


class ScoringStarted(Model):
    type: Literal["scoring.started"] = "scoring.started"
    candidate_id: str
    scorer: str


class MeasurementRecorded(Model):
    type: Literal["measurement.recorded"] = "measurement.recorded"
    measurement: Measurement


class ArtifactCreated(Model):
    type: Literal["artifact.created"] = "artifact.created"
    artifact: Artifact


class EmbeddingUpdated(Model):
    """3D chemical-space coordinates for every candidate seen so far."""

    type: Literal["embedding.updated"] = "embedding.updated"
    points: dict[str, tuple[float, float, float]]


class ParetoUpdated(Model):
    type: Literal["pareto.updated"] = "pareto.updated"
    points: list[ParetoPoint]


class AnalystVerdict(Model):
    type: Literal["analyst.verdict"] = "analyst.verdict"
    hypothesis_id: str
    verdict: Verdict
    reasoning: str
    evidence: list[str]  # short statements citing measured numbers
    heuristics: list[Heuristic]


class NotebookDelta(Model):
    """A streamed chunk of Lab Notebook prose. Concatenate by entry_id."""

    type: Literal["notebook.delta"] = "notebook.delta"
    entry_id: str
    author: Literal["strategist", "skeptic", "analyst", "controller", "system"]
    heading: str | None = None  # set on the first delta of an entry
    text: str


class ControllerDecision(Model):
    type: Literal["controller.decision"] = "controller.decision"
    action: Literal["continue", "pivot", "branch", "converge"]
    reasoning: str
    branches: list[str] = []  # branch names opened by a "branch" action


class LedgerUpdated(Model):
    type: Literal["ledger.updated"] = "ledger.updated"
    ledger: Ledger


class ProposalCreated(Model):
    type: Literal["proposal.created"] = "proposal.created"
    proposal: Proposal


class CampaignCompleted(Model):
    type: Literal["campaign.completed"] = "campaign.completed"
    rounds: int


class CampaignError(Model):
    type: Literal["campaign.error"] = "campaign.error"
    stage: str
    message: str
    fatal: bool


EventBody = Annotated[
    Union[
        CampaignStarted,
        SpecCreated,
        RoundStarted,
        HypothesisProposed,
        CandidatesGenerated,
        SkepticReviewed,
        ScoringStarted,
        MeasurementRecorded,
        ArtifactCreated,
        EmbeddingUpdated,
        ParetoUpdated,
        AnalystVerdict,
        NotebookDelta,
        ControllerDecision,
        LedgerUpdated,
        ProposalCreated,
        CampaignCompleted,
        CampaignError,
    ],
    Field(discriminator="type"),
]


class Event(Model):
    """One line of the append-only campaign log."""

    seq: int  # 0-based, gapless
    t: float  # seconds since campaign start (drives replay pacing)
    campaign_id: str
    body: EventBody


# --------------------------------------------------------------------------
# Protocols
# --------------------------------------------------------------------------


class ScoreResult(Model):
    measurements: list[Measurement] = []
    artifacts: list[tuple[Artifact, dict[str, Any]]] = []  # descriptor + payload
    failed: dict[str, str] = {}  # candidate_id -> reason


@runtime_checkable
class Scorer(Protocol):
    """Turns candidates into measurements. Implementations must be honest:
    set `is_proxy`, `confidence` and `ood_flag` truthfully, and report failures
    in `ScoreResult.failed` rather than inventing values."""

    name: str
    domains: tuple[Domain, ...]
    properties: tuple[str, ...]

    async def score(self, candidates: list[Candidate], spec: Spec) -> ScoreResult: ...


@runtime_checkable
class Generator(Protocol):
    async def propose(
        self, spec: Spec, hypothesis: Hypothesis, notebook: "NotebookView"
    ) -> list[Candidate]: ...


class NotebookView(Model):
    """Read-only snapshot of what the campaign knows, given to agents."""

    spec: Spec
    hypotheses: list[Hypothesis] = []
    verdicts: dict[str, Verdict] = {}
    verdict_reasoning: dict[str, str] = {}
    heuristics: list[Heuristic] = []
    candidates: dict[str, Candidate] = {}
    measurements: list[Measurement] = []
    vetoes: list[Veto] = []
    pareto: list[ParetoPoint] = []
