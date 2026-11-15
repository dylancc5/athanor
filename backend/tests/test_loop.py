"""End-to-end loop and API tests. No network, no Anthropic spend.

The campaign is driven by a scripted `FakeClient`, so the whole orchestrator —
including the refutation path, the honest-failure path and the event shapes —
runs against the real production code.
"""

from __future__ import annotations

import json

import httpx
import pytest
from httpx import ASGITransport

from athanor import contracts as C
from athanor.eventlog import EventLog, read_events
from athanor.llm import LLM
from athanor.loop.campaign import Campaign, CampaignConfig, embed_candidates
from athanor.loop.generator import (
    apply_substitution,
    composition_vector,
    select_informative,
)
from athanor.loop.router import Router, property_vocabulary

from .conftest import FakeClient, FakeScorer, make_candidate, make_spec

# --------------------------------------------------------------------------
# The scripted campaign
# --------------------------------------------------------------------------

INTAKE = {
    "title": "Solid-state Li conductor",
    "domain": "solid_electrolyte",
    "objectives": [
        {
            "property": "migration_barrier",
            "label": "Li migration barrier",
            "direction": "min",
            "target": None,
            "weight": 2.0,
            "unit": "eV",
        },
        {
            "property": "energy_above_hull",
            "label": "Energy above hull",
            "direction": "min",
            "target": None,
            "weight": 1.0,
            "unit": "eV/atom",
        },
    ],
    "constraints": [
        {
            "property": "elements",
            "op": "not_in",
            "numeric_value": None,
            "list_value": ["Co"],
            "description": "Avoid cobalt",
        }
    ],
    "seed_strategy": "Materials Project near-hull Li-P-S phases",
}

HYPOTHESIS = {
    "statement": "Among near-hull Li phases, a lower energy above hull predicts a lower barrier.",
    "rationale": "A well-ordered lattice should give cleaner migration channels.",
    "prediction": "The most stable candidate also has the lowest barrier.",
    "falsification_criterion": (
        "If the most stable candidate does not have the lowest barrier, the claim is refuted."
    ),
    "batch_plan": {
        "n_candidates": 2,
        "strategy": "Score both retrieved seeds on both axes.",
        "properties": ["migration_barrier", "energy_above_hull"],
    },
    "builds_on_hypothesis_id": "",
}

SKEPTIC = {
    "vetoed": [],
    "commentary": "Both are reported phases. Read the barriers as upper bounds.",
}

VERDICT = {
    "verdict": "REFUTED",
    "reasoning": (
        "c-a is the more stable candidate at 0.000 eV/atom but carries the higher barrier "
        "(0.52 eV), so the criterion is met."
    ),
    "evidence": [
        "c-a: 0.000 eV/atom above hull, migration_barrier 0.52 eV.",
        "c-b: 0.040 eV/atom above hull, migration_barrier 0.21 eV.",
    ],
    "heuristics": [
        {
            "text": "Score stability and mobility separately; one does not predict the other.",
            "strength": "established",
        }
    ],
}

DECISION = {"action": "converge", "reasoning": "The shortcut is dead; write it up.",
            "branch_names": []}

PROPOSAL = {
    "title": "Measure the stability/mobility trade-off directly",
    "summary": "The one-axis screen was refuted; both axes must be measured.",
    "lead_candidate_ids": ["c-b"],
    "synthesis_route": ["Ball-mill Li2S and P2S5 in an argon glovebox."],
    "validation_protocol": ["Electrochemical impedance spectroscopy, 25-100 C."],
    "falsification_criteria": ["An activation energy above 0.40 eV refutes the ranking."],
    "caveats": ["The band gap stands in for the electrochemical window."],
}


def scripted_client() -> FakeClient:
    """One round, ending in a real REFUTED verdict and a proposal."""
    return FakeClient(
        structured=[INTAKE, HYPOTHESIS, SKEPTIC, VERDICT, DECISION, PROPOSAL],
        prose=[
            "Stability and mobility are usually treated as a trade-off. " * 2,
            "Both candidates are experimentally reported. " * 2,
            "The most stable candidate has the higher barrier. " * 2,
            "The shortcut is refuted, so the search stays multi-objective. " * 2,
            "Here is what a lab should do next. " * 2,
        ],
    )


def seeded_campaign(tmp_path, scorer: FakeScorer, **config) -> tuple[Campaign, FakeClient]:
    """A campaign whose retrieval step is replaced by two fixed real structures."""
    client = scripted_client()
    llm = LLM(client)
    event_log = EventLog(tmp_path, "test-campaign")
    campaign = Campaign(
        event_log,
        llm=llm,
        router=Router([scorer]),
        config=CampaignConfig(rounds=1, max_candidates=4, **config),
    )

    seeds = [make_candidate("c-a", "Li2"), make_candidate("c-b", "LiNa")]
    seeds[1].structure = seeds[1].structure.replace("Li", "Na", 1)

    async def fake_propose(spec, hypothesis, notebook):
        for cand in seeds:
            cand.hypothesis_id = hypothesis.id
        return seeds

    campaign.generator.propose = fake_propose  # type: ignore[method-assign]
    return campaign, client


SCORES = {
    "c-a": {"migration_barrier": 0.52, "energy_above_hull": 0.0},
    "c-b": {"migration_barrier": 0.21, "energy_above_hull": 0.04},
}


# --------------------------------------------------------------------------
# The refutation path, end to end
# --------------------------------------------------------------------------


