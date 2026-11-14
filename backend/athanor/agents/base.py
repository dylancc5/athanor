"""Shared machinery for the Claude-backed agents.

Two things live here.

**Notebook rendering.** Agents are shown a compact table, never
`NotebookView.model_dump_json()` — candidates carry full CIFs, so dumping the
view would cost kilobytes per candidate on every call and bury the numbers that
matter. Every measurement is rendered with its `confidence`, `ood_flag` and
`is_proxy` so the models can discount weak evidence instead of treating all
numbers as equal.

**Reason, then format.** Each judgement is two calls: a streamed prose call that
fills the Lab Notebook live (the demo moment), then a cheap structured call that
transcribes *that prose* into the typed record. The reasoning happens once, in
the open, and the structured step is explicitly forbidden from introducing
claims the prose did not make — so what the UI shows and what the event log says
cannot drift apart.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from pydantic import BaseModel

from ..contracts import (
    Candidate,
    EventBody,
    Measurement,
    NotebookDelta,
    NotebookView,
    Spec,
)
from ..llm import OPUS, LLM, Effort

Emit = Callable[[EventBody], object]
T = TypeVar("T", bound=BaseModel)

#: Prepended to every agent's system prompt. The product is only worth
#: anything if these hold.
HONESTY = """\
You are one agent in ATHANOR, an autonomous materials- and molecule-discovery
platform that is judged on scientific honesty, not on optimism.

Non-negotiable rules:
- Reason ONLY from measurements present in the notebook you are given. Never
  invent, estimate, interpolate or "expect" a number. If the evidence you need
  is absent, say "insufficient data" and say exactly which measurement is
  missing.
- Every measurement carries a confidence, and may be flagged `proxy` (it stands
  in for the property we actually care about) or `OOD` (out of distribution —
  the model was asked to extrapolate). Weigh those flags explicitly.
- The underlying physics models reach a few hundred atoms over picoseconds.
  They do NOT give bulk mechanical properties, long-timescale kinetics,
  grain-boundary or microstructural behaviour, device performance, cost, or
  manufacturability. Never claim any of those.
- Being wrong in public is the point. A refuted hypothesis is a successful
  round. Do not soften a negative result.

Write like a working scientist's lab notebook: plain, specific, numerate. No
marketing language, no bullet-point padding, no restating the question."""


def _fmt(value: float) -> str:
    return f"{value:.4g}"


def render_measurements(measurements: list[Measurement]) -> str:
    if not measurements:
        return "  (none recorded)"
    lines = []
    for m in measurements:
        flags = []
        if m.is_proxy:
            flags.append("PROXY")
        if m.ood_flag:
            flags.append("OOD")
        tail = f" [{', '.join(flags)}]" if flags else ""
        note = f" — {m.note}" if m.note else ""
        lines.append(
            f"  {m.candidate_id}  {m.property} = {_fmt(m.value)} {m.unit}"
            f"  (source {m.source}, confidence {m.confidence:.2f}){tail}{note}"
        )
    return "\n".join(lines)


def render_candidate(cand: Candidate) -> str:
    prov = cand.provenance
    bits = [f"source {prov.source}"]
    if prov.database:
        bits.append(f"{prov.database}:{prov.external_id or '?'}")
    if prov.parent_id:
        bits.append(f"derived from {prov.parent_id} by {prov.operation or 'an unrecorded edit'}")
    return f"  {cand.id}  {cand.name} ({cand.formula or 'formula unknown'}) — {'; '.join(bits)}"


def render_spec(spec: Spec) -> str:
    lines = [
        f"Goal (verbatim from the user): {spec.goal}",
        f"Title: {spec.title}",
        f"Domain: {spec.domain}",
        f"Seed strategy: {spec.seed_strategy}",
        "Objectives:",
    ]
    for o in spec.objectives:
        target = f", target {o.target}" if o.target is not None else ""
        lines.append(
            f"  {o.property} ({o.label}) — {o.direction}imize, unit {o.unit}, "
            f"weight {o.weight}{target}"
        )
    if spec.constraints:
        lines.append("Constraints:")
        for c in spec.constraints:
            lines.append(f"  {c.property} {c.op} {c.value} — {c.description}")
    return "\n".join(lines)


def render_notebook(view: NotebookView, *, include_candidates: bool = True) -> str:
    """The compact text form of the notebook handed to every agent."""
    parts = [render_spec(view.spec)]

    if view.heuristics:
        parts.append("Heuristics learned in earlier rounds (these are standing orders):")
        parts.append(
            "\n".join(
                f"  [{h.strength}] {h.text}  (learned from {h.learned_from})"
                for h in view.heuristics
            )
        )

    if view.hypotheses:
        rows = []
        for h in view.hypotheses:
            verdict = view.verdicts.get(h.id, "pending")
            rows.append(
                f"  {h.id} (round {h.round}, branch {h.branch}) -> {verdict}\n"
                f"      claim: {h.statement}\n"
                f"      falsified if: {h.falsification_criterion}"
                + (
                    f"\n      why: {view.verdict_reasoning[h.id]}"
                    if h.id in view.verdict_reasoning
                    else ""
                )
            )
        parts.append("Hypotheses so far:\n" + "\n".join(rows))

    if include_candidates and view.candidates:
        parts.append(
            "Candidates seen so far:\n"
            + "\n".join(render_candidate(c) for c in view.candidates.values())
        )

    parts.append(f"Measurements on record ({len(view.measurements)}):\n"
                 + render_measurements(view.measurements))

    if view.vetoes:
        parts.append(
            "Skeptic vetoes so far:\n"
            + "\n".join(f"  {v.candidate_id}: [{v.category}] {v.reason}" for v in view.vetoes)
        )

    if view.pareto:
        front = [p for p in view.pareto if p.rank == 0]
        parts.append(
            "Current Pareto frontier (rank 0):\n"
            + "\n".join(
                f"  {p.candidate_id}  "
                + ", ".join(f"{k}={_fmt(v)}" for k, v in sorted(p.values.items()))
                + f"  (scalar {p.scalar_score:.3f})"
                for p in front
            )
        )

    return "\n\n".join(parts)


# --------------------------------------------------------------------------
# Reason, then format
# --------------------------------------------------------------------------

TRANSCRIBE = """\
Below is a lab-notebook entry you have just written. Transcribe it into the
required structured record.

