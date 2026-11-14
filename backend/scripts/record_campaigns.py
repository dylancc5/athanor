"""Record the golden campaigns the demo replays.

These are REAL runs: real Claude agents, real scorers, real measurements. The
hand-authored fixture that preceded them is gone, because a recorded campaign
with `llm_calls: 0` tells the viewer nothing about the thing being demonstrated.

    cd backend && uv run python scripts/record_campaigns.py li-conductor
    cd backend && uv run python scripts/record_campaigns.py --all

Each run costs real Anthropic credit and real CPU time. A multi-round
solid-electrolyte campaign runs a CI-NEB per candidate, so budget tens of
minutes per campaign and expect the whole set to take hours.

Afterwards: `cd web && npm run sync:campaigns` (or just build — it is a
prebuild step).
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from athanor.eventlog import EventLog, read_events
from athanor.loop.campaign import Campaign, CampaignConfig

ROOT = Path(__file__).resolve().parents[2]
CAMPAIGNS = ROOT / "campaigns"

# Rounds matter more than candidates for the demo: the hypothesis tree, the
# learned heuristics and the "it gets smarter" claim all need several rounds to
# be visible at all. A single-round campaign renders as one lonely node.
GOLDEN = {
    "li-conductor": {
        "goal": (
            "Find a solid-state lithium electrolyte with a low Li migration barrier "
            "that stays stable against a lithium metal anode."
        ),
        "rounds": 3,
        "max_candidates": 5,
    },
    "mof-water": {
        "goal": (
            "Find a metal-organic framework that can harvest drinking water from dry "
            "desert air and release it again with as little heat as possible."
        ),
        "rounds": 3,
        "max_candidates": 5,
    },
    "drug-stability": {
        "goal": (
            "Find a crystal form of a small-molecule drug that resists heat and humidity, "
            "so the medicine survives distribution without refrigeration."
        ),
        "rounds": 3,
        "max_candidates": 5,
    },
}


async def record(name: str, *, force: bool) -> bool:
    spec = GOLDEN[name]
    target = CAMPAIGNS / name
    if target.exists():
        if not force:
            print(f"! {name} already exists — pass --force to re-record it")
            return False
        shutil.rmtree(target)

    print(f"\n=== recording {name} ===")
    print(f"  goal:   {spec['goal']}")
    print(f"  budget: {spec['rounds']} rounds x up to {spec['max_candidates']} candidates")
    print("  (real Claude calls and real scorers — this costs money and time)\n")

    started = time.monotonic()
    log = EventLog(CAMPAIGNS, name)
    campaign = Campaign(
        log,
        config=CampaignConfig(rounds=spec["rounds"], max_candidates=spec["max_candidates"]),
    )
    try:
        await campaign.run(spec["goal"])
    finally:
        log.close()

    elapsed = time.monotonic() - started
    events = list(read_events(log.path))
    summary = summarize(events)
    print(f"\n  {len(events)} events in {elapsed / 60:.1f} min")
    for line in summary:
        print(f"  {line}")
    return True


def summarize(events) -> list[str]:
    """What a human needs to see to judge whether the recording is usable."""
    kinds: dict[str, int] = {}
    verdicts: list[str] = []
    hypotheses = 0
    errors: list[str] = []
    ledger = None
    barriers: list[tuple[str, float]] = []

    for e in events:
        b = e.body
        kinds[b.type] = kinds.get(b.type, 0) + 1
        if b.type == "hypothesis.proposed":
            hypotheses += 1
        elif b.type == "analyst.verdict":
            verdicts.append(b.verdict)
        elif b.type == "ledger.updated":
            ledger = b.ledger
        elif b.type == "campaign.error":
            errors.append(f"{b.stage}: {b.message[:90]}")
        elif b.type == "measurement.recorded" and b.measurement.property == "migration_barrier":
            barriers.append((b.measurement.candidate_id, b.measurement.value))

    out = [
        f"hypotheses: {hypotheses}  verdicts: {', '.join(verdicts) or 'none'}",
    ]
    if ledger:
        out.append(
            f"ledger: {ledger.llm_calls} model calls, "
            f"{ledger.candidates_scored} scored, {ledger.measurements} measurements, "
            f"{ledger.wall_seconds:.0f}s"
        )
    if barriers:
        out.append("barriers: " + ", ".join(f"{c.split('-')[-1]} {v:.3f} eV" for c, v in barriers))
    if errors:
        out.append(f"ERRORS ({len(errors)}):")
        out.extend(f"  - {e}" for e in errors[:6])

    # The things that make a recording worth shipping.
    if "REFUTED" not in verdicts:
        out.append("NOTE: nothing was refuted — the demo's strongest beat is missing.")
    if hypotheses < 2:
        out.append("NOTE: fewer than 2 hypotheses — the hypothesis tree will look empty.")
    if ledger and ledger.llm_calls == 0:
        out.append("NOTE: zero model calls — this is not a real agent run.")
    return out


def main() -> None:
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("names", nargs="*", choices=[*GOLDEN, []], help="campaigns to record")
    p.add_argument("--all", action="store_true", help="record every golden campaign")
    p.add_argument("--force", action="store_true", help="re-record even if it exists")
    args = p.parse_args()

    names = list(GOLDEN) if args.all else [n for n in args.names if n]
    if not names:
        p.error("name at least one campaign, or pass --all")

    import os

    os.environ.setdefault("ATHANOR_LIVE", "1")

    async def run_all() -> None:
        for name in names:
            try:
                await record(name, force=args.force)
            except Exception as exc:  # noqa: BLE001
                print(f"\n!! {name} failed to record: {type(exc).__name__}: {exc}")

    asyncio.run(run_all())
    print("\nNow run: cd web && npm run sync:campaigns")


if __name__ == "__main__":
    main()