async def test_refuted_campaign_runs_end_to_end(tmp_path):
    scorer = FakeScorer(SCORES, artifacts=True)
    campaign, client = seeded_campaign(tmp_path, scorer)
    await campaign.run("Find a solid lithium electrolyte stable against lithium metal.")

    kinds = [e.body.type for e in campaign.log.events]

    # The spine of the loop, in order.
    assert kinds[0] == "campaign.started"
    assert kinds[1] == "spec.created"
    for earlier, later in (
        ("round.started", "hypothesis.proposed"),
        ("hypothesis.proposed", "candidates.generated"),
        ("candidates.generated", "skeptic.reviewed"),
        ("skeptic.reviewed", "scoring.started"),
        ("scoring.started", "measurement.recorded"),
        ("measurement.recorded", "pareto.updated"),
        ("pareto.updated", "analyst.verdict"),
        ("analyst.verdict", "controller.decision"),
        ("controller.decision", "proposal.created"),
    ):
        assert kinds.index(earlier) < kinds.index(later), f"{earlier} must precede {later}"
    assert kinds[-1] == "campaign.completed"
    assert "campaign.error" not in kinds
    assert "embedding.updated" in kinds
    assert "artifact.created" in kinds
    assert "notebook.delta" in kinds

    verdicts = [e.body for e in campaign.log.events if e.body.type == "analyst.verdict"]
    assert len(verdicts) == 1 and verdicts[0].verdict == "REFUTED"
    assert verdicts[0].heuristics[0].id == "heu-h1-1"

    # Pareto ranking is the shared implementation, over real measured values.
    pareto = [e.body for e in campaign.log.events if e.body.type == "pareto.updated"][-1]
    assert {p.candidate_id for p in pareto.points} == {"c-a", "c-b"}
    # Neither dominates: c-a is nearer the hull, c-b has the lower barrier. That
    # trade-off surviving as a two-point frontier is the result the round found.
    assert {p.candidate_id for p in pareto.points if p.rank == 0} == {"c-a", "c-b"}
    best = max(pareto.points, key=lambda p: p.scalar_score)
    assert best.candidate_id == "c-b"  # the barrier carries twice the weight

    proposal = next(e.body for e in campaign.log.events if e.body.type == "proposal.created")
    assert proposal.proposal.lead_candidate_ids == ["c-b"]
    assert any("picosecond" in c for c in proposal.proposal.caveats)

    ledger = [e.body.ledger for e in campaign.log.events if e.body.type == "ledger.updated"][-1]
    assert ledger.candidates_generated == 2
    assert ledger.candidates_scored == 2
    assert ledger.measurements == 4
    assert ledger.llm_calls == len(client.structured_calls) + len(client.prose_calls)
    assert ledger.llm_input_tokens > 0 and ledger.llm_output_tokens > 0
    assert ledger.est_dft_cpu_hours > 0

    # Every call used the models and settings the API actually accepts.
    for kwargs in client.structured_calls + client.prose_calls:
        assert kwargs["model"] in ("claude-opus-5-5", "claude-haiku-5-5")
        assert "thinking" not in kwargs
        assert "tool_choice" not in kwargs
        assert kwargs["output_config"]["effort"] in ("low", "medium", "high", "xhigh", "max")
        assert kwargs["messages"][-1]["role"] == "user"  # never a prefill
        assert kwargs["max_tokens"] >= 8000


async def test_every_emitted_event_validates_against_the_contract(tmp_path):
    campaign, _ = seeded_campaign(tmp_path, FakeScorer(SCORES, artifacts=True))
    await campaign.run("Find a solid lithium electrolyte.")

    on_disk = list(read_events(campaign.log.path))  # re-validates every line
    assert len(on_disk) == len(campaign.log.events)
    assert [e.seq for e in on_disk] == list(range(len(on_disk)))
    for event in on_disk:
        assert event.campaign_id == "test-campaign"
        C.Event.model_validate(json.loads(event.model_dump_json()))

    artifacts = [e.body.artifact for e in on_disk if e.body.type == "artifact.created"]
    for artifact in artifacts:
        assert (campaign.log.dir / artifact.uri).exists()


async def test_a_scorer_failure_becomes_a_recorded_failure_not_a_value(tmp_path):
    scorer = FakeScorer({"c-b": SCORES["c-b"]}, fail={"c-a": "NEB did not converge"})
    campaign, _ = seeded_campaign(tmp_path, scorer)
    await campaign.run("Find a solid lithium electrolyte.")

    measured = {
        e.body.measurement.candidate_id
        for e in campaign.log.events
        if e.body.type == "measurement.recorded"
    }
    assert measured == {"c-b"}  # the failed candidate gets no invented number
    assert "campaign.error" not in [e.body.type for e in campaign.log.events]
    # Only c-b has a complete objective set, so it is the only ranked point.
    pareto = [e.body for e in campaign.log.events if e.body.type == "pareto.updated"][-1]
    assert [p.candidate_id for p in pareto.points] == ["c-b"]


async def test_a_raising_scorer_is_a_non_fatal_campaign_error(tmp_path):
    campaign, _ = seeded_campaign(tmp_path, FakeScorer(raises=True))
    await campaign.run("Find a solid lithium electrolyte.")

    errors = [e.body for e in campaign.log.events if e.body.type == "campaign.error"]
    assert errors and all(not e.fatal for e in errors)
    assert errors[0].stage == "scoring:fake-scorer"
    # The campaign still finished, and the verdict fell back to the honest one.
    verdict = next(e.body for e in campaign.log.events if e.body.type == "analyst.verdict")
    assert verdict.verdict == "INCONCLUSIVE"
    assert campaign.log.events[-1].body.type == "campaign.completed"


