"""Append-only campaign event log + in-process event bus.

One campaign = one directory:
    <root>/<campaign_id>/events.jsonl
    <root>/<campaign_id>/artifacts/<artifact_id>.json
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from .contracts import Artifact, ArtifactCreated, Event, EventBody

_body_adapter: TypeAdapter[EventBody] = TypeAdapter(EventBody)


class EventLog:
    """Writes events to disk and fans them out to live subscribers."""

    def __init__(self, root: Path, campaign_id: str):
        self.campaign_id = campaign_id
        self.dir = Path(root) / campaign_id
        (self.dir / "artifacts").mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "events.jsonl"
        if self.path.exists():
            raise FileExistsError(f"campaign log already exists: {self.path}")
        self._t0 = time.monotonic()
        self._events: list[Event] = []
        self._subscribers: set[asyncio.Queue[Event | None]] = set()
        self._closed = False

    @property
    def events(self) -> list[Event]:
        return self._events

    def emit(self, body: EventBody) -> Event:
        if self._closed:
            raise RuntimeError("event log is closed")
        event = Event(
            seq=len(self._events),
            t=round(time.monotonic() - self._t0, 3),
            campaign_id=self.campaign_id,
            body=body,
        )
        with self.path.open("a") as f:
            f.write(event.model_dump_json() + "\n")
        self._events.append(event)
        for q in self._subscribers:
            q.put_nowait(event)
        return event

    def emit_artifact(self, artifact: Artifact, payload: dict[str, Any]) -> Event:
        """Write the heavy payload to its sidecar file, then log the descriptor.

        `allow_nan=False` is deliberate and load-bearing: Python happily writes
        a bare `NaN`, which is not valid JSON and which no browser can parse, so
        the artifact would silently break the viewer at demo time. A non-finite
        value here means a calculation diverged, and that is a real failure —
        raising lets the campaign record it rather than shipping a broken file.
        """
        try:
            text = json.dumps(payload, separators=(",", ":"), allow_nan=False)
        except ValueError as exc:
            raise ValueError(
                f"artifact {artifact.id} ({artifact.kind}) contains a non-finite "
                f"value and cannot be serialized as valid JSON: {exc}. "
                f"The calculation that produced it most likely diverged."
            ) from exc
        (self.dir / artifact.uri).write_text(text)
        return self.emit(ArtifactCreated(artifact=artifact))

    def close(self) -> None:
        self._closed = True
        for q in self._subscribers:
            q.put_nowait(None)

    async def subscribe(self) -> AsyncIterator[Event]:
        """Yield every event from seq 0, then live events until the log closes."""
        q: asyncio.Queue[Event | None] = asyncio.Queue()
        backlog = list(self._events)
        closed = self._closed
        if not closed:
            self._subscribers.add(q)
        try:
            for e in backlog:
                yield e
            if closed:
                return
            while (e := await q.get()) is not None:
                yield e
        finally:
            self._subscribers.discard(q)


def read_events(path: Path) -> Iterator[Event]:
    """Read and validate a recorded log."""
    with Path(path).open() as f:
        for line in f:
            if line.strip():
                yield Event.model_validate_json(line)


async def replay(path: Path, speed: float = 1.0) -> AsyncIterator[Event]:
    """Deterministically replay a recorded log, paced by the recorded timestamps.

    speed <= 0 replays instantly.
    """
    prev_t = 0.0
    for event in read_events(path):
        if speed > 0:
            await asyncio.sleep(max(0.0, event.t - prev_t) / speed)
        prev_t = event.t
        yield event


def parse_body(data: dict[str, Any]) -> EventBody:
    return _body_adapter.validate_python(data)
