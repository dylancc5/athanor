"""Emit JSON Schema for the campaign contracts, for the frontend's types.

    cd backend && uv run python scripts/gen_schema.py
    cd web && npm run gen:types

`web/lib/contracts.ts` is generated from the schema this writes, so the
frontend's types can never drift from the backend's. Do not edit either
generated file by hand.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import TypeAdapter

from athanor import contracts as C

OUT = Path(__file__).resolve().parents[2] / "web" / "lib" / "contracts.schema.json"

# Every type the frontend needs a name for. `Event` pulls in the whole event
# union transitively; the rest are listed so they get named TS interfaces
# rather than being inlined anonymously.
EXPORTS = [
    C.Event,
    C.Spec,
    C.Objective,
    C.Constraint,
    C.Candidate,
    C.Provenance,
    C.Measurement,
    C.Artifact,
    C.Hypothesis,
    C.BatchPlan,
    C.Heuristic,
    C.Veto,
    C.ParetoPoint,
    C.Proposal,
    C.Ledger,
    C.NotebookView,
]


def _require_discriminant(schema: dict) -> None:
    """Make a single-valued `type` field required.

    Pydantic gives each event's `type` a default, so it lands outside
    `required` and the generated TypeScript marks it optional — which stops
    `switch (event.body.type)` from narrowing the union. The discriminant is
    always present on the wire, so pin it as required.
    """
    props = schema.get("properties")
    if not isinstance(props, dict):
        return
    t = props.get("type")
    if not isinstance(t, dict):
        return
    if "const" not in t and not (isinstance(t.get("enum"), list) and len(t["enum"]) == 1):
        return
    required = schema.setdefault("required", [])
    if isinstance(required, list) and "type" not in required:
        required.append("type")


def main() -> None:
    defs: dict[str, object] = {}
    properties: dict[str, object] = {}

    for model in EXPORTS:
        schema = model.model_json_schema(ref_template="#/definitions/{model}")
        defs.update(schema.pop("$defs", {}))
        name = model.__name__
        defs[name] = schema
        properties[name] = {"$ref": f"#/definitions/{name}"}

    root = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "AthanorContracts",
        "description": "Generated from backend/athanor/contracts.py — do not edit.",
        "type": "object",
        "properties": properties,
        "definitions": defs,
    }

    for schema in defs.values():
        if isinstance(schema, dict):
            _require_discriminant(schema)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(root, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT} ({len(defs)} definitions)")


if __name__ == "__main__":
    main()