async def test_no_routed_scorer_is_reported_rather_than_faked(tmp_path):
    campaign, _ = seeded_campaign(tmp_path, FakeScorer(SCORES))
    campaign.router = Router([])  # nothing registered
    await campaign.run("Find a solid lithium electrolyte.")

    errors = [e.body for e in campaign.log.events if e.body.type == "campaign.error"]
    assert any(e.stage == "routing" for e in errors)
    assert not [e for e in campaign.log.events if e.body.type == "measurement.recorded"]
    verdict = next(e.body for e in campaign.log.events if e.body.type == "analyst.verdict")
    assert verdict.verdict == "INCONCLUSIVE"


async def test_a_failing_intake_is_fatal_and_closes_the_log(tmp_path):
    client = FakeClient(structured=[{"nonsense": True}], prose=[])
    event_log = EventLog(tmp_path, "broken")
    campaign = Campaign(event_log, llm=LLM(client), router=Router([]))
    await campaign.run("something")

    kinds = [e.body.type for e in campaign.log.events]
    assert kinds == ["campaign.started", "campaign.error"]
    assert campaign.log.events[-1].body.fatal is True


# --------------------------------------------------------------------------
# Router
# --------------------------------------------------------------------------


def test_router_only_routes_scorers_that_measure_a_wanted_property():
    spec = make_spec()
    useful = FakeScorer()
    class OffTarget(FakeScorer):
        name = "off-target"
        properties = ("dielectric_constant",)

    class WrongDomain(FakeScorer):
        name = "wrong-domain"
        domains = ("drug_stability",)

    router = Router([useful, OffTarget(), WrongDomain()])
    cand = make_candidate("c-1")
    assert [s.name for s in router.route(cand, spec)] == ["fake-scorer"]
    assert list(router.plan([cand], spec)) == ["fake-scorer"]


def test_property_vocabulary_prefers_the_registry_then_falls_back():
    from_registry = property_vocabulary("solid_electrolyte", [FakeScorer()])
    assert dict(from_registry) == {"migration_barrier": "eV", "energy_above_hull": "eV/atom"}
    fallback = property_vocabulary("solid_electrolyte", [])
    assert "migration_barrier" in dict(fallback)


def test_the_real_registry_is_reachable_or_absent_without_raising():
    from athanor.loop.router import all_scorers

    scorers = all_scorers()
    assert isinstance(scorers, list)
    for scorer in scorers:
        assert isinstance(scorer.name, str)
        assert tuple(scorer.domains) and tuple(scorer.properties)


# --------------------------------------------------------------------------
# Generator internals
# --------------------------------------------------------------------------


def test_substitution_edits_a_real_structure_and_records_provenance():
    parent = make_candidate("c-a", "Li2")
    child = apply_substitution(parent, "Li", "Na", 0.5, "c-a-1")

    assert child.provenance.source == "perturbation"
    assert child.provenance.parent_id == "c-a"
    assert "Li -> Na" in child.provenance.operation
    assert "Na" in composition_vector(child)
    assert child.structure != parent.structure
    # Deterministic: the same edit twice gives the same structure.
    assert apply_substitution(parent, "Li", "Na", 0.5, "c-a-2").structure == child.structure


def test_substitution_refuses_an_element_that_is_not_there():
    with pytest.raises(ValueError):
        apply_substitution(make_candidate("c-a"), "Cs", "Cl", 0.5, "x")


def test_active_learning_keeps_the_candidates_farthest_from_measured_chemistry():
    measured = make_candidate("c-measured", "Li2")
    near = apply_substitution(measured, "Li", "Na", 0.25, "c-near")
    far = apply_substitution(measured, "Li", "Cs", 1.0, "c-far")

    chosen, note = select_informative([near, far], [measured], 1)
    assert [c.id for c in chosen] == ["c-far"]
    assert "composition" in note and "predicted properties" in note

    chosen, note = select_informative([near, far], [measured], 5)
    assert len(chosen) == 2 and note == ""


def test_embedding_covers_every_candidate_and_is_deterministic():
    cands = [make_candidate("c-a", "Li2")]
    cands.append(apply_substitution(cands[0], "Li", "Na", 0.5, "c-b"))
    cands.append(apply_substitution(cands[0], "Li", "K", 0.5, "c-c"))
    cands.append(apply_substitution(cands[0], "Li", "Cs", 0.5, "c-d"))

    points = embed_candidates(cands)
    assert set(points) == {"c-a", "c-b", "c-c", "c-d"}
    assert all(len(v) == 3 for v in points.values())
    assert points == embed_candidates(cands)


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("ATHANOR_CAMPAIGNS_DIR", str(tmp_path))
    monkeypatch.delenv("ATHANOR_LIVE", raising=False)
    from athanor.api import app

    return app, tmp_path


def client_for(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test", timeout=30.0
    )


async def record_campaign(root) -> Campaign:
    """Write a complete campaign into the API's campaigns root."""
    campaign, _ = seeded_campaign(root, FakeScorer(SCORES, artifacts=True))
    await campaign.run("Find a solid lithium electrolyte.")
    return campaign


async def test_live_campaign_is_403_without_the_env_flag(api):
    app, _ = api
    async with client_for(app) as client:
        response = await client.post("/api/campaigns", json={"goal": "find something"})
    assert response.status_code == 403
    assert response.json()["detail"] == (
        "Live campaigns are disabled on the public demo to avoid API costs. "
        "Replay a recorded campaign instead."
    )


async def test_live_flag_is_read_per_request(api, monkeypatch):
    app, _ = api
    async with client_for(app) as client:
        assert (await client.post("/api/campaigns", json={"goal": "x y z"})).status_code == 403
        monkeypatch.setenv("ATHANOR_LIVE", "1")
        assert (await client.get("/api/health")).json()["live_enabled"] is True


