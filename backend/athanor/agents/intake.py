"""Intake: a natural-language research goal becomes a `Spec`.

Haiku, one structured call, low effort — this is parsing, not judgement.

The one thing that must not go wrong here is the property vocabulary. If intake
writes `li_migration_barrier` while the scorers expose `migration_barrier`, the
Router finds an empty intersection and the campaign silently measures nothing.
So the allowed keys are supplied by the registry (via
`loop.router.property_vocabulary`) and validated in code afterwards.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from ..contracts import Constraint, Domain, Objective, Spec
from ..llm import HAIKU, LLM, LLMError
from ..loop.router import property_vocabulary

SYSTEM = """\
You turn a scientist's informal research goal into a precise, machine-readable
campaign specification for an autonomous discovery platform.

Be literal. Capture what the user asked for, including the parts that are hard
to measure, and do not widen or narrow the goal to suit the available tools.

Choose the single best-fitting domain:
- solid_electrolyte — inorganic crystalline ion conductors, battery materials,
  anything decided by a periodic lattice.
- mof_water — porous frameworks: MOFs, COFs, zeolites; adsorption, water
  harvesting, gas capture.
- drug_stability — molecules and molecular crystals: small-molecule drugs,
  polymorphs, formulation and shelf-life, protein-ligand binding.

Objectives:
- `property` MUST be chosen from the allowed property keys listed below.
  Nothing else can be measured, so an objective on any other key is useless.
- Give each objective the correct physical `unit` and the correct `direction`:
  "min" for things that should be small (a migration barrier, an energy above
  hull, a regeneration energy), "max" for things that should be large (a band
  gap, a water uptake), "target" only when a specific value is wanted.
- Weight the objective the user cares about most above 1.0.

Constraints are hard filters, not preferences ("stay within 0.05 eV/atom of the
convex hull", "no cobalt"). Use the `elements` property with op `not_in` for
element exclusions. Omit constraints the user did not ask for.

`seed_strategy` is one sentence saying where the first candidates should come
from, in terms a retrieval system could act on."""


class ObjectiveDraft(BaseModel):
    property: str = Field(description="machine key, from the allowed list")
    label: str = Field(description="short human-readable label")
    direction: Literal["min", "max", "target"]
    target: float | None = Field(description="only for direction=target, else null")
    weight: float = Field(description="relative importance, 1.0 is baseline")
    unit: str = Field(description="physical unit, e.g. eV or eV/atom")


class ConstraintDraft(BaseModel):
    property: str
    op: Literal["<", "<=", ">", ">=", "==", "in", "not_in"]
    numeric_value: float | None = Field(description="for numeric ops, else null")
    list_value: list[str] = Field(description="for in/not_in, else an empty list")
    description: str


class SpecDraft(BaseModel):
    title: str = Field(description="under 40 characters")
    domain: Literal["solid_electrolyte", "mof_water", "drug_stability"]
    objectives: list[ObjectiveDraft]
    constraints: list[ConstraintDraft]
    seed_strategy: str


def _prompt(goal: str) -> str:
    lines = ["The research goal, verbatim:", "", goal, "", "Allowed property keys by domain:"]
    for domain in ("solid_electrolyte", "mof_water", "drug_stability"):
        vocab = property_vocabulary(domain)  # type: ignore[arg-type]
        if not vocab:
            lines.append(f"  {domain}: (no scorer registered — do not choose this domain)")
            continue
        rendered = ", ".join(f"{p} [{u or 'unit unknown, supply it yourself'}]" for p, u in vocab)
        lines.append(f"  {domain}: {rendered}")
    return "\n".join(lines)


def _to_constraint(draft: ConstraintDraft) -> Constraint | None:
    if draft.op in ("in", "not_in"):
        if not draft.list_value:
            return None
        value: float | list[str] = list(draft.list_value)
    else:
        if draft.numeric_value is None:
            return None
        value = draft.numeric_value
    return Constraint(
        property=draft.property, op=draft.op, value=value, description=draft.description
    )


async def run_intake(llm: LLM, goal: str) -> Spec:
    """Parse `goal` into a validated `Spec`, or raise `LLMError`."""
    draft = await llm.structured(
        SpecDraft,
        system=SYSTEM,
        prompt=_prompt(goal),
        model=HAIKU,
        effort="low",
        max_tokens=8000,
    )
    domain: Domain = draft.domain
    allowed = {p for p, _ in property_vocabulary(domain)}

    objectives: list[Objective] = []
    for o in draft.objectives:
        if allowed and o.property not in allowed:
            # Dropped rather than remapped: a guessed remapping would attach the
            # user's intent to a property nothing actually measures.
            continue
        objectives.append(
            Objective(
                property=o.property,
                label=o.label,
                direction=o.direction,
                target=o.target if o.direction == "target" else None,
                weight=abs(o.weight) or 1.0,
                unit=o.unit,
            )
        )
    if not objectives:
        raise LLMError(
            f"intake produced no objectives measurable in domain {domain!r}; "
            f"allowed keys are {sorted(allowed)}"
        )

    constraints = [c for c in (_to_constraint(d) for d in draft.constraints) if c is not None]
    return Spec(
        goal=goal,
        title=draft.title.strip()[:80] or "Untitled campaign",
        domain=domain,
        objectives=objectives,
        constraints=constraints,
        seed_strategy=draft.seed_strategy,
    )
