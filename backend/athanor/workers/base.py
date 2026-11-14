"""Subprocess worker harness.

Why this exists: torch (MACE, fairchem) and tblite both link their own copy of
libomp, and importing them into one process aborts with `OMP: Error #15`.
fairchem additionally needs its own Python 3.11 + torch 2.4 pin. So every
compute-heavy scorer runs out-of-process in its own uv environment, and the
server talks to it over JSON on stdin/stdout.

A worker is a module run as `<env>/.venv/bin/python -m athanor.workers.<name>`.
It reads one JSON request object from stdin and writes one JSON response
object to stdout. Anything a worker prints to stderr is treated as log noise,
which matters because these libraries are chatty on import.

Workers are also the unit of determinism: given the same request they must
produce the same response, so golden campaigns replay identically.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[2]
ENVS_DIR = BACKEND_DIR / "envs"

# Which uv environment each worker runs in.
WORKER_ENVS: dict[str, str] = {
    "mace": "mace",
    "xtb": "xtb",
    "odac": "fairchem",
}


class WorkerError(RuntimeError):
    """A worker failed. Carries stderr so the cause is never swallowed."""

    def __init__(self, worker: str, message: str, stderr: str = ""):
        self.worker = worker
        self.stderr = stderr
        super().__init__(f"[{worker}] {message}" + (f"\n--- stderr ---\n{stderr[-3000:]}" if stderr else ""))


@dataclass(frozen=True)
class WorkerSpec:
    name: str
    python: Path
    module: str

    @classmethod
    def for_name(cls, name: str) -> "WorkerSpec":
        try:
            env = WORKER_ENVS[name]
        except KeyError:
            raise WorkerError(name, f"unknown worker; known: {sorted(WORKER_ENVS)}") from None
        python = ENVS_DIR / env / ".venv" / "bin" / "python"
        if not python.exists():
            raise WorkerError(
                name,
                f"environment not installed: {python} is missing. "
                f"Run `make envs` (see backend/README.md).",
            )
        return cls(name=name, python=python, module=f"athanor.workers.{name}")


def _child_env() -> dict[str, str]:
    env = os.environ.copy()
    # Workers import athanor.workers.* from the repo, not from an installed wheel,
    # so each isolated venv needs the package root on its path.
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = f"{BACKEND_DIR}{os.pathsep}{existing}" if existing else str(BACKEND_DIR)
    env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    env.setdefault("OMP_NUM_THREADS", "8")
    env.setdefault("TOKENIZERS_PARALLELISM", "false")
    return env


async def run_worker(
    name: str,
    request: dict[str, Any],
    *,
    timeout: float = 1800.0,
) -> dict[str, Any]:
    """Run one worker request. Raises WorkerError on any failure.

    Never returns a partial or invented result: if the worker crashes, times
    out, or writes unparseable output, this raises and the caller records the
    candidate as failed rather than fabricating a measurement.
    """
    spec = WorkerSpec.for_name(name)
    payload = json.dumps(request).encode()

    proc = await asyncio.create_subprocess_exec(
        str(spec.python),
        "-m",
        spec.module,
        cwd=str(BACKEND_DIR),
        env=_child_env(),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(payload), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise WorkerError(name, f"timed out after {timeout:.0f}s") from None

    stderr = err.decode(errors="replace")
    if proc.returncode != 0:
        raise WorkerError(name, f"exited with code {proc.returncode}", stderr)

    text = out.decode(errors="replace").strip()
    if not text:
        raise WorkerError(name, "produced no output", stderr)
    # Import chatter can leak onto stdout; the response is the last JSON object.
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                response = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    else:
        raise WorkerError(name, f"output was not JSON: {text[:500]!r}", stderr)

    if response.get("ok") is not True:
        raise WorkerError(name, response.get("error", "worker reported failure"), stderr)
    return response


# --------------------------------------------------------------------------
# Worker-side entry point
# --------------------------------------------------------------------------


def serve(handler) -> None:
    """Call from a worker module's `__main__`: reads the request, runs
    `handler(request) -> dict`, and writes the response.

    Stdout is redirected during the handler so that library prints cannot
    corrupt the response envelope.
    """
    import contextlib
    import traceback

    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        sys.stdout.write(json.dumps({"ok": False, "error": f"bad request: {exc}"}) + "\n")
        return

    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = handler(request)
        response = {"ok": True, **result}
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        response = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    sys.__stdout__.write(json.dumps(response) + "\n")
    sys.__stdout__.flush()
