"""The ATHANOR HTTP surface.

The frontend is a pure function of the event log, so every endpoint here either
streams events or returns something an event referred to. There are two ways to
get a stream and they are deliberately the same shape:

* `/api/campaigns/{id}/events` — a live campaign. Backlog from seq 0 first,
  then live events as they are appended.
* `/api/replay/{id}` — a recorded campaign, paced by its own timestamps.

Both send `event: athanor` with the `Event` JSON as data, so the client needs
one parser.

Live campaigns are guarded by `ATHANOR_LIVE`, read per request, because the
public demo must not be able to spend Anthropic credit.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from .contracts import Event
from .eventlog import EventLog, read_events, replay
from .loop.campaign import Campaign, CampaignConfig

log = logging.getLogger("athanor.api")

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent

#: Ids appear in filesystem paths, so they are restricted rather than escaped.
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

LIVE_DISABLED = (
    "Live campaigns are disabled on the public demo to avoid API costs. "
    "Replay a recorded campaign instead."
)

app = FastAPI(title="ATHANOR", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://localhost:{p}" for p in (3000, 3001, 3002)]
    + [f"http://127.0.0.1:{p}" for p in (3000, 3001, 3002)],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

#: Live campaigns started by this process, by id.
_live: dict[str, EventLog] = {}
#: Strong references to running campaign tasks, so they are not garbage collected.
_tasks: set[asyncio.Task] = set()


def campaigns_root() -> Path:
    """Where campaign directories live. Overridable for tests and demos."""
    return Path(os.environ.get("ATHANOR_CAMPAIGNS_DIR") or (REPO_ROOT / "campaigns"))


def live_enabled() -> bool:
    return os.environ.get("ATHANOR_LIVE") == "1"


def campaign_dir(campaign_id: str) -> Path:
    """Resolve a campaign directory, refusing anything outside the root."""
    if not ID_RE.match(campaign_id):
        raise HTTPException(status_code=400, detail="invalid campaign id")
    root = campaigns_root().resolve()
    target = (root / campaign_id).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(status_code=400, detail="invalid campaign id")
    return target


# --------------------------------------------------------------------------
# Streaming
# --------------------------------------------------------------------------


def _message(event: Event) -> dict[str, str]:
    return {"event": "athanor", "data": event.model_dump_json()}


async def _stream_live(request: Request, event_log: EventLog) -> AsyncIterator[dict[str, str]]:
    async for event in event_log.subscribe():
        if await request.is_disconnected():
            return
        yield _message(event)


async def _stream_file(
    request: Request, path: Path, speed: float
) -> AsyncIterator[dict[str, str]]:
    async for event in replay(path, speed=speed):
        if await request.is_disconnected():
            return
        yield _message(event)


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------


class NewCampaign(BaseModel):
    """Request body for a live campaign.

    The defaults are the *smallest useful* campaign rather than the most
    impressive one, because the cost here is not the Claude calls — it is the
    physics. A single candidate in `solid_electrolyte` means a CI-NEB over nine
    images of a supercell, which is tens of minutes on a laptop CPU. At three
    rounds of six candidates that is hours, and someone cloning the repo, trying
    it, and seeing nothing finish would reasonably conclude it was broken.
    Raise these deliberately once you know what you are waiting for.
    """

    goal: str = Field(min_length=4)
    rounds: int = Field(default=1, ge=1, le=8)
    max_candidates: int = Field(default=2, ge=1, le=12)


class CampaignSummary(BaseModel):
    id: str
    goal: str | None = None
    title: str | None = None
    domain: str | None = None
    events: int
    completed: bool
    live: bool


@app.get("/api/health")
async def health() -> dict[str, object]:
    return {"ok": True, "live_enabled": live_enabled(), "campaigns": str(campaigns_root())}


@app.post("/api/campaigns", status_code=201)
async def create_campaign(body: NewCampaign) -> dict[str, object]:
    """Start a live campaign and return its id.

    Defaults to one round of two candidates, which finishes in a few minutes.
    **A full multi-round campaign takes hours on CPU** — the atomistic scorers
    run a CI-NEB per candidate, not because the Claude calls are slow. To watch
    a complete campaign play out immediately, replay a recorded one instead:
    `GET /api/campaigns` lists them and `GET /api/replay/{id}` streams one.

    Follow the returned `events` URL to watch this campaign from seq 0.
    """
    if not live_enabled():
        raise HTTPException(status_code=403, detail=LIVE_DISABLED)

    root = campaigns_root()
    root.mkdir(parents=True, exist_ok=True)
    campaign_id = f"live-{uuid.uuid4().hex[:10]}"
    try:
        event_log = EventLog(root, campaign_id)
    except FileExistsError as exc:  # pragma: no cover — a fresh uuid collided
        raise HTTPException(status_code=500, detail="could not allocate a campaign") from exc

    campaign = Campaign(
        event_log,
        config=CampaignConfig(rounds=body.rounds, max_candidates=body.max_candidates),
    )
    _live[campaign_id] = event_log

    async def runner() -> None:
        try:
            await campaign.run(body.goal)
        except Exception:
            # The campaign already records its own failures; this is the last
            # resort, and the log must be closed either way or every subscriber
            # hangs waiting for events that will never come.
            log.exception("campaign %s crashed", campaign_id)
            try:
                event_log.close()
            except Exception:
                log.exception("could not close the log for %s", campaign_id)

    task = asyncio.create_task(runner(), name=f"campaign-{campaign_id}")
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {
        "id": campaign_id,
        "events": f"/api/campaigns/{campaign_id}/events",
        "rounds": body.rounds,
        "max_candidates": body.max_candidates,
        # Said in the response as well as the docstring, because the person who
        # needs to hear it is the one who just posted a goal and is now watching
        # a stream that will go quiet for minutes at a time.
        "note": (
            f"Running live: {body.rounds} round(s) of up to {body.max_candidates} "
            f"candidate(s). The atomistic scorers run a CI-NEB per candidate, so "
            f"expect minutes per candidate on CPU and hours for a full "
            f"multi-round campaign — the wait is the physics, not the Claude "
            f"calls. Long gaps in the event stream are normal. To see a complete "
            f"campaign immediately, replay a recorded one: GET /api/campaigns "
            f"lists them, GET /api/replay/{{id}} streams one."
        ),
    }


@app.get("/api/campaigns")
async def list_campaigns() -> list[CampaignSummary]:
    """Every campaign on disk, newest first, plus anything running in-process."""
    root = campaigns_root()
    out: list[CampaignSummary] = []
    if root.exists():
        for directory in sorted(
            (p for p in root.iterdir() if p.is_dir()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            path = directory / "events.jsonl"
            if not path.exists():
                continue
            goal = title = domain = None
            count = 0
            completed = False
            try:
                for event in read_events(path):
                    count += 1
                    body = event.body
                    if body.type == "campaign.started":
                        goal = body.goal
                    elif body.type == "spec.created":
                        title, domain = body.spec.title, body.spec.domain
                    elif body.type == "campaign.completed":
                        completed = True
            except Exception as exc:  # noqa: BLE001 — a half-written log is still listable
                log.warning("could not fully read %s: %s", path, exc)
            out.append(
                CampaignSummary(
                    id=directory.name,
                    goal=goal,
                    title=title,
                    domain=domain,
                    events=count,
                    completed=completed,
                    live=directory.name in _live,
                )
            )
    return out


@app.get("/api/campaigns/{campaign_id}/events")
async def campaign_events(campaign_id: str, request: Request) -> EventSourceResponse:
    """SSE: backlog from seq 0, then live events until the campaign ends."""
    event_log = _live.get(campaign_id)
    if event_log is not None:
        return EventSourceResponse(_stream_live(request, event_log))
    # Not running here — this process may have restarted, so serve the record.
    path = campaign_dir(campaign_id) / "events.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail="no such campaign")
    return EventSourceResponse(_stream_file(request, path, speed=0.0))


@app.get("/api/replay/{campaign_id}")
async def replay_campaign(
    campaign_id: str,
    request: Request,
    speed: float = Query(default=1.0, ge=0.0, le=1000.0),
) -> EventSourceResponse:
    """SSE: a recorded campaign, paced by its recorded timestamps.

    `speed=0` replays instantly, which is also what the tests use so the
    stream terminates promptly.
    """
    path = campaign_dir(campaign_id) / "events.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail="no such campaign")
    return EventSourceResponse(_stream_file(request, path, speed=speed))


@app.get("/api/campaigns/{campaign_id}/artifacts/{artifact_id}")
async def get_artifact(campaign_id: str, artifact_id: str) -> dict:
    """The heavy JSON payload an `artifact.created` event pointed at."""
    if not ID_RE.match(artifact_id):
        raise HTTPException(status_code=400, detail="invalid artifact id")
    directory = campaign_dir(campaign_id)
    path = (directory / "artifacts" / f"{artifact_id}.json").resolve()
    if not path.is_relative_to(directory.resolve()) or not path.exists():
        raise HTTPException(status_code=404, detail="no such artifact")
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="artifact payload is corrupt") from exc
