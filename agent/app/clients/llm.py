"""Модели агента: чат и распознавание речи через OpenAI-совместимый прокси программы (LiteLLM).

Один прокси и один ключ (`AGENT_API_TOKEN`) на всё: чат (`POST /chat/completions`), распознавание
(`POST /audio/transcriptions`) и озвучка (speech.py). Текст человека уходит во внешний сервис: в журнал
пишутся только модель, время и размер, сами реплики — никогда.
"""

import json
import logging
import re
import time
from collections.abc import AsyncIterator
from typing import Any, Protocol

import httpx

from app.clients.speech import KEEPALIVE_LIMITS, pcm_to_wav
from app.core.config import LlmSettings
from app.services import usage as model_usage

logger = logging.getLogger("agent.llm")

# Вход голоса — PCM16 моно, 16 кГц (specs/agent-api «Голос — формат и ввод»).
STT_RATE = 16_000

ChatMessage = dict[str, str]


class ModelError(Exception):
    """Модель не ответила или ответила мусором."""


class ReplyTruncated(ModelError):
    """Ответ оборвался по лимиту токенов: поток прислал всё, что успел, последнее предложение может быть незаконченным."""


class ChatModel(Protocol):
    name: str

    async def complete(self, messages: list[ChatMessage]) -> str: ...

    def stream(self, messages: list[ChatMessage], usage_sink: list[dict[str, Any]] | None = None) -> AsyncIterator[str]:
        """Ответ кусками по мере написания. Оборванный по лимиту токенов поток кончается `ReplyTruncated`.

        `usage_sink` поддерживают не все реализации (ProxyChat — да): расход токенов хода, если модель его отдаёт.
        """
        ...

    async def aclose(self) -> None: ...


class Recognizer(Protocol):
    name: str

    async def transcribe(self, pcm: bytes) -> str: ...

    async def aclose(self) -> None: ...


