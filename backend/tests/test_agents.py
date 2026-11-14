"""Agent-level tests. No network: a scripted `FakeClient` stands in for Claude."""

from __future__ import annotations

from typing import ClassVar

import pytest

from athanor import contracts as C
from athanor.agents.analyst import decisive_measurements, run_analyst
from athanor.agents.controller import run_controller
from athanor.agents.intake import run_intake
from athanor.agents.proposal import run_proposal
from athanor.agents.skeptic import find_duplicates, run_skeptic
from athanor.agents.strategist import run_strategist
from athanor.llm import LLM, LLMError, LLMRefusal, json_schema_for
from athanor.loop.notebook import build_notebook

from .conftest import FakeClient, make_candidate, make_spec


def collector():
    events: list[C.EventBody] = []
    return events, events.append


def view_with(spec: C.Spec, **kwargs) -> C.NotebookView:
    return C.NotebookView(spec=spec, **kwargs)


# --------------------------------------------------------------------------
# llm.py
# --------------------------------------------------------------------------


def test_schema_is_strict_and_has_no_unsupported_constraints():
    from athanor.agents.intake import SpecDraft

    schema = json_schema_for(SpecDraft)

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node.get("additionalProperties") is False
            for banned in ("minimum", "maximum", "minLength", "multipleOf"):
                assert banned not in node
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(schema)


async def test_structured_rejects_a_reply_that_does_not_match():
    from pydantic import BaseModel

    class Shape(BaseModel):
        n: int

    usage: list[tuple[int, int]] = []
    llm = LLM(FakeClient(structured=[{"n": "not a number"}], prose=[]),
              on_usage=lambda i, o: usage.append((i, o)))
    with pytest.raises(LLMError):
        await llm.structured(Shape, system="s", prompt="p")
    # The call is still billed, so it is still counted.
    assert usage == [(1200, 300)]


async def test_refusal_is_raised_before_content_is_read():
    class Refused:
        stop_reason = "refusal"

        class stop_details:
            category = "cyber"
            explanation = "declined"

        content: ClassVar[list] = []
        usage = None

    class Client:
        class messages:
            @staticmethod
            async def create(**kwargs):
                return Refused()

    from pydantic import BaseModel

    class Shape(BaseModel):
        n: int

    with pytest.raises(LLMRefusal) as exc:
        await LLM(Client()).structured(Shape, system="s", prompt="p")
    assert exc.value.category == "cyber"


# --------------------------------------------------------------------------
# intake
# --------------------------------------------------------------------------


async def test_intake_builds_a_spec_and_drops_unmeasurable_objectives():
    draft = {
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
                # Not in any scorer's vocabulary: must be dropped, never remapped.
                "property": "ionic_conductivity_at_room_temperature",
                "label": "Conductivity",
                "direction": "max",
                "target": None,
                "weight": 1.0,
                "unit": "S/cm",
            },
        ],
        "constraints": [
            {
                "property": "elements",
                "op": "not_in",
                "numeric_value": None,
                "list_value": ["Co", "Ni"],
                "description": "Avoid cobalt and nickel",
            },
            {
                # Numeric op with no numeric value: dropped rather than guessed.
                "property": "energy_above_hull",
                "op": "<=",
                "numeric_value": None,
                "list_value": [],
                "description": "Near the hull",
            },
        ],
        "seed_strategy": "Materials Project Li sulfides and halides near the hull",
    }
    llm = LLM(FakeClient(structured=[draft], prose=[]))
    spec = await run_intake(llm, "Find a solid lithium electrolyte.")

    assert spec.domain == "solid_electrolyte"
    assert [o.property for o in spec.objectives] == ["migration_barrier"]
    assert spec.objectives[0].direction == "min"
    assert spec.objectives[0].unit == "eV"
    assert [c.value for c in spec.constraints] == [["Co", "Ni"]]
    assert spec.goal == "Find a solid lithium electrolyte."


async def test_intake_raises_when_nothing_is_measurable():
    draft = {
        "title": "Impossible",
        "domain": "solid_electrolyte",
        "objectives": [
            {
                "property": "vibes",
                "label": "Vibes",
                "direction": "max",
                "target": None,
                "weight": 1.0,
                "unit": "none",
            }
        ],
        "constraints": [],
        "seed_strategy": "nowhere",
    }
    llm = LLM(FakeClient(structured=[draft], prose=[]))
    with pytest.raises(LLMError):
        await run_intake(llm, "Make something nice.")


