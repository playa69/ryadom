"""Тон и риск реплики человека отдельным быстрым запросом к текстовой модели (прототип PROTEUS-168).

Разговорную сессию Gemini Live не трогает: вызов функции внутри неё подменял или задерживал ответ (замеры в задаче),
поэтому классификатор живёт рядом и ответу не мешает. Результат — тот же словарь, что у `parse_mood`.
"""

import asyncio
import json
import logging

from app.clients.gemini_live import MOOD_RISKS, MOOD_TONES, parse_mood
from app.core.config import GeminiSettings

logger = logging.getLogger("agent.gemini")

INSTRUCTIONS = (
    "Ты определяешь эмоцию человека по его реплике. tone: neutral, sleepy (хочет спать, устал), angry (злость, оскорбления), "
    "afraid (страх, тревога), sad, calm. intensity 0..1. risk: self_harm (суицид, самоповреждение), harm_others (всерьёз "
    "намерен убить или навредить другому), иначе none. Фигуры речи («убил бы время») — не риск."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "tone": {"type": "string", "enum": list(MOOD_TONES)},
        "intensity": {"type": "number"},
        "risk": {"type": "string", "enum": list(MOOD_RISKS)},
    },
    "required": ["tone", "intensity", "risk"],
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
                return parse_mood(json.loads(response.text))
            except Exception as error:  # noqa: BLE001
                logger.warning("классификатор тона (попытка %d): %s: %s", attempt, type(error).__name__, str(error)[:120])
        return None
