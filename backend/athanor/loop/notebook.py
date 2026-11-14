"""`NotebookView` as a pure function of the event log.

There is deliberately no second copy of campaign state anywhere: whatever the
agents are shown is derived from the same append-only log the UI renders, so a
replayed campaign hands its agents exactly the context the live one had.
"""

from __future__ import annotations

from ..contracts import Event, EventBody, NotebookView, Spec


def _bodies(events: list[Event] | list[EventBody]) -> list[EventBody]:
    return [e.body if isinstance(e, Event) else e for e in events]


def build_notebook(events: list[Event] | list[EventBody]) -> NotebookView:
    """Fold the log into the read-only snapshot the agents reason over.

    Raises if no `spec.created` has been seen — nothing can be reasoned about
    before there is a spec.
    """
    spec: Spec | None = None
    view_kwargs: dict = {
        "hypotheses": [],
        "verdicts": {},
        "verdict_reasoning": {},
        "heuristics": [],
        "candidates": {},
        "measurements": [],
        "vetoes": [],
        "pareto": [],
    }
    seen_heuristics: set[str] = set()

    for body in _bodies(events):
        kind = body.type
        if kind == "spec.created":
            spec = body.spec
        elif kind == "hypothesis.proposed":
            view_kwargs["hypotheses"].append(body.hypothesis)
        elif kind == "candidates.generated":
            for cand in body.candidates:
                view_kwargs["candidates"][cand.id] = cand
        elif kind == "skeptic.reviewed":
            view_kwargs["vetoes"].extend(body.vetoes)
        elif kind == "measurement.recorded":
            view_kwargs["measurements"].append(body.measurement)
        elif kind == "pareto.updated":
            view_kwargs["pareto"] = list(body.points)
        elif kind == "analyst.verdict":
            view_kwargs["verdicts"][body.hypothesis_id] = body.verdict
            view_kwargs["verdict_reasoning"][body.hypothesis_id] = body.reasoning
            for heu in body.heuristics:
                if heu.id not in seen_heuristics:
                    seen_heuristics.add(heu.id)
                    view_kwargs["heuristics"].append(heu)

    if spec is None:
        raise ValueError("event log has no spec.created event")
    return NotebookView(spec=spec, **view_kwargs)