# --------------------------------------------------------------------------
# strategist
# --------------------------------------------------------------------------


async def test_strategist_hypothesis_is_decided_by_real_objectives():
    spec = make_spec()
    draft = {
        "statement": "Halide substitution on the anion sublattice lowers the Li barrier.",
        "rationale": "Larger, more polarizable anions widen the migration channel.",
        "prediction": "Barrier drops below 0.30 eV at 25% Cl.",
        "falsification_criterion": "If no substituted candidate measures below 0.30 eV, refuted.",
        "batch_plan": {
            "n_candidates": 99,  # must be clamped
            "strategy": "Substitute Cl for S at increasing fractions.",
            "properties": ["migration_barrier", "a_property_nobody_measures"],
        },
        "builds_on_hypothesis_id": "does-not-exist",
    }
    events, emit = collector()
    llm = LLM(FakeClient(structured=[draft], prose=["Thinking about anion size. " * 4]))
    h = await run_strategist(
        llm, emit, view_with(spec), round_number=1, hypothesis_id="h1", max_candidates=4
    )

    assert h.id == "h1" and h.round == 1 and h.branch == "main"
    assert h.parent_id is None  # an unknown parent id is dropped, not invented
    assert h.batch_plan.n_candidates == 4
    assert h.batch_plan.properties == ["migration_barrier"]
    deltas = [e for e in events if e.type == "notebook.delta"]
    assert deltas and deltas[0].heading == "Round 1 — hypothesis"
    assert deltas[0].author == "strategist"
    assert all(d.heading is None for d in deltas[1:])


# --------------------------------------------------------------------------
# skeptic
# --------------------------------------------------------------------------


async def test_skeptic_vetoes_and_approved_ids_are_disjoint_subsets():
    spec = make_spec()
    candidates = [make_candidate("c-1"), make_candidate("c-2", "Li2b")]
    # Make them distinct structures so the duplicate detector stays quiet.
    candidates[1].structure = candidates[1].structure.replace("Li", "Na", 1)

    draft = {
        "vetoed": [
            {"candidate_id": "c-2", "category": "OOD", "reason": "Na is outside the model."},
            {"candidate_id": "c-nonexistent", "category": "ood", "reason": "ghost"},
            {"candidate_id": "c-2", "category": "duplicate", "reason": "repeat veto"},
        ],
        "commentary": "Barriers on c-1 should be read as upper bounds.",
    }
    _events, emit = collector()
    llm = LLM(FakeClient(structured=[draft], prose=["Checking each candidate. " * 3]))
    approved, vetoes, commentary = await run_skeptic(
        llm, emit, view_with(spec), candidates, hypothesis_id="h1", round_number=1
    )

    assert approved == ["c-1"]
    assert [v.candidate_id for v in vetoes] == ["c-2"]
    assert vetoes[0].category == "ood"  # case-normalized
    assert set(approved) & {v.candidate_id for v in vetoes} == set()
    assert "upper bounds" in commentary


async def test_skeptic_duplicate_veto_is_added_even_if_the_model_misses_it():
    spec = make_spec()
    existing = make_candidate("c-old")
    clone = make_candidate("c-new")
    clone.structure = existing.structure
    clone.formula = existing.formula

    draft = {"vetoed": [], "commentary": "Looks fine to me."}
    _events, emit = collector()
    llm = LLM(FakeClient(structured=[draft], prose=["All good. "]))
    approved, vetoes, _ = await run_skeptic(
        llm,
        emit,
        view_with(spec, candidates={"c-old": existing}),
        [clone],
        hypothesis_id="h1",
        round_number=2,
    )
    assert approved == []
    assert vetoes[0].category == "duplicate" and vetoes[0].candidate_id == "c-new"


def test_find_duplicates_only_matches_exactly():
    a, b = make_candidate("c-1"), make_candidate("c-2")
    assert find_duplicates([b], {"c-1": a}) == {"c-2": "c-1"}
    b.structure = b.structure.replace("Li", "Na", 1)
    assert find_duplicates([b], {"c-1": a}) == {}


# --------------------------------------------------------------------------
# analyst
# --------------------------------------------------------------------------


