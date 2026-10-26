"""Тон и риск реплики человека отдельным быстрым запросом к текстовой модели (прототип PROTEUS-168).

Разговорную сессию Gemini Live не трогает: вызов функции внутри неё подменял или задерживал ответ (замеры в задаче),
поэтому классификатор живёт рядом и ответу не мешает. Результат — тот же словарь, что у `parse_mood`.
"""

import asyncio
import json
import logging

from app.core.config import GeminiSettings
from app.services import usage as model_usage

logger = logging.getLogger("agent.gemini")

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

INSTRUCTIONS = (
    "Ты определяешь эмоцию человека по его реплике. tone: neutral, sleepy (хочет спать, устал), angry (злость, оскорбления), "
    "afraid (страх, тревога), sad, calm. intensity 0..1."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "tone": {"type": "string", "enum": list(MOOD_TONES)},
        "intensity": {"type": "number"},
    },
    "required": ["tone", "intensity"],
}


class MoodClassifier:
    def __init__(self, settings: GeminiSettings) -> None:
        from google import genai
        from google.genai import types

        self._types = types
        self._model = settings.mood_classifier
        self._timeout = settings.mood_classifier_timeout_seconds
        options = None
        if settings.base_url:
            headers = {"X-Relay-Token": settings.relay_token.get_secret_value()} if settings.relay_token else None
            options = types.HttpOptions(base_url=settings.base_url, headers=headers)
        self._client = genai.Client(api_key=settings.api_key.get_secret_value(), http_options=options)  # type: ignore[union-attr]

    async def classify(self, text: str) -> dict | None:
        t = self._types
        config = t.GenerateContentConfig(
            system_instruction=INSTRUCTIONS,
            response_mime_type="application/json",
            response_json_schema=SCHEMA,
            temperature=0,
            max_output_tokens=60,
        )
        for attempt in (1, 2):  # один повтор: редкий холодный или потерянный запрос
            try:
                response = await asyncio.wait_for(
                    self._client.aio.models.generate_content(model=self._model, contents=text, config=config), self._timeout
                )
                meta = response.usage_metadata
                if meta is not None:  # расход считается там же, где и у остальных моделей (agent_model_usage_total)
                    model_usage.record(self._model, "mood", "input", "text", "tokens", meta.prompt_token_count or 0)
                    model_usage.record(self._model, "mood", "output", "text", "tokens", meta.candidates_token_count or 0)
                return parse_mood(json.loads(response.text))
            except Exception as error:  # noqa: BLE001
                logger.warning("классификатор тона (попытка %d): %s: %s", attempt, type(error).__name__, str(error)[:120])
        return None
