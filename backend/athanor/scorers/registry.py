"""Scorer discovery.

Shared by more than one author, so it stays small and defensive: every scorer is
imported *and* constructed inside its own try/except, and a failure is logged
and skipped. A half-finished scorer module must never stop the rest of the
platform from running.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..contracts import Domain, Scorer

log = logging.getLogger(__name__)


def _atomistic() -> Any:
    from .atomistic import AtomisticScorer

    return AtomisticScorer()


def _gfn2_xtb() -> Any:
    from .molecular import Gfn2XtbScorer

    return Gfn2XtbScorer()


def _odac23() -> Any:
    from .molecular import Odac23Scorer

    return Odac23Scorer()


def _rdkit() -> Any:
    from .molecular import RdkitScorer

    return RdkitScorer()


def _retrieval() -> Any:
    from .molecular import RetrievalScorer

    return RetrievalScorer()


# Add an entry per scorer. Order is the order they are offered to the loop.
BUILDERS: list[tuple[str, Callable[[], Any]]] = [
    ("atomistic", _atomistic),
    ("gfn2-xtb", _gfn2_xtb),
    ("odac23", _odac23),
    ("rdkit", _rdkit),
    ("retrieval", _retrieval),
]


def all_scorers() -> list[Scorer]:
    """Every scorer that could be imported and constructed."""
    scorers: list[Any] = []
    for name, build in BUILDERS:
        try:
            scorers.append(build())
        except Exception:
            log.exception("scorer %r unavailable; skipping", name)
    return scorers


def scorers_for_domain(domain: Domain) -> list[Scorer]:
    return [s for s in all_scorers() if domain in getattr(s, "domains", ())]