def _hypothesis() -> C.Hypothesis:
    return C.Hypothesis(
        id="h1",
        round=1,
        statement="Lower energy above hull predicts a lower migration barrier.",
        rationale="Order gives clean channels.",
        prediction="Spearman rho > 0.5.",
        falsification_criterion="If the most stable candidate is not the lowest barrier, refuted.",
        batch_plan=C.BatchPlan(
            n_candidates=2,
            strategy="Score every seed.",
            properties=["migration_barrier", "energy_above_hull"],
        ),
    )


def _measurement(cid: str, prop: str, value: float) -> C.Measurement:
    return C.Measurement(
        candidate_id=cid,
        property=prop,
        value=value,
        unit="eV" if prop == "migration_barrier" else "eV/atom",
        source="fake-scorer",
        confidence=0.7,
    )


async def test_analyst_returns_refuted_and_writes_heuristics():
    spec = make_spec()
    h = _hypothesis()
    measurements = [
        _measurement("c-1", "migration_barrier", 0.52),
        _measurement("c-1", "energy_above_hull", 0.0),
        _measurement("c-2", "migration_barrier", 0.21),
        _measurement("c-2", "energy_above_hull", 0.04),
    ]
    draft = {
        "verdict": "refuted",
        "reasoning": "The most stable candidate has the higher barrier, meeting the criterion.",
        "evidence": [
            "c-1 sits at 0.000 eV/atom above hull with a barrier of 0.52 eV.",
            "c-2 sits at 0.040 eV/atom above hull with a barrier of 0.21 eV.",
        ],
        "heuristics": [
            {"text": "Score both axes; stability does not predict mobility here.",
             "strength": "ESTABLISHED"},
            {"text": "Treat sub-0.1 eV barrier gaps as noise.", "strength": "guesswork"},
        ],
    }
    _events, emit = collector()
    llm = LLM(FakeClient(structured=[draft], prose=["Applying the criterion. " * 3]))
    verdict, _reasoning, evidence, heuristics = await run_analyst(
        llm,
        emit,
        view_with(spec, hypotheses=[h], measurements=measurements),
        h,
        round_measurements=measurements,
        candidate_ids={"c-1", "c-2"},
        failures={},
        round_number=1,
        heuristic_prefix="heu-h1",
    )

    assert verdict == "REFUTED"
    assert len(evidence) == 2 and "0.52 eV" in evidence[0]
    assert [x.id for x in heuristics] == ["heu-h1-1", "heu-h1-2"]
    assert heuristics[0].strength == "established"
    assert heuristics[1].strength == "tentative"  # unknown strength is not promoted
    assert all(x.learned_from == "h1" for x in heuristics)


async def test_analyst_is_forced_inconclusive_without_decisive_data():
    """The honesty guard: no decisive measurement, no verdict — whatever the model says."""
    spec = make_spec()
    h = _hypothesis()
    draft = {
        "verdict": "SUPPORTED",
        "reasoning": "It all looks very promising.",
        "evidence": ["vibes"],
        "heuristics": [],
    }
    _events, emit = collector()
    llm = LLM(FakeClient(structured=[draft], prose=["No data arrived. "]))
    verdict, _, _, _ = await run_analyst(
        llm,
        emit,
        view_with(spec, hypotheses=[h]),
        h,
        round_measurements=[],
        candidate_ids={"c-1"},
        failures={"c-1": "worker timed out"},
        round_number=1,
    )
    assert verdict == "INCONCLUSIVE"


def test_decisive_measurements_filters_by_property_and_candidate():
    h = _hypothesis()
    ms = [
        _measurement("c-1", "migration_barrier", 0.3),
        _measurement("c-1", "band_gap", 3.0),
        _measurement("c-off", "migration_barrier", 0.1),
    ]
    got = decisive_measurements(h, ms, {"c-1"})
    assert [(m.candidate_id, m.property) for m in got] == [("c-1", "migration_barrier")]


# --------------------------------------------------------------------------
# controller & proposal
# --------------------------------------------------------------------------


async def test_controller_converges_when_no_rounds_remain():
    spec = make_spec()
    h = _hypothesis()
    draft = {"action": "branch", "reasoning": "Two ideas left.",
             "branch_names": ["halide", "oxide"]}
    _events, emit = collector()
    llm = LLM(FakeClient(structured=[draft], prose=["Deciding. "]))
    decision = await run_controller(
        llm, emit, view_with(spec), h, "REFUTED", round_number=3, rounds_remaining=0
    )
    assert decision.action == "converge" and decision.branches == []


