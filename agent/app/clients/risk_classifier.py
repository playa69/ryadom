"""Вторая ступень детектора кризиса (PROTEUS-279): модель оценивает реплику, которую словарь не поймал.

Только расширяет охват: ответ человеку на любой уровень — заранее написанная фраза (`crisis_script`), так что от модели
зависит лишь то, сработает ли ветка. Любая ошибка и таймаут означают «нет»: словарь остаётся работать без модели.
Инструкция живёт в Langfuse (`agent.safety.risk`), как у остальных вызовов. Тексты реплик в лог не пишутся.
"""

import asyncio
import json
import logging
from typing import Protocol

from app.core.config import GeminiSettings
from app.core.tracing import NullTracer, Tracer
from app.prompts.provider import PromptProvider, prompt_metadata
from app.services import usage as model_usage

logger = logging.getLogger("agent.gemini")

RISK_MODEL = "gemini-3.5-flash-lite"
# Ответ нужен раньше, чем уйдёт ответ модели диалога: в спеке вторая ступень укладывается в секунду.
RISK_TIMEOUT_SECONDS = 1.0

LEVELS = ("none", "yellow", "red")
SCHEMA = {
    "type": "object",
    "properties": {"level": {"type": "string", "enum": list(LEVELS)}},
    "required": ["level"],
}


def parse_level(args: object) -> str:
    """Ответ модели в уровень: всё неизвестное — "none"."""
    if isinstance(args, dict) and args.get("level") in LEVELS:
        return str(args["level"])
    return "none"


class RiskClassifier(Protocol):
    """`context` — последние реплики человека, последняя в конце; результат "none" | "yellow" | "red"."""

    async def classify(self, context: list[str], *, user_id: str | None = None, dialog_id: str | None = None) -> str: ...


class GeminiRiskClassifier:
    def __init__(
        self, settings: GeminiSettings, prompt_provider: PromptProvider | None = None, tracer: Tracer | None = None
    ) -> None:
        from google import genai
        from google.genai import types

        self._types = types
        self._prompt_provider = prompt_provider
        self._tracer = tracer or NullTracer()
        options = None
        if settings.base_url:
            headers = {"X-Relay-Token": settings.relay_token.get_secret_value()} if settings.relay_token else None
            options = types.HttpOptions(base_url=settings.base_url, headers=headers)
        self._client = genai.Client(api_key=settings.api_key.get_secret_value(), http_options=options)  # type: ignore[union-attr]

    async def classify(self, context: list[str], *, user_id: str | None = None, dialog_id: str | None = None) -> str:
        if self._prompt_provider is None or not context:
            return "none"
        try:
            prompt = self._prompt_provider.resolve("agent.safety.risk")
        except Exception as error:  # noqa: BLE001
            logger.warning("промпт оценки риска недоступен: %s", type(error).__name__)
            return "none"
        text = "\n".join(context)
        trace = self._tracer.start_turn(
            name="risk_classify_gemini",
            session_id=dialog_id or "risk",
            user_id=user_id,
            model=RISK_MODEL,
            input=text,
            metadata={"operation": "risk", **prompt_metadata(prompt)},
            prompt=prompt.prompt,
        )
        t = self._types
        config = t.GenerateContentConfig(
            system_instruction=prompt.text,
            response_mime_type="application/json",
            response_json_schema=SCHEMA,
            temperature=0,
            max_output_tokens=20,
        )
        try:
            response = await asyncio.wait_for(
                self._client.aio.models.generate_content(model=RISK_MODEL, contents=text, config=config),
                RISK_TIMEOUT_SECONDS,
            )
            meta = response.usage_metadata
            if meta is not None:
                model_usage.record(RISK_MODEL, "risk", "input", "text", "tokens", meta.prompt_token_count or 0)
                model_usage.record(RISK_MODEL, "risk", "output", "text", "tokens", meta.candidates_token_count or 0)
            return parse_level(json.loads(response.text))
        except Exception as error:
            logger.warning("оценка риска: %s", type(error).__name__)
            trace.update(level="WARNING", status="оценка риска не ответила")
            raise
        finally:
            trace.end()
