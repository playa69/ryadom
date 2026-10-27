"""Фоновая модель: текстовая модель прокси программы (LiteLLM, OpenAI-совместимый) для итогов разговоров и недели и заметок памяти.

Это не голосовой путь: агент говорит с человеком через Gemini Live (app/clients/gemini_live.py), а эта модель пишет тексты
в фоне, после и вне разговора. Текст человека уходит во внешний сервис: в журнал пишутся только модель, время и размер, сами
реплики — никогда.
"""

import logging
import re
import time
from typing import Protocol

import httpx

from app.core.config import BackgroundModelSettings
from app.services import usage as model_usage

logger = logging.getLogger("agent.background")

# Соединения с прокси живут дольше 5 секунд простоя (по умолчанию в httpx): между фоновыми запросами проходят минуты, но
# запрос не должен начинаться с нового TCP+TLS, пока соединение живо. Прокси держит простаивающее соединение не меньше
# минуты (проверено), а закрытое им httpx замечает и открывает заново.
KEEPALIVE_LIMITS = httpx.Limits(keepalive_expiry=60)

ChatMessage = dict[str, str]


class ModelError(Exception):
    """Модель не ответила или ответила мусором."""


class BackgroundModel(Protocol):
    """Фоновая текстовая модель: один запрос — один ответ целиком."""

    name: str

    async def complete(self, messages: list[ChatMessage]) -> str: ...

    async def aclose(self) -> None: ...


def _record_chat_usage(model: str, usage: object) -> str:
    """Токены ответа модели (`usage` в формате OpenAI) в учёт расхода; для журнала — «вход/выход» или «none».

    Нет `usage` — расход модели не записывается, а в журнале видно `tokens=none`.
    """
    if not isinstance(usage, dict):
        return "none"
    prompt, completion = usage.get("prompt_tokens"), usage.get("completion_tokens")
    if not isinstance(prompt, int) or not isinstance(completion, int):
        return "none"
    model_usage.record(model, "chat", "input", "text", "tokens", prompt)
    model_usage.record(model, "chat", "output", "text", "tokens", completion)
    return f"{prompt}/{completion}"


def _trim_to_sentence(text: str) -> str:
    """Ответ оборвался по лимиту токенов: оставляем целые предложения, а если их нет — как есть."""
    ends = [m.end() for m in re.finditer(r"[.!?…]", text)]
    return text[: ends[-1]] if ends else text


class ProxyBackgroundModel:
    """Фоновая модель через `POST {base_url}/chat/completions`, без стрима: ответ короткий и нужен целиком."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        max_tokens: int,
        temperature: float,
        timeout_seconds: int,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.name = f"proxy:{model}"
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._api_key = api_key
        self._model = model
        self._max_tokens = max_tokens
        self._temperature = temperature
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds, limits=KEEPALIVE_LIMITS)

    @model_usage.counted("llm")
    async def complete(self, messages: list[ChatMessage]) -> str:
        started = time.perf_counter()
        try:
            response = await self._client.post(
                self._url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={
                    "model": self._model,
                    "messages": messages,
                    "max_tokens": self._max_tokens,
                    "temperature": self._temperature,
                },
            )
        except httpx.HTTPError as error:
            raise ModelError(f"Фоновая модель не ответила: {error!r}") from error
        if response.status_code != 200:
            raise ModelError(f"Фоновая модель ответила {response.status_code}: {response.text[:200]}")
        try:
            body = response.json()
            choice = body["choices"][0]
            text = (choice["message"]["content"] or "").strip()
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise ModelError(f"Фоновая модель вернула неожиданный ответ: {response.text[:200]}") from error
        if choice.get("finish_reason") == "length":
            text = _trim_to_sentence(text)
        tokens = _record_chat_usage(self._model, body.get("usage"))
        logger.info(
            "chat model=%s ms=%d messages=%d chars=%d tokens=%s",
            self._model,
            (time.perf_counter() - started) * 1000,
            len(messages),
            len(text),
            tokens,
        )
        return text

    async def aclose(self) -> None:
        await self._client.aclose()


def build_background_model(settings: BackgroundModelSettings) -> BackgroundModel | None:
    """Фоновая модель по настройкам; без ключа прокси или его адреса — None (фоновые тексты не пишутся)."""
    if settings.api_key is None or not settings.base_url:
        return None
    return ProxyBackgroundModel(
        settings.base_url,
        settings.api_key.get_secret_value(),
        settings.chat_model,
        settings.max_tokens,
        settings.temperature,
        settings.timeout_seconds,
    )