async def test_sse_replay_yields_every_event_in_order(api):
    app, root = api
    campaign = await record_campaign(root)
    expected = [e.model_dump() for e in campaign.log.events]

    async with client_for(app) as client:
        response = await client.get(f"/api/replay/{campaign.log.campaign_id}?speed=0")
        assert response.status_code == 200
        body = response.text

    events, datas = _parse_sse(body)
    assert events == ["athanor"] * len(expected)
    assert [d["seq"] for d in datas] == list(range(len(expected)))
    assert [d["body"]["type"] for d in datas] == [e["body"]["type"] for e in expected]
    for payload in datas:
        C.Event.model_validate(payload)


async def test_events_endpoint_serves_a_recorded_campaign_after_a_restart(api):
    app, root = api
    campaign = await record_campaign(root)
    async with client_for(app) as client:
        response = await client.get(f"/api/campaigns/{campaign.log.campaign_id}/events")
    _, datas = _parse_sse(response.text)
    assert datas[0]["body"]["type"] == "campaign.started"
    assert datas[-1]["body"]["type"] == "campaign.completed"


async def test_list_and_artifact_endpoints(api):
    app, root = api
    campaign = await record_campaign(root)
    artifact = next(
        e.body.artifact for e in campaign.log.events if e.body.type == "artifact.created"
    )

    async with client_for(app) as client:
        listing = (await client.get("/api/campaigns")).json()
        assert [c["id"] for c in listing] == [campaign.log.campaign_id]
        assert listing[0]["completed"] is True
        assert listing[0]["domain"] == "solid_electrolyte"
        assert listing[0]["events"] == len(campaign.log.events)

        payload = await client.get(
            f"/api/campaigns/{campaign.log.campaign_id}/artifacts/{artifact.id}"
        )
        assert payload.status_code == 200
        assert "symbols" in payload.json()

        assert (await client.get("/api/replay/nope")).status_code == 404
        assert (await client.get("/api/replay/..%2Fetc")).status_code in (400, 404)
        assert (
            await client.get(
                f"/api/campaigns/{campaign.log.campaign_id}/artifacts/a-missing"
            )
        ).status_code == 404


def _parse_sse(body: str) -> tuple[list[str], list[dict]]:
    names: list[str] = []
    datas: list[dict] = []
    for block in body.split("\r\n\r\n" if "\r\n\r\n" in body else "\n\n"):
        name = None
        data_lines: list[str] = []
        for line in block.splitlines():
            if line.startswith("event:"):
                name = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:") :].strip())
        if name and data_lines:
            names.append(name)
            datas.append(json.loads("".join(data_lines)))
    return names, datas


# --------------------------------------------------------------------------
# The real ClaudeGenerator (Materials Project mocked, Claude scripted)
# --------------------------------------------------------------------------


class _FakeMPEntry:
    """Shaped like `athanor.mp.MPEntry`, with a real ASE structure behind it."""

    def __init__(self, material_id: str, formula: str, hull: float, element: str):
        from ase.build import bulk

        self.material_id = material_id
        self.formula_pretty = formula
        self.energy_above_hull = hull
        self.structure = {"placeholder": True}
        self._atoms = bulk(element, "bcc", a=3.49, cubic=True) * (2, 1, 1)

    def atoms(self):
        return self._atoms


def _mock_mp(monkeypatch, by_system: dict[str, list[_FakeMPEntry]]):
    """Record every chemsys queried and answer from a fixed table."""
    queried: list[str] = []

    async def asearch_near_hull(**kwargs):
        chemsys = kwargs["chemsys"]
        queried.append(chemsys)
        return list(by_system.get(chemsys, []))

    from athanor import mp

    monkeypatch.setattr(mp, "asearch_near_hull", asearch_near_hull)
    return queried


SEED_QUERY = {
    "chemical_systems": ["Li-Ge-P-S", "Li-P-S"],
    "compound_names": [],
    "reasoning": "LGPS is the bcc arm of the claim; Li-P-S supplies the hcp reference.",
}

EDITS = {
    "crystal_edits": [
        {
            "parent_id": "c-mp-1",
            "element_out": "Li",
            "element_in": "Na",
            "fraction": 0.5,
            "rationale": "A larger cation widens the channel.",
        }
    ],
    "molecular_edits": [],
    "commentary": "One substitution discriminates the claim.",
}


def _hypothesis_naming_lgps() -> C.Hypothesis:
    return C.Hypothesis(
        id="h1",
        round=1,
        statement="In lithium thiophosphates the S sublattice topology sets the Li barrier.",
        rationale="A bcc sublattice allows tetrahedral-to-tetrahedral hops.",
        prediction="Li10GeP2S12 has a barrier at least 0.15 eV below gamma-Li3PS4.",
        falsification_criterion=(
            "Refuted if the Li10GeP2S12 barrier is within 0.10 eV of the gamma-Li3PS4 barrier."
        ),
        batch_plan=C.BatchPlan(
            n_candidates=2,
            strategy="Score one candidate from each arm of the claim.",
            properties=["migration_barrier", "energy_above_hull"],
        ),
    )


