"""Scorer registry access and domain -> scorer routing.

The registry is imported lazily and defensively: the scorers land in a
different workstream, and the app must still boot (and the UI must still
replay recorded campaigns) when `athanor.scorers.registry` does not exist yet.

Routing rule: a scorer runs on a candidate when the candidate's `domain` is one
the scorer declares, and the scorer measures at least one property the spec
actually cares about. Several scorers usually apply to one candidate (one for
the barrier, another for the hull energy) and their results are merged.
"""

from __future__ import annotations

import logging
from typing import Any

from ..contracts import Candidate, Domain, Scorer, Spec

log = logging.getLogger("athanor.router")

#: Fallback property vocabulary, used only when the scorer registry is absent.
#: It is what the intake agent is allowed to write into `Objective.property`,
#: so the keys here must match the keys the scorers emit — otherwise routing
#: finds no intersection and nothing gets scored. The real vocabulary comes
#: from `all_scorers()` as soon as the registry exists.
FALLBACK_PROPERTIES: dict[Domain, list[tuple[str, str]]] = {
    "solid_electrolyte": [
        ("migration_barrier", "eV"),
        ("energy_above_hull", "eV/atom"),
        ("band_gap", "eV"),
        ("energy_per_atom", "eV/atom"),
    ],
    "mof_water": [
        ("water_uptake", "g/g"),
        ("regeneration_energy", "kJ/mol"),
        ("framework_stability", "eV/atom"),
        ("void_fraction", "dimensionless"),
    ],
    "drug_stability": [
        ("lattice_energy", "eV"),
        ("binding_affinity", "kcal/mol"),
        ("solubility_logs", "log10(mol/L)"),
        ("degradation_susceptibility", "eV"),
    ],
}


def all_scorers() -> list[Scorer]:
    """Every registered scorer, or `[]` while the registry has not landed."""
    try:
        from ..scorers.registry import all_scorers as _all  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001 — absence is an expected state
        log.info("scorer registry unavailable (%s); running with no scorers", exc)
        return []
    try:
        return list(_all())
    except Exception as exc:  # noqa: BLE001
        log.warning("scorer registry raised: %s; running with no scorers", exc)
        return []


def scorers_for_domain(domain: Domain, scorers: list[Scorer] | None = None) -> list[Scorer]:
    pool = all_scorers() if scorers is None else scorers
    return [s for s in pool if domain in tuple(s.domains)]


def property_vocabulary(
    domain: Domain, scorers: list[Scorer] | None = None
) -> list[tuple[str, str]]:
    """`(property, unit)` pairs the intake agent may use for `domain`.

    Units are only known for the fallback set — a scorer protocol exposes
    property names, not units — so a property contributed by a scorer that is
    not in the fallback table is offered with an unknown unit and the intake
    agent is asked to supply the physical unit itself.
    """
    known = dict(FALLBACK_PROPERTIES.get(domain, []))
    domain_scorers = scorers_for_domain(domain, scorers)
    if not domain_scorers:
        return list(known.items())
    out: dict[str, str] = {}
    for scorer in domain_scorers:
        for prop in tuple(scorer.properties):
            out[prop] = known.get(prop, "")
    return sorted(out.items())


def retrieval_scorer(scorers: list[Scorer] | None = None) -> Any | None:
    """A registry entry that can retrieve seed candidates, if one exists.

    Duck-typed on purpose: the `Scorer` protocol has no retrieval method, so
    the contract we look for is an awaitable `retrieve(spec, n) -> [Candidate]`.
    """
    pool = all_scorers() if scorers is None else scorers
    for scorer in pool:
        if callable(getattr(scorer, "retrieve", None)):
            return scorer
    return None


class Router:
    """Maps candidates to the scorers that should measure them."""

    def __init__(self, scorers: list[Scorer] | None = None):
        self.scorers = all_scorers() if scorers is None else list(scorers)

    def wanted_properties(self, spec: Spec) -> set[str]:
        return {o.property for o in spec.objectives} | {
            c.property for c in spec.constraints
        }

    def route(self, candidate: Candidate, spec: Spec) -> list[Scorer]:
        wanted = self.wanted_properties(spec)
        return [
            s
            for s in self.scorers
            if candidate.domain in tuple(s.domains) and (set(s.properties) & wanted)
        ]

    def plan(self, candidates: list[Candidate], spec: Spec) -> dict[str, list[Candidate]]:
        """scorer name -> the candidates it should run on (batched per scorer)."""
        batches: dict[str, list[Candidate]] = {}
        for cand in candidates:
            for scorer in self.route(cand, spec):
                batches.setdefault(scorer.name, []).append(cand)
        return batches

    def by_name(self, name: str) -> Scorer:
        for s in self.scorers:
            if s.name == name:
                return s
        raise KeyError(name)
