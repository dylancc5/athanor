"""Scorer discovery.

Shared by more than one author, so it stays small and defensive: every scorer is
imported *and* constructed inside its own try/except, and a failure is logged
and skipped. A half-finished scorer module must never stop the rest of the
platform from running.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from ..contracts import Domain, Scorer

log = logging.getLogger(__name__)


def _atomistic() -> Any:
    from .atomistic import AtomisticScorer

    return AtomisticScorer()


def _molecular() -> Any:
    from .molecular import MolecularScorer

    return MolecularScorer()


# Add an entry per scorer. Order is the order they are offered to the loop.
BUILDERS: list[tuple[str, Callable[[], Any]]] = [
    ("atomistic", _atomistic),
    ("molecular", _molecular),
]


def all_scorers() -> list[Scorer]:
    """Every scorer that could be imported and constructed."""
    scorers: list[Any] = []
    for name, build in BUILDERS:
        try:
            scorers.append(build())
        except Exception:  # noqa: BLE001 — one broken scorer must not hide the others
            log.exception("scorer %r unavailable; skipping", name)
    return scorers


def scorers_for_domain(domain: Domain) -> list[Scorer]:
    return [s for s in all_scorers() if domain in getattr(s, "domains", ())]