async def test_seed_query_is_written_against_the_hypothesis(tmp_path, monkeypatch):
    """The blocker this guards: a batch that cannot reach the materials the
    falsification criterion names is an inconclusive verdict decided in advance."""
    from athanor.loop.generator import ClaudeGenerator

    queried = _mock_mp(
        monkeypatch,
        {
            "Li-Ge-P-S": [_FakeMPEntry("mp-1", "Li10GeP2S12", 0.01, "Li")],
            "Li-P-S": [_FakeMPEntry("mp-2", "Li3PS4", 0.0, "Na")],
        },
    )
    # Round 1 now retrieves AND perturbs, so both replies are scripted.
    first_round_edits = {
        "crystal_edits": [
            {
                "parent_id": "c-mp-1",
                "element_out": "Li",
                # Rb, not Na: mp-2 in this fixture is already pure Na, and the
                # dedupe would (correctly) drop a child identical to it.
                "element_in": "Rb",
                "fraction": 1.0,
                "rationale": "The derived side of the controlled pair.",
            }
        ],
        "molecular_edits": [],
        "commentary": "Complete substitution on the retrieved parent.",
    }
    client = FakeClient(structured=[SEED_QUERY, first_round_edits], prose=[])
    emitted: list = []
    generator = ClaudeGenerator(LLM(client), emitted.append)

    hypothesis = _hypothesis_naming_lgps()
    hypothesis.batch_plan.n_candidates = 3
    candidates = await generator.propose(
        make_spec(), hypothesis, C.NotebookView(spec=make_spec())
    )

    prompt = client.structured_calls[0]["messages"][0]["content"]
    assert hypothesis.statement in prompt
    assert hypothesis.falsification_criterion in prompt
    assert "Li10GeP2S12" in prompt  # the arm the criterion is written about

    assert queried == ["Li-Ge-P-S", "Li-P-S"]
    assert all(c.hypothesis_id == "h1" for c in candidates)
    assert all(c.structure.strip() for c in candidates)

    # Retrieved parents are present...
    by_source = {c.provenance.source for c in candidates}
    assert {"c-mp-1", "c-mp-2"} <= {c.id for c in candidates}
    # ...and so is a candidate DERIVED from one of them in the same round. This
    # is the fix: a batch plan that says "substitute 100% O -> S on candidate 1"
    # must be executable in the round that proposes it, or the controlled pair
    # never exists and the verdict is inconclusive on arrival.
    assert "perturbation" in by_source, [
        (c.id, c.provenance.source) for c in candidates
    ]
    derived = next(c for c in candidates if c.provenance.source == "perturbation")
    assert derived.provenance.parent_id == "c-mp-1"
    assert "100% Li -> Rb" in derived.provenance.operation

    # The perturbation prompt must list the just-retrieved parents as editable.
    edit_prompt = client.structured_calls[-1]["messages"][0]["content"]
    assert "Parent structures you may edit this round" in edit_prompt
    assert "c-mp-1" in edit_prompt

    note = next(e for e in emitted if e.type == "notebook.delta")
    assert note.author == "system"
    assert "perturbation" in note.heading.lower()


async def test_later_rounds_retrieve_as_well_as_perturb(tmp_path, monkeypatch):
    """A heuristic like "put LGPS in the batch" has to be actionable in round 2."""
    from athanor.loop.generator import ClaudeGenerator

    _mock_mp(monkeypatch, {"Li-Ge-P-S": [_FakeMPEntry("mp-9", "Li10GeP2S12", 0.01, "K")]})
    client = FakeClient(
        structured=[{**SEED_QUERY, "chemical_systems": ["Li-Ge-P-S"]}, EDITS], prose=[]
    )
    emitted: list = []
    generator = ClaudeGenerator(LLM(client), emitted.append)

    parent = make_candidate("c-mp-1", "Li2")
    spec = make_spec()
    hypothesis = _hypothesis_naming_lgps()
    hypothesis.batch_plan.n_candidates = 2
    view = C.NotebookView(
        spec=spec,
        hypotheses=[hypothesis],
        candidates={"c-mp-1": parent},
        measurements=[
            C.Measurement(
                candidate_id="c-mp-1",
                property="migration_barrier",
                value=0.5,
                unit="eV",
                source="fake-scorer",
                confidence=0.7,
            )
        ],
    )

    candidates = await generator.propose(spec, hypothesis, view)
    sources = {c.id: c.provenance.source for c in candidates}
    assert "c-mp-9" in sources and sources["c-mp-9"] == "retrieval"
    assert any(s == "perturbation" for s in sources.values())
    perturbed = next(c for c in candidates if c.provenance.source == "perturbation")
    assert perturbed.provenance.parent_id == "c-mp-1"
    assert "Li -> Na" in perturbed.provenance.operation


async def test_a_retrieved_candidate_already_in_the_notebook_is_not_duplicated(
    tmp_path, monkeypatch
):
    from athanor.loop.generator import ClaudeGenerator

    entry = _FakeMPEntry("mp-1", "Li2", 0.0, "Li")
    _mock_mp(monkeypatch, {"Li-Ge-P-S": [entry], "Li-P-S": []})
    client = FakeClient(structured=[SEED_QUERY, EDITS], prose=[])
    generator = ClaudeGenerator(LLM(client), lambda body: None)

    from athanor.structure import atoms_to_cif

    parent = make_candidate("c-mp-1", "Li2")
    parent.structure = atoms_to_cif(entry.atoms())
    view = C.NotebookView(spec=make_spec(), candidates={"c-mp-1": parent})

    candidates = await generator.propose(make_spec(), _hypothesis_naming_lgps(), view)
    assert all(c.provenance.source == "perturbation" for c in candidates)


