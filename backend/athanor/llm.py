"""The one place ATHANOR talks to Claude.

Three jobs:

1. **Structured output** — `structured()` asks for a reply constrained to a
   pydantic model's JSON schema (`output_config.format`, never the deprecated
   `output_format` parameter) and validates it. A reply that does not validate
   raises; it is never patched up, because a silently coerced agent decision is
   indistinguishable from a fabricated one.
2. **Streaming prose** — `stream_text()` yields text chunks so the Lab Notebook
   fills live.
3. **Token accounting** — every call reports `(input_tokens, output_tokens)` to
   an injected callback, which the campaign folds into its `Ledger`.

Model facts this module encodes (they are easy to get wrong):
  * `claude-opus-5-5` for judgement, `claude-haiku-5-5` for parsing.
  * Thinking is always on and cannot be configured — we omit `thinking`
    entirely. Sending `{"type": "disabled"}` or `budget_tokens` is a 400.
  * Effort defaults to `medium`, so it is always set explicitly.
  * Forced tool use (`tool_choice` `any`/`tool`) is a 400 on these models, so
    structured data comes from structured outputs, never a forced tool call.
  * Assistant prefill is a 400, so we never prefill.
  * `stop_reason == "refusal"` is an HTTP 200. It is checked before any content
    is read.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, TypeVar

import anthropic
from pydantic import BaseModel, ValidationError

log = logging.getLogger("athanor.llm")

OPUS = "claude-opus-5-5"
HAIKU = "claude-haiku-5-5"

Effort = str  # "low" | "medium" | "high" | "xhigh" | "max"

T = TypeVar("T", bound=BaseModel)

UsageSink = Callable[[int, int], None]


class LLMError(RuntimeError):
    """A Claude call could not be turned into a usable answer."""


class LLMRefusal(LLMError):
    """The model declined. Carries the refusal category when the API gives one."""

    def __init__(self, message: str, category: str | None = None):
        super().__init__(message)
        self.category = category


def load_env() -> None:
    """Load `.env` from the repo root. Safe to call repeatedly."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover — python-dotenv is a declared dep
        return
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root / ".env")


def json_schema_for(model: type[BaseModel]) -> dict[str, Any]:
    """A structured-output schema for `model`.

    Prefers the SDK's own schema transform (it handles `$defs`/`$ref`, strips
    constraints the API rejects, and sets `additionalProperties: false`), and
    falls back to an equivalent local walk if that private helper moves.
    """
    try:
        from anthropic.lib._parse._transform import transform_schema

        return transform_schema(model)
    except Exception:  # noqa: BLE001 — a moved private helper must not break us
        return _sanitize(model.model_json_schema())


_DROP = ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength",
         "maxLength", "multipleOf", "pattern", "default", "minItems", "maxItems")


def _sanitize(schema: Any) -> Any:
    if isinstance(schema, list):
        return [_sanitize(s) for s in schema]
    if not isinstance(schema, dict):
        return schema
    out = {k: _sanitize(v) for k, v in schema.items() if k not in _DROP}
    if out.get("type") == "object":
        out["additionalProperties"] = False
    return out


