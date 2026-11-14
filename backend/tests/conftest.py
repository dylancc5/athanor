"""Test fixtures: a scripted fake LLM and fake scorers.

Nothing here ever reaches the network. The fake LLM is injected into the real
`LLM` wrapper's seat rather than monkeypatching SDK internals, so the code under
test is exactly the production code path.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable

import pytest

from athanor import contracts as C


class FakeStream:
    """Mimics `client.messages.stream(...)`'s async context manager."""

    def __init__(self, text: str, usage: object):
        self._text = text
        self._usage = usage

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        chunks = [self._text[i : i + 24] for i in range(0, len(self._text), 24)] or [""]

        async def gen():
            for chunk in chunks:
                yield chunk

        return gen()

    async def get_final_message(self):
        return FakeMessage(self._text, self._usage)


class FakeUsage:
    input_tokens = 1200
    output_tokens = 300


class FakeMessage:
    stop_reason = "end_turn"
    stop_details = None

    def __init__(self, text: str, usage: object):
        self.content = [FakeTextBlock(text)]
        self.usage = usage


class FakeTextBlock:
    type = "text"

    def __init__(self, text: str):
        self.text = text


class FakeMessages:
    def __init__(self, owner: FakeClient):
        self.owner = owner

    async def create(self, **kwargs):
        text = self.owner.next_structured(kwargs)
        return FakeMessage(text, FakeUsage())

    def stream(self, **kwargs):
        text = self.owner.next_prose(kwargs)
        return FakeStream(text, FakeUsage())


class FakeClient:
    """A scripted Anthropic client.

    `structured` is a list of objects (serialized to JSON in order) and `prose`
    a list of strings. Both are consumed in call order; running out is an error,
    because a silently reused reply hides a missing call.
    """

    def __init__(self, structured: Iterable[object], prose: Iterable[str]):
        self.structured_queue = list(structured)
        self.prose_queue = list(prose)
        self.structured_calls: list[dict] = []
        self.prose_calls: list[dict] = []
        self.messages = FakeMessages(self)

    def next_structured(self, kwargs: dict) -> str:
        self.structured_calls.append(kwargs)
        if not self.structured_queue:
            raise AssertionError(
                f"unexpected structured call #{len(self.structured_calls)} "
                f"to {kwargs.get('model')}"
            )
        value = self.structured_queue.pop(0)
        return value if isinstance(value, str) else json.dumps(value)

    def next_prose(self, kwargs: dict) -> str:
        self.prose_calls.append(kwargs)
        if not self.prose_queue:
            raise AssertionError(f"unexpected streaming call #{len(self.prose_calls)}")
        return self.prose_queue.pop(0)


class FakeScorer:
    """A scorer that returns fixed measurements. Tests only — never production.

    It also demonstrates the honest-failure path: any candidate id in `fail`
    is reported in `ScoreResult.failed` instead of being given a value.
    """

    name = "fake-scorer"
    domains: tuple[C.Domain, ...] = ("solid_electrolyte",)
    properties: tuple[str, ...] = ("migration_barrier", "energy_above_hull")

    def __init__(
        self,
        values: dict[str, dict[str, float]] | None = None,
        fail: dict[str, str] | None = None,
        *,
        raises: bool = False,
        artifacts: bool = False,
    ):
        self.values = values or {}
        self.fail = fail or {}
        self.raises = raises
        self.artifacts = artifacts
        self.calls: list[list[str]] = []

    async def score(self, candidates: list[C.Candidate], spec: C.Spec) -> C.ScoreResult:
        self.calls.append([c.id for c in candidates])
        if self.raises:
            raise RuntimeError("worker exploded")
        result = C.ScoreResult()
        for cand in candidates:
            if cand.id in self.fail:
                result.failed[cand.id] = self.fail[cand.id]
                continue
            for prop, value in self.values.get(cand.id, {}).items():
                result.measurements.append(
                    C.Measurement(
                        candidate_id=cand.id,
                        property=prop,
                        value=value,
                        unit="eV" if prop == "migration_barrier" else "eV/atom",
                        source=self.name,
                        method="scripted test value",
                        confidence=0.7,
                    )
                )
            if self.artifacts:
                result.artifacts.append(
                    (
                        C.Artifact(
                            id=f"a-{cand.id}",
                            candidate_id=cand.id,
                            kind="relaxation_trajectory",
                            label=f"{cand.name} relaxation",
                            uri=f"artifacts/a-{cand.id}.json",
                        ),
                        {"symbols": ["Li"], "cell": None, "pbc": False,
                         "frames": [[[0.0, 0.0, 0.0]]], "energies": [-1.0]},
                    )
                )
        return result


def cif_text() -> str:
    """A real (tiny) CIF, written by ASE rather than by hand."""
    from ase.build import bulk

    from athanor.structure import atoms_to_cif

    return atoms_to_cif(bulk("Li", "bcc", a=3.49, cubic=True) * (2, 1, 1))


def make_candidate(cid: str, name: str = "Li2") -> C.Candidate:
    return C.Candidate(
        id=cid,
        name=name,
        formula=name,
        structure=cif_text(),
        repr_kind="cif",
        domain="solid_electrolyte",
        provenance=C.Provenance(
            source="retrieval", database="materials_project", external_id=cid
        ),
    )


def make_spec() -> C.Spec:
    return C.Spec(
        goal="Find a solid lithium conductor that survives a lithium metal anode.",
        title="Solid-state Li conductor",
        domain="solid_electrolyte",
        objectives=[
            C.Objective(
                property="migration_barrier",
                label="Li migration barrier",
                direction="min",
                unit="eV",
                weight=2.0,
            ),
            C.Objective(
                property="energy_above_hull",
                label="Energy above hull",
                direction="min",
                unit="eV/atom",
            ),
        ],
        constraints=[
            C.Constraint(
                property="elements",
                op="not_in",
                value=["Co"],
                description="Avoid cobalt",
            )
        ],
        seed_strategy="Materials Project near-hull Li phases",
    )


@pytest.fixture(autouse=True)
def _reset_sse():
    """sse-starlette keeps a module-level exit event bound to one event loop."""
    try:
        from sse_starlette.sse import AppStatus

        AppStatus.should_exit_event = None
    except Exception:  # noqa: BLE001  # older/newer layouts simply skip this
        logging.getLogger(__name__).debug("could not reset sse-starlette app status")
    yield