async def test_first_round_retrieval_failure_is_raised_for_the_campaign_to_record(
    tmp_path, monkeypatch
):
    from athanor.loop.generator import ClaudeGenerator

    _mock_mp(monkeypatch, {})  # every query comes back empty
    client = FakeClient(structured=[SEED_QUERY], prose=[])
    generator = ClaudeGenerator(LLM(client), lambda body: None)
    with pytest.raises(RuntimeError):
        await generator.propose(
            make_spec(), _hypothesis_naming_lgps(), C.NotebookView(spec=make_spec())
        )


async def test_retrieval_covers_every_arm_instead_of_the_most_stable_one(monkeypatch):
    """A global stability sort fills the batch from the stable arm and drops the
    comparison the falsification criterion is written about."""
    from athanor.loop.seeds import _mp_seeds

    _mock_mp(
        monkeypatch,
        {
            # The LGPS arm sits further from the hull...
            "Li-Ge-P-S": [_FakeMPEntry("mp-lgps", "Li10GeP2S12", 0.012, "Li")],
            # ...than two entries of the reference arm, which would otherwise
            # take both slots.
            "Li-P-S": [
                _FakeMPEntry("mp-a", "Li3PS4", 0.0, "Na"),
                _FakeMPEntry("mp-b", "Li3PS4", 0.004, "K"),
            ],
        },
    )
    seeds = await _mp_seeds(["Li-Ge-P-S", "Li-P-S"], 2, "solid_electrolyte", make_spec())
    ids = [c.provenance.external_id for c in seeds]
    assert "mp-lgps" in ids, "the hypothesis's own arm must survive the cut"
    assert ids == ["mp-a", "mp-lgps"]  # best of each system, most stable first


def test_the_retrieval_atom_cap_does_not_exclude_the_demo_materials():
    """A cap of 48 silently removed Li10GeP2S12 (50 sites) from a campaign whose
    hypothesis was about it. Cell-size budgets belong to the scorer, which
    reports "not attempted"; retrieval must not pre-empt that decision."""
    from athanor.loop.seeds import MAX_ATOMS

    assert MAX_ATOMS >= 50, "Li10GeP2S12 has 50 sites and must stay reachable"


async def test_live_campaign_defaults_are_small_enough_to_finish(api, monkeypatch):
    """The scorers run a CI-NEB per candidate, so a 3x6 default would run for
    hours and read as broken to anyone cloning the repo."""
    from athanor.api import NewCampaign

    body = NewCampaign(goal="find a solid lithium electrolyte")
    assert body.rounds == 1
    assert body.max_candidates <= 3

    app, _root = api
    monkeypatch.setenv("ATHANOR_LIVE", "1")
    # Nothing is registered in this process, so the campaign ends quickly; the
    # point here is the response contract, not the science.
    monkeypatch.setattr("athanor.api.Campaign", _InertCampaign)
    async with client_for(app) as client:
        response = await client.post(
            "/api/campaigns", json={"goal": "find a solid lithium electrolyte"}
        )
    assert response.status_code == 201
    payload = response.json()
    assert payload["id"].startswith("live-")
    assert payload["events"] == f"/api/campaigns/{payload['id']}/events"
    assert payload["rounds"] == 1
    note = payload["note"].lower()
    assert "hours" in note and "replay" in note


async def test_live_campaign_rejects_an_absurd_request(api, monkeypatch):
    app, _ = api
    monkeypatch.setenv("ATHANOR_LIVE", "1")
    async with client_for(app) as client:
        for bad in ({"goal": "x"}, {"goal": "a real goal", "rounds": 99},
                    {"goal": "a real goal", "max_candidates": 0}):
            assert (await client.post("/api/campaigns", json=bad)).status_code == 422


class _InertCampaign:
    """Stands in for `Campaign` so the endpoint test spends nothing."""

    def __init__(self, event_log, **kwargs):
        self.log = event_log

    async def run(self, goal: str) -> None:
        self.log.emit(C.CampaignStarted(goal=goal))
        self.log.emit(C.CampaignCompleted(rounds=0))
        self.log.close()


def test_retrieval_scorer_is_matched_on_domain_not_just_on_having_the_method():
    """A retrieval scorer raises when handed a spec from a domain it does not
    cover, so an unfiltered lookup sends a crystal campaign to a molecular
    retriever. This is what broke when the molecular scorer landed."""
    from athanor.loop.router import retrieval_scorer

    class MolecularRetriever(FakeScorer):
        name = "retrieval"
        domains = ("mof_water", "drug_stability")

        async def retrieve(self, spec, n):
            raise AssertionError(f"must not be asked for {spec.domain}")

    pool = [MolecularRetriever(), FakeScorer()]
    assert retrieval_scorer("drug_stability", pool) is pool[0]
    assert retrieval_scorer("mof_water", pool) is pool[0]
    # No retriever covers solid_electrolyte, so seeds.py keeps its own path.
    assert retrieval_scorer("solid_electrolyte", pool) is None


def test_the_real_registry_routes_retrieval_by_domain():
    """Integration with whatever scorers are actually registered right now."""
    from athanor.loop.router import property_vocabulary, retrieval_scorer

    for domain in ("solid_electrolyte", "mof_water", "drug_stability"):
        scorer = retrieval_scorer(domain)
        if scorer is not None:
            assert domain in tuple(scorer.domains)
        # Every domain must offer intake something it can actually measure.
        assert property_vocabulary(domain), f"{domain} has no property vocabulary"


# --------------------------------------------------------------------------
# The repair round: a wholesale veto is a coordination failure, not a result
# --------------------------------------------------------------------------