class LLM:
    """Shared async Anthropic client with retries and token accounting."""

    def __init__(
        self,
        client: Any | None = None,
        *,
        on_usage: UsageSink | None = None,
        max_attempts: int = 4,
    ):
        if client is None:
            load_env()
            # Retries are ours (below) so that a stream can decide for itself
            # whether a retry would duplicate already-emitted deltas.
            client = anthropic.AsyncAnthropic(max_retries=0)
        self.client = client
        self.on_usage = on_usage
        self.max_attempts = max_attempts

    # ---------------------------------------------------------------- usage

    def _record(self, usage: Any) -> None:
        if self.on_usage is None or usage is None:
            return
        self.on_usage(
            int(getattr(usage, "input_tokens", 0) or 0),
            int(getattr(usage, "output_tokens", 0) or 0),
        )

    # -------------------------------------------------------------- retries

    @staticmethod
    def _retryable(exc: BaseException) -> bool:
        if isinstance(exc, (anthropic.RateLimitError, anthropic.APIConnectionError,
                            anthropic.APITimeoutError)):
            return True
        if isinstance(exc, anthropic.APIStatusError):
            return exc.status_code >= 500
        return False

    async def _sleep_backoff(self, attempt: int) -> None:
        delay = min(2.0 ** attempt + random.uniform(0.0, 0.5), 20.0)
        await asyncio.sleep(delay)

    # ------------------------------------------------------------ responses

    @staticmethod
    def _check_stop(response: Any) -> None:
        """Guard every documented way a reply can be unusable."""
        stop = getattr(response, "stop_reason", None)
        if stop == "refusal":
            details = getattr(response, "stop_details", None)
            category = getattr(details, "category", None)
            explanation = getattr(details, "explanation", None) or "no explanation given"
            raise LLMRefusal(f"model refused ({category}): {explanation}", category)
        if stop == "max_tokens":
            raise LLMError("reply hit max_tokens and is truncated")

    @staticmethod
    def _first_text(response: Any) -> str:
        for block in getattr(response, "content", []) or []:
            if getattr(block, "type", None) == "text":
                return str(block.text)
        raise LLMError("reply contained no text block")

    # ----------------------------------------------------------- structured

    async def structured(
        self,
        schema: type[T],
        *,
        system: str,
        prompt: str,
        model: str = OPUS,
        effort: Effort = "high",
        max_tokens: int = 16000,
    ) -> T:
        """Ask for JSON matching `schema` and validate it. Raises on mismatch."""
        output_config = {
            "effort": effort,
            "format": {"type": "json_schema", "schema": json_schema_for(schema)},
        }
        last: BaseException | None = None
        for attempt in range(self.max_attempts):
            try:
                response = await self.client.messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    system=system,
                    messages=[{"role": "user", "content": prompt}],
                    output_config=output_config,
                )
            except Exception as exc:  # noqa: BLE001 — classified immediately
                last = exc
                if not self._retryable(exc) or attempt == self.max_attempts - 1:
                    raise
                log.warning("retrying %s after %s", model, type(exc).__name__)
                await self._sleep_backoff(attempt)
                continue

            self._record(getattr(response, "usage", None))
            self._check_stop(response)
            text = self._first_text(response)
            try:
                return schema.model_validate_json(text)
            except ValidationError as exc:
                raise LLMError(
                    f"{model} returned JSON that does not match {schema.__name__}: {exc}"
                ) from exc
            except json.JSONDecodeError as exc:  # pragma: no cover — schema-constrained
                raise LLMError(f"{model} returned unparseable JSON: {exc}") from exc
        raise LLMError(f"{model} failed after {self.max_attempts} attempts") from last

    # ------------------------------------------------------------ streaming

    async def stream_text(
        self,
        *,
        system: str,
        prompt: str,
        model: str = OPUS,
        effort: Effort = "high",
        max_tokens: int = 24000,
    ) -> AsyncIterator[str]:
        """Yield text chunks as they arrive.

        A failure is retried only while nothing has been yielded yet — once a
        chunk is out, the caller has already emitted it as a `NotebookDelta`
        and a retry would duplicate prose.
        """
        for attempt in range(self.max_attempts):
            emitted = False
            try:
                async with self.client.messages.stream(
                    model=model,
                    max_tokens=max_tokens,
                    system=system,
                    messages=[{"role": "user", "content": prompt}],
                    output_config={"effort": effort},
                ) as stream:
                    async for chunk in stream.text_stream:
                        if chunk:
                            emitted = True
                            yield chunk
                    final = await stream.get_final_message()
                self._record(getattr(final, "usage", None))
                self._check_stop(final)
                return
            except (LLMError, LLMRefusal):
                raise
            except Exception as exc:  # noqa: BLE001 — classified immediately
                if emitted or not self._retryable(exc) or attempt == self.max_attempts - 1:
                    raise
                log.warning("retrying stream on %s after %s", model, type(exc).__name__)
                await self._sleep_backoff(attempt)
