"""Тон и риск реплики человека отдельным быстрым запросом к текстовой модели (прототип PROTEUS-168).

Разговорную сессию Gemini Live не трогает: вызов функции внутри неё подменял или задерживал ответ (замеры в задаче),
поэтому классификатор живёт рядом и ответу не мешает. Результат — тот же словарь, что у `parse_mood`. В пути Gemini Live
классификатор работает, когда есть ключ Gemini; в пути Сбера тон определяет GigaChat (`GigaChatMoodClassifier` в
`app/clients/sber_voice.py`), чтобы слова человека не уходили в Google. Модель и таймаут — константы.
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

# Быстрая текстовая модель Gemini: ответ нужен раньше, чем человек дочитает реплику, поэтому лёгкая модель и короткий таймаут.
MOOD_MODEL = "gemini-3.5-flash-lite"
MOOD_TIMEOUT_SECONDS = 2.5

MOOD_TONES = ("neutral", "sleepy", "angry", "afraid", "sad", "calm")


def parse_mood(args: dict | None) -> dict | None:
    """Ответ классификатора в безопасный вид: неизвестный тон не принимается, интенсивность зажата в 0..1."""
    if not isinstance(args, dict) or args.get("tone") not in MOOD_TONES:
        return None
    try:
        intensity = min(1.0, max(0.0, float(args.get("intensity", 0))))
    except (TypeError, ValueError):
        intensity = 0.0
    return {"tone": args["tone"], "intensity": intensity}

SCHEMA = {
    "type": "object",
    "properties": {
        "tone": {"type": "string", "enum": list(MOOD_TONES)},
        "intensity": {"type": "number"},
    },
    "required": ["tone", "intensity"],
}


class ToneClassifier(Protocol):
    """Классификатор тона пути разговора: прогрев соединения до первой реплики и тон реплики (`parse_mood`) или None."""

    async def warm(self) -> None: ...

    async def classify(
        self, text: str, *, user_id: str | None = None, dialog_id: str | None = None
    ) -> dict | None: ...


class MoodClassifier:
    """Классификатор Gemini с production-инструкцией на каждый вызов."""

    prompt_management = True

    def __init__(
        self,
        settings: GeminiSettings,
        prompt_provider: PromptProvider | None = None,
        tracer: Tracer | None = None,
    ) -> None:
        from google import genai
        from google.genai import types

        self._types = types
        self._model = MOOD_MODEL
        self._timeout = MOOD_TIMEOUT_SECONDS
        self._prompt_provider = prompt_provider
        self._tracer = tracer or NullTracer()
        options = None
        if settings.base_url:
            headers = {"X-Relay-Token": settings.relay_token.get_secret_value()} if settings.relay_token else None
            options = types.HttpOptions(base_url=settings.base_url, headers=headers)
        self._client = genai.Client(api_key=settings.api_key.get_secret_value(), http_options=options)  # type: ignore[union-attr]

    async def warm(self) -> None:
        """Соединение открывается до первой реплики: холодный первый запрос через релей не укладывался в срок."""
        await self.classify("привет")

    async def classify(
        self, text: str, *, user_id: str | None = None, dialog_id: str | None = None
    ) -> dict | None:
        if self._prompt_provider is None:
            return None
        try:
            prompt = self._prompt_provider.resolve("agent.mood.instructions")
        except Exception as error:
            logger.warning("промпт классификатора недоступен: %s", type(error).__name__)
            return None
        trace = self._tracer.start_turn(
            name="mood_classify_gemini",
            session_id=dialog_id or "mood",
            user_id=user_id,
            model=self._model,
            input=text,
            metadata={"operation": "mood", **prompt_metadata(prompt)},
            prompt=prompt.prompt,
        )
        t = self._types
        config = t.GenerateContentConfig(
            system_instruction=prompt.text,
            response_mime_type="application/json",
            response_json_schema=SCHEMA,
            temperature=0,
            max_output_tokens=60,
        )
        try:
            for attempt in (1, 2):  # один повтор: редкий холодный или потерянный запрос
                try:
                    response = await asyncio.wait_for(
                        self._client.aio.models.generate_content(model=self._model, contents=text, config=config), self._timeout
                    )
                    meta = response.usage_metadata
                    if meta is not None:  # расход считается там же, где и у остальных моделей (agent_model_usage_total)
                        model_usage.record(self._model, "mood", "input", "text", "tokens", meta.prompt_token_count or 0)
                        model_usage.record(self._model, "mood", "output", "text", "tokens", meta.candidates_token_count or 0)
                        trace.update(
                            usage={
                                "input_text": meta.prompt_token_count or 0,
                                "output_text": meta.candidates_token_count or 0,
                            }
                        )
                    return parse_mood(json.loads(response.text))
                except Exception as error:  # noqa: BLE001
                    logger.warning("классификатор тона (попытка %d): %s: %s", attempt, type(error).__name__, str(error)[:120])
            trace.update(level="WARNING", status="классификатор не ответил")
            return None
        finally:
            trace.end()
