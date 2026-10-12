"""Модель для извлечения памяти (MEM-7.7): OpenAI-совместимый `POST {base_url}/chat/completions` прокси программы (в РФ).

Отдельный клиент, а не `ProxyChat`: другие параметры (температура 0, свой лимит токенов и таймаут), без `response_format` (не все
модели прокси его поддерживают) и без текста ответа в ошибках и журнале — в нём факты о человеке (I4). Адрес Gemini сюда
подставлять нельзя (решение B2): такой адрес отвергается, и память остаётся недоступной.
"""

import logging
import time
from typing import Protocol

import httpx

from app.core.config import LlmSettings, MemorySettings

logger = logging.getLogger("agent.memory")

_FOREIGN = ("googleapis.com", "generativelanguage", "gemini", "openai.com", "anthropic.com")


class MemoryModelError(Exception):
    """Модель извлечения не ответила или ответила не так. `code` — метка метрики: model | timeout. Текста ответа здесь нет."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"memory model failed: {code} {detail}".strip())
        self.code = code


class ExtractionModel(Protocol):
    name: str

    async def complete(self, messages: list[dict[str, str]]) -> str: ...

    async def aclose(self) -> None: ...


class MemoryLlm:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        max_tokens: int,
        timeout_seconds: int,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.name = f"proxy:{model}"
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._api_key = api_key
        self._model = model
        self._max_tokens = max_tokens
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)

    async def complete(self, messages: list[dict[str, str]]) -> str:
        started = time.perf_counter()
        try:
            response = await self._client.post(
                self._url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={"model": self._model, "messages": messages, "max_tokens": self._max_tokens, "temperature": 0},
            )
        except httpx.TimeoutException as error:
            raise MemoryModelError("timeout") from error
        except httpx.HTTPError as error:
            raise MemoryModelError("model", type(error).__name__) from error
        if response.status_code != 200:
            raise MemoryModelError("model", f"status={response.status_code}")
        try:
            text = response.json()["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise MemoryModelError("model", "unexpected response shape") from error
        logger.info(
            "memory model=%s ms=%d messages=%d chars=%d",
            self._model,
            (time.perf_counter() - started) * 1000,
            len(messages),
            len(text),
        )
        return text

    async def aclose(self) -> None:
        await self._client.aclose()


def build_memory_llm(memory: MemorySettings, llm: LlmSettings) -> MemoryLlm | None:
    """Клиент модели извлечения или None, если нет адреса или ключа (тогда память «unavailable», агент работает дальше)."""
    base_url = memory.llm_base_url or llm.base_url
    api_key = llm.api_key.get_secret_value() if llm.api_key else ""
    if not base_url or not api_key:
        return None
    if any(marker in base_url.lower() for marker in _FOREIGN):
        logger.error("memory model address is not allowed (extraction must stay in Russia): memory is unavailable")
        return None
    return MemoryLlm(
        base_url,
        api_key,
        memory.llm_model or llm.chat_model,
        memory.llm_max_tokens,
        memory.llm_timeout_seconds,
    )