VETO_ALL = {
    "vetoed": [
        {
            "candidate_id": "c-a",
            "category": "off_spec",
            "reason": "h1 needs the full oxide in framework B, not a 50% O/S intermediate.",
        },
        {
            "candidate_id": "c-b",
            "category": "off_spec",
            "reason": "P -> As changes the central cation, not the anion h1 compares.",
        },
    ],
    "commentary": (
        "Neither substituted partner is in this batch: h1 needs framework A sulfide "
        "(100% O->S on c-a) and framework B oxide (100% S->O on c-b)."
    ),
}

REPAIR_EDITS = {
    "crystal_edits": [
        {
            "parent_id": "c-a",
            "element_out": "Li",
            "element_in": "Na",
            "fraction": 1.0,
            "rationale": "Complete substitution: the end member h1 compares.",
        },
        {
            "parent_id": "c-b",
            "element_out": "Li",
            "element_in": "K",
            "fraction": 1.0,
            "rationale": "The other member of the same comparison.",
        },
    ],
    "molecular_edits": [],
    "commentary": "Both members of the comparison, at complete substitution.",
}

APPROVE_ALL = {"vetoed": [], "commentary": "Both members present; the comparison is testable."}


def _repair_campaign(tmp_path, scorer, *, second_review):
    """A round whose first batch is vetoed wholesale, then repaired."""
    client = FakeClient(
        # No edit reply here: `fake_propose` below stands in for the generator,
        # which is covered against the real `ClaudeGenerator` separately.
        structured=[INTAKE, HYPOTHESIS, VETO_ALL, second_review,
                    VERDICT, DECISION, PROPOSAL],
        prose=[
            "Hypothesis prose. " * 2,
            "Rejecting this batch. " * 2,
            "Reviewing the corrected batch. " * 2,
            "Verdict prose. " * 2,
            "Controller prose. " * 2,
            "Proposal prose. " * 2,
        ],
    )
    event_log = EventLog(tmp_path, "repair-campaign")
    campaign = Campaign(
        event_log, llm=LLM(client), router=Router([scorer]),
        config=CampaignConfig(rounds=1, max_candidates=4),
    )
    from athanor.loop.generator import apply_substitution as _sub

    seeds = [make_candidate("c-a", "Li2")]
    sibling = _sub(seeds[0], "Li", "Rb", 0.5, "c-b")
    sibling.provenance = C.Provenance(
        source="retrieval", database="materials_project", external_id="c-b"
    )
    seeds.append(sibling)

    async def fake_propose(spec, hypothesis, notebook, feedback=""):
        if feedback:
            # The real generator is exercised separately; here we assert the
            # feedback actually arrives and return a corrected batch.
            campaign._seen_feedback = feedback
            return [
                _sub(seeds[0], "Li", "Na", 1.0, "c-fix-1"),
                _sub(seeds[1], "Li", "K", 1.0, "c-fix-2"),
            ]
        for cand in seeds:
            cand.hypothesis_id = hypothesis.id
        return seeds

    campaign.generator.propose = fake_propose  # type: ignore[method-assign]
    return campaign, client


async def test_a_wholesale_veto_triggers_one_repair_round_that_can_be_scored(tmp_path):
    scorer = FakeScorer(
        {
            "c-fix-1": {"migration_barrier": 0.52, "energy_above_hull": 0.0},
            "c-fix-2": {"migration_barrier": 0.21, "energy_above_hull": 0.04},
        }
    )
    campaign, _ = _repair_campaign(tmp_path, scorer, second_review=APPROVE_ALL)
    await campaign.run("Find a solid lithium electrolyte.")

    reviews = [e.body for e in campaign.log.events if e.body.type == "skeptic.reviewed"]
    assert len(reviews) == 2, "the corrected batch must face the same review"
    assert reviews[0].approved_ids == []
    assert sorted(reviews[1].approved_ids) == ["c-fix-1", "c-fix-2"]

    # The repair is visible in the notebook, not silent.
    headings = [
        e.body.heading
        for e in campaign.log.events
        if e.body.type == "notebook.delta" and e.body.heading
    ]
    assert any("sent the batch back" in h for h in headings)

    # The Generator was told exactly why, including the reviewer's commentary.
    feedback = campaign._seen_feedback
    assert "50% O/S intermediate" in feedback
    assert "100% O->S" in feedback  # the commentary naming what was required
    assert "off_spec" in feedback

    # And the round now produces a real verdict off real measurements.
    assert campaign.ledger.measurements == 4
    verdict = next(
        e.body for e in campaign.log.events if e.body.type == "analyst.verdict"
    )
    assert verdict.verdict == "REFUTED"
    assert campaign.log.events[-1].body.type == "campaign.completed"


async def test_a_repair_that_is_also_rejected_does_not_lower_the_bar(tmp_path):
    """An honest INCONCLUSIVE beats a manufactured verdict."""
    campaign, _ = _repair_campaign(
        tmp_path, FakeScorer(SCORES), second_review=VETO_ALL_AGAIN
    )
    await campaign.run("Find a solid lithium electrolyte.")

    reviews = [e.body for e in campaign.log.events if e.body.type == "skeptic.reviewed"]
    assert len(reviews) == 2
    assert reviews[1].approved_ids == []
    # Nothing was scored, and the verdict is forced INCONCLUSIVE rather than
    # the REFUTED the scripted analyst asked for.
    assert not [e for e in campaign.log.events if e.body.type == "measurement.recorded"]
    verdict = next(
        e.body for e in campaign.log.events if e.body.type == "analyst.verdict"
    )
    assert verdict.verdict == "INCONCLUSIVE"
    assert campaign.log.events[-1].body.type == "campaign.completed"


VETO_ALL_AGAIN = {
    "vetoed": [
        {"candidate_id": "c-fix-1", "category": "off_spec", "reason": "still wrong"},
        {"candidate_id": "c-fix-2", "category": "off_spec", "reason": "still wrong"},
    ],
    "commentary": "The corrected batch still cannot inform the claim.",
}


