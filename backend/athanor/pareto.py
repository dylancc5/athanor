"""Multi-objective Pareto ranking.

Used by the Controller to pick what to test next, and by the UI to draw the
frontier. Deterministic: ties are broken by candidate id.
"""

from __future__ import annotations

from .contracts import Measurement, Objective, ParetoPoint


def _signed(value: float, objective: Objective) -> float:
    """Rewrite every objective as "larger is better"."""
    if objective.direction == "max":
        return value
    if objective.direction == "min":
        return -value
    target = objective.target if objective.target is not None else 0.0
    return -abs(value - target)


def collect_values(
    measurements: list[Measurement], objectives: list[Objective]
) -> dict[str, dict[str, float]]:
    """candidate_id -> {property: value}, keeping the last value measured.

    A later measurement of the same property supersedes an earlier one, which
    is what we want when a cheap screen is followed by a more careful one.
    """
    wanted = {o.property for o in objectives}
    out: dict[str, dict[str, float]] = {}
    for m in measurements:
        if m.property in wanted:
            out.setdefault(m.candidate_id, {})[m.property] = m.value
    return out


def dominates(a: dict[str, float], b: dict[str, float], objectives: list[Objective]) -> bool:
    """True if `a` is at least as good as `b` everywhere and better somewhere."""
    better_somewhere = False
    for o in objectives:
        if o.property not in a or o.property not in b:
            return False
        av, bv = _signed(a[o.property], o), _signed(b[o.property], o)
        if av < bv:
            return False
        if av > bv:
            better_somewhere = True
    return better_somewhere


def rank(
    measurements: list[Measurement], objectives: list[Objective]
) -> list[ParetoPoint]:
    """Non-dominated sort. rank 0 is the frontier, 1 the next shell, and so on.

    Candidates missing any objective are excluded — ranking on partial data
    would silently reward whichever candidate happened to be measured least.
    """
    values = collect_values(measurements, objectives)
    complete = {
        cid: v for cid, v in values.items() if all(o.property in v for o in objectives)
    }
    if not complete:
        return []

    # Normalize each objective to 0..1 across the measured set for the scalar score.
    spans: dict[str, tuple[float, float]] = {}
    for o in objectives:
        signed = [_signed(v[o.property], o) for v in complete.values()]
        spans[o.property] = (min(signed), max(signed))
    total_weight = sum(abs(o.weight) for o in objectives) or 1.0

    def scalar(v: dict[str, float]) -> float:
        acc = 0.0
        for o in objectives:
            lo, hi = spans[o.property]
            s = _signed(v[o.property], o)
            norm = 1.0 if hi - lo < 1e-12 else (s - lo) / (hi - lo)
            acc += o.weight * norm
        return acc / total_weight

    remaining = dict(complete)
    points: list[ParetoPoint] = []
    shell = 0
    while remaining:
        front = [
            cid
            for cid, v in remaining.items()
            if not any(
                dominates(other, v, objectives) for ocid, other in remaining.items() if ocid != cid
            )
        ]
        if not front:  # cyclic domination is impossible, but never loop forever
            front = sorted(remaining)
        for cid in sorted(front):
            points.append(
                ParetoPoint(
                    candidate_id=cid,
                    rank=shell,
                    values=dict(remaining[cid]),
                    scalar_score=round(scalar(remaining[cid]), 6),
                )
            )
        for cid in front:
            remaining.pop(cid, None)
        shell += 1

    points.sort(key=lambda p: (p.rank, -p.scalar_score, p.candidate_id))
    return points


def frontier(points: list[ParetoPoint]) -> list[ParetoPoint]:
    return [p for p in points if p.rank == 0]