async def test_controller_branch_needs_two_arms():
    spec = make_spec()
    draft = {"action": "branch", "reasoning": "One idea.", "branch_names": ["halide"]}
    _events, emit = collector()
    llm = LLM(FakeClient(structured=[draft], prose=["Deciding. "]))
    decision = await run_controller(
        llm, emit, view_with(spec), _hypothesis(), "REFUTED",
        round_number=1, rounds_remaining=2,
    )
    assert decision.action == "continue"


async def test_proposal_appends_the_capability_boundary_caveat():
    spec = make_spec()
    draft = {
        "title": "Measure the trade-off directly",
        "summary": "The stability shortcut was refuted.",
        "lead_candidate_ids": ["c-1", "c-imaginary"],
        "synthesis_route": ["Ball-mill Li2S and P2S5 in argon.", ""],
        "validation_protocol": ["EIS from 25 to 100 C."],
        "falsification_criteria": ["An activation energy above 0.40 eV refutes the ranking."],
        "caveats": ["The band gap is a proxy for the electrochemical window."],
    }
    _events, emit = collector()
    llm = LLM(FakeClient(structured=[draft], prose=["Writing it up. " * 3]))
    proposal = await run_proposal(
        llm, emit, view_with(spec, candidates={"c-1": make_candidate("c-1")})
    )

    assert proposal.lead_candidate_ids == ["c-1"]  # unknown ids dropped
    assert proposal.synthesis_route == ["Ball-mill Li2S and P2S5 in argon."]
    assert len(proposal.caveats) == 2
    assert "picoseconds" in proposal.caveats[-1]


async def test_proposal_keeps_the_models_own_boundary_caveat():
    spec = make_spec()
    draft = {
        "title": "t",
        "summary": "s",
        "lead_candidate_ids": [],
        "synthesis_route": ["step"],
        "validation_protocol": ["measure"],
        "falsification_criteria": ["above 0.4 eV"],
        "caveats": [
            ("These models reach a few hundred atoms over picoseconds and say nothing "
            "about grain boundaries.")
        ],
    }
    _events, emit = collector()
    llm = LLM(FakeClient(structured=[draft], prose=["Writing. "]))
    proposal = await run_proposal(llm, emit, view_with(spec))
    assert len(proposal.caveats) == 1


# --------------------------------------------------------------------------
# notebook
# --------------------------------------------------------------------------


def test_build_notebook_is_a_pure_fold_of_the_log():
    spec = make_spec()
    cand = make_candidate("c-1")
    h = _hypothesis()
    bodies: list[C.EventBody] = [
        C.CampaignStarted(goal=spec.goal),
        C.SpecCreated(spec=spec),
        C.RoundStarted(round=1),
        C.HypothesisProposed(hypothesis=h),
        C.CandidatesGenerated(hypothesis_id="h1", candidates=[cand]),
        C.SkepticReviewed(
            hypothesis_id="h1",
            approved_ids=["c-1"],
            vetoes=[C.Veto(candidate_id="c-x", category="ood", reason="r")],
            commentary="c",
        ),
        C.MeasurementRecorded(measurement=_measurement("c-1", "migration_barrier", 0.3)),
        C.AnalystVerdict(
            hypothesis_id="h1",
            verdict="REFUTED",
            reasoning="because",
            evidence=["0.3 eV"],
            heuristics=[
                C.Heuristic(id="heu-1", text="t", learned_from="h1", strength="tentative")
            ],
        ),
        # A repeated verdict must not duplicate the heuristic.
        C.AnalystVerdict(
            hypothesis_id="h1",
            verdict="REFUTED",
            reasoning="because",
            evidence=[],
            heuristics=[
                C.Heuristic(id="heu-1", text="t", learned_from="h1", strength="tentative")
            ],
        ),
    ]
    view = build_notebook(bodies)
    assert view.spec.title == spec.title
    assert list(view.candidates) == ["c-1"]
    assert view.verdicts == {"h1": "REFUTED"}
    assert [x.id for x in view.heuristics] == ["heu-1"]
    assert len(view.measurements) == 1
    assert [v.candidate_id for v in view.vetoes] == ["c-x"]


def test_build_notebook_requires_a_spec():
    with pytest.raises(ValueError):
        build_notebook([C.CampaignStarted(goal="g")])