Rules:
- Use only claims, numbers and conclusions that appear in the entry. Introduce
  nothing new. If the entry did not decide something, say so in the field
  rather than inventing a decision.
- Quote measured values exactly as the entry states them, with units.
- Do not invent identifiers. Where a field asks for an id, use one that appears
  in the entry or in the notebook."""


async def notebook_entry(
    llm: LLM,
    emit: Emit,
    *,
    system: str,
    prompt: str,
    entry_id: str,
    author: str,
    heading: str,
    model: str = OPUS,
    effort: Effort = "high",
    max_tokens: int = 24000,
) -> str:
    """Stream one notebook entry out as `NotebookDelta` events; return the text."""
    chunks: list[str] = []
    first = True
    async for chunk in llm.stream_text(
        system=system, prompt=prompt, model=model, effort=effort, max_tokens=max_tokens
    ):
        chunks.append(chunk)
        emit(
            NotebookDelta(
                entry_id=entry_id,
                author=author,  # type: ignore[arg-type]
                heading=heading if first else None,
                text=chunk,
            )
        )
        first = False
    text = "".join(chunks)
    if not text.strip():
        raise ValueError(f"{author} produced an empty notebook entry")
    return text


async def reason_then_format(
    llm: LLM,
    emit: Emit,
    schema: type[T],
    *,
    system: str,
    prompt: str,
    entry_id: str,
    author: str,
    heading: str,
    model: str = OPUS,
    effort: Effort = "high",
    prose_max_tokens: int = 24000,
) -> tuple[T, str]:
    """Stream the reasoning, then transcribe it into `schema`.

    Returns the validated record and the prose it came from.
    """
    prose = await notebook_entry(
        llm,
        emit,
        system=system,
        prompt=prompt,
        entry_id=entry_id,
        author=author,
        heading=heading,
        model=model,
        effort=effort,
        max_tokens=prose_max_tokens,
    )
    record = await llm.structured(
        schema,
        system=system,
        prompt=f"{TRANSCRIBE}\n\n--- the task you were given ---\n{prompt}"
        f"\n\n--- your notebook entry ---\n{prose}",
        model=model,
        effort="low",  # the thinking already happened; this is transcription
        max_tokens=16000,
    )
    return record, prose