def _record_chat_usage(model: str, usage: object) -> str:
    """Токены ответа чат-модели (`usage` в формате OpenAI) в учёт расхода; для журнала — «вход/выход» или «none».

    В потоке прокси присылает `usage` последним куском только по `stream_options.include_usage` (без него не присылает,
    проверено на живом прокси 2026-10-12). Нет `usage` — расход чат-модели не записывается, а в журнале видно `tokens=none`.
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


class ProxyChat:
    """Чат-модель через `POST {base_url}/chat/completions`, без стрима: ответ короткий и нужен целиком."""

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
            raise ModelError(f"Чат-модель не ответила: {error!r}") from error
        if response.status_code != 200:
            raise ModelError(f"Чат-модель ответила {response.status_code}: {response.text[:200]}")
        try:
            body = response.json()
            choice = body["choices"][0]
            text = (choice["message"]["content"] or "").strip()
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise ModelError(f"Чат-модель вернула неожиданный ответ: {response.text[:200]}") from error
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

    @model_usage.counted_stream("llm")
    async def stream(
        self, messages: list[ChatMessage], usage_sink: list[dict[str, Any]] | None = None
    ) -> AsyncIterator[str]:
        """Тот же запрос со `stream: true`: куски текста по мере написания (SSE `data: {...}` и `data: [DONE]`).

        `usage_sink` — необязательный список, куда кладётся расход токенов из финального служебного
        куска (`{"choices": [], "usage": {...}}`), если прокси его присылает: для трейсинга (Langfuse).
        """
        started = time.perf_counter()
        first_ms: int | None = None
        chars = 0
        finish: str | None = None
        usage: object = None
        try:
            async with self._client.stream(
                "POST",
                self._url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={
                    "model": self._model,
                    "messages": messages,
                    "max_tokens": self._max_tokens,
                    "temperature": self._temperature,
                    "stream": True,
                    "stream_options": {"include_usage": True},  # расход токенов последним куском
                },
            ) as response:
                if response.status_code != 200:
                    body = (await response.aread()).decode(errors="replace")
                    raise ModelError(f"Чат-модель ответила {response.status_code}: {body[:200]}")
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue  # комментарии-«пульс» и пустые строки SSE
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                        usage = chunk.get("usage") or usage  # расход приходит последним куском (часто без выбора)
                        choice = chunk["choices"][0]
                    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
                        continue  # служебный кусок без выбора (например, с расходом токенов)
                    finish = choice.get("finish_reason") or finish
                    piece = (choice.get("delta") or {}).get("content") or ""
                    if piece:
                        if first_ms is None:
                            first_ms = int((time.perf_counter() - started) * 1000)
                        chars += len(piece)
                        yield piece
        except httpx.HTTPError as error:
            raise ModelError(f"Чат-модель не ответила: {error!r}") from error
        tokens = _record_chat_usage(self._model, usage)
        if usage_sink is not None and isinstance(usage, dict):
            usage_sink.append(usage)  # расход хода для трассы Langfuse
        logger.info(
            "chat stream model=%s first_ms=%s ms=%d messages=%d chars=%d finish=%s tokens=%s",
            self._model,
            first_ms,
            (time.perf_counter() - started) * 1000,
            len(messages),
            chars,
            finish,
            tokens,
        )
        if finish == "length":
            raise ReplyTruncated("ответ оборван по лимиту токенов")

    async def aclose(self) -> None:
        await self._client.aclose()


class ProxyWhisper:
    """Распознавание русской речи (`whisper-large-v3`) через `POST {base_url}/audio/transcriptions`."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: int,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.name = f"proxy:{model}"
        self._url = f"{base_url.rstrip('/')}/audio/transcriptions"
        self._api_key = api_key
        self._model = model
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds, limits=KEEPALIVE_LIMITS)

    @model_usage.counted("stt")
    async def transcribe(self, pcm: bytes) -> str:
        started = time.perf_counter()
        try:
            response = await self._client.post(
                self._url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                data={"model": self._model, "language": "ru", "response_format": "json", "temperature": "0"},
                files={"file": ("speech.wav", pcm_to_wav(pcm, STT_RATE), "audio/wav")},
            )
        except httpx.HTTPError as error:
            raise ModelError(f"Распознавание не ответило: {error!r}") from error
        if response.status_code != 200:
            raise ModelError(f"Распознавание ответило {response.status_code}: {response.text[:200]}")
        try:
            text = str(response.json()["text"]).strip()
        except (ValueError, KeyError, TypeError) as error:
            raise ModelError(f"Распознавание вернуло неожиданный ответ: {response.text[:200]}") from error
        # Токенов у whisper нет: оплачиваются секунды отправленного звука, их и считаем сами.
        model_usage.record(self._model, "stt", "input", "audio", "seconds", round(len(pcm) / (2 * STT_RATE), 3))
        logger.info(
            "stt model=%s ms=%d audio_bytes=%d chars=%d",
            self._model,
            (time.perf_counter() - started) * 1000,
            len(pcm),
            len(text),
        )
        return text

    async def aclose(self) -> None:
        await self._client.aclose()


def build_models(settings: LlmSettings) -> tuple[ChatModel | None, Recognizer | None]:
    """Чат и распознавание по настройкам; `LLM_MODE=template` — без моделей."""
    if settings.mode == "template":
        return None, None
    if settings.api_key is None or not settings.base_url:
        raise RuntimeError("LLM_MODE=proxy, но не заданы AGENT_API_TOKEN (ключ прокси) и LLM_BASE_URL")
    key = settings.api_key.get_secret_value()
    chat = ProxyChat(
        settings.base_url,
        key,
        settings.chat_model,
        settings.max_tokens,
        settings.temperature,
        settings.timeout_seconds,
    )
    stt = ProxyWhisper(settings.base_url, key, settings.stt_model, settings.stt_timeout_seconds)
    return chat, stt