async def test_no_repair_when_the_batch_already_passes(tmp_path):
    """One attempt per round, and none at all when it is not needed."""
    campaign, _ = seeded_campaign(tmp_path, FakeScorer(SCORES))
    await campaign.run("Find a solid lithium electrolyte.")
    reviews = [e.body for e in campaign.log.events if e.body.type == "skeptic.reviewed"]
    assert len(reviews) == 1


async def test_the_generator_is_given_the_hypothesis_batch_design(monkeypatch):
    """The root cause of the stall: the Generator could not see the batch design,
    so it proposed candidates that could not inform the claim."""
    from athanor.loop.generator import ClaudeGenerator

    _mock_mp(monkeypatch, {})  # no retrieval; this is the perturbation path
    client = FakeClient(structured=[SEED_QUERY, EDITS], prose=[])
    generator = ClaudeGenerator(LLM(client), lambda body: None)

    hypothesis = _hypothesis_naming_lgps()
    hypothesis.batch_plan.strategy = (
        "Score the full sulfide (100% O -> S on c-mp-1) against the full oxide "
        "in the same framework."
    )
    view = C.NotebookView(
        spec=make_spec(),
        hypotheses=[hypothesis],
        candidates={"c-mp-1": make_candidate("c-mp-1", "Li2")},
    )
    await generator.propose(make_spec(), hypothesis, view)

    prompt = client.structured_calls[-1]["messages"][0]["content"]
    assert hypothesis.batch_plan.strategy in prompt, "the strategy must be executable"
    assert "migration_barrier" in prompt  # batch_plan.properties
    assert hypothesis.falsification_criterion in prompt
    assert hypothesis.prediction in prompt
    assert "every member of every comparison" in prompt

    system = client.structured_calls[-1]["system"]
    assert "fraction` 1.0" in system  # complete substitution for a comparison
    assert "comparison measures nothing" in system


async def test_the_repair_pass_skips_retrieval_and_carries_the_feedback(monkeypatch):
    from athanor.loop.generator import ClaudeGenerator

    queried = _mock_mp(monkeypatch, {"Li-Ge-P-S": [_FakeMPEntry("mp-9", "X", 0.0, "K")]})
    client = FakeClient(structured=[EDITS], prose=[])
    emitted: list = []
    generator = ClaudeGenerator(LLM(client), emitted.append)

    view = C.NotebookView(
        spec=make_spec(), candidates={"c-mp-1": make_candidate("c-mp-1", "Li2")}
    )
    out = await generator.propose(
        make_spec(),
        _hypothesis_naming_lgps(),
        view,
        feedback="  REJECTED c-x — category: off_spec\n    reason: needs the full oxide",
    )

    assert queried == [], "a repair must answer the objections, not re-query the database"
    assert out and all(c.provenance.source == "perturbation" for c in out)
    prompt = client.structured_calls[-1]["messages"][0]["content"]
    assert "was REJECTED by the reviewer" in prompt
    assert "needs the full oxide" in prompt
    note = next(e for e in emitted if e.type == "notebook.delta")
    assert "corrected batch" in note.heading


async def test_decisive_property_is_measured_first_for_every_candidate(tmp_path):
    """A CI-NEB is 6-8 minutes, so a round that runs out of time must still have
    the comparison it exists to make, not one fully-scored candidate."""
    order: list[tuple[str, str]] = []

    def _tracking(cls_name, props, values):
        class Tracked(FakeScorer):
            name = cls_name
            properties = props

            async def score(self, candidates, spec):
                assert len(candidates) == 1, "scorers are invoked per candidate"
                order.append((self.name, candidates[0].id))
                return await super().score(candidates, spec)

        return Tracked(values)

    values = {
        "c-a": {"migration_barrier": 0.52, "band_gap": 2.8},
        "c-b": {"migration_barrier": 0.21, "band_gap": 3.0},
    }
    decisive = _tracking("slow-barrier", ("migration_barrier",), values)
    incidental = _tracking("cheap-extras", ("band_gap",), values)

    spec = make_spec()
    spec.objectives.append(
        C.Objective(property="band_gap", label="Band gap", direction="max", unit="eV")
    )
    campaign = Campaign(
        EventLog(tmp_path, "ordering"),
        llm=LLM(FakeClient(structured=[], prose=[])),
        # Registered incidental-first, so only the priority sort can reorder them.
        router=Router([incidental, decisive]),
    )
    candidates = [make_candidate("c-a", "Li2"), make_candidate("c-b", "Li3")]
    measurements, failures = await campaign._score(
        candidates, spec, ["migration_barrier"]
    )

    assert not failures
    decisive_calls = [i for i, (name, _) in enumerate(order) if name == "slow-barrier"]
    incidental_calls = [i for i, (name, _) in enumerate(order) if name == "cheap-extras"]
    assert len(decisive_calls) == 2 and len(incidental_calls) == 2
    # Every candidate's decisive measurement lands before any incidental one.
    assert max(decisive_calls) < min(incidental_calls), order
    assert [c for _, c in order[:2]] == ["c-a", "c-b"]

    # Measurements are emitted as each candidate finishes, not after the batch,
    # so an interrupted round keeps a partial comparison instead of nothing.
    kinds = [e.body.type for e in campaign.log.events]
    assert kinds.count("scoring.started") == 4
    assert kinds.index("measurement.recorded") < kinds.index("scoring.started", 2)
    assert len(measurements) == 4
    assert campaign.ledger.candidates_scored == 2
