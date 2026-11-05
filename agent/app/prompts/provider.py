"""Production-промпты Langfuse без локального текстового резерва."""

import logging
import threading
from dataclasses import dataclass
from typing import Any, Protocol

from app.core.config import LangfuseSettings
from app.prompts.catalog import PROMPT_CATALOG

logger = logging.getLogger("agent.prompts")

PRODUCTION_LABEL = "production"
CACHE_TTL_SECONDS = 60
FETCH_TIMEOUT_SECONDS = 2
MAX_RETRIES = 1


class PromptUnavailable(RuntimeError):
    """Production-инструкция недоступна, поэтому модельный вызов нельзя собрать."""


@dataclass(frozen=True)
class ResolvedPrompt:
    """Скомпилированная инструкция и безопасные сведения о её версии."""

    name: str
    text: str
    version: int
    prompt: Any
    source: str = "langfuse"

    @property
    def metadata(self) -> dict[str, str | int]:
        """Возвращает метаданные без текста инструкции."""
        return {"name": self.name, "version": self.version, "source": self.source}


class PromptProvider(Protocol):
    """Источник инструкций для нового вызова модели."""

    def resolve(self, name: str, **variables: Any) -> ResolvedPrompt: ...

    def preload(self) -> None: ...


class LangfusePromptProvider:
    """SDK-кэш production-label без параметра fallback."""

    def __init__(self, settings: LangfuseSettings, client: Any = None) -> None:  # noqa: ANN401 — SDK или тестовая подделка
        if client is None and settings.tracing_active:
            from langfuse import Langfuse

            if settings.public_key is None or settings.secret_key is None:
                raise RuntimeError("для LangfusePromptProvider нужны оба ключа")
            client = Langfuse(
                public_key=settings.public_key.get_secret_value(),
                secret_key=settings.secret_key.get_secret_value(),
                host=settings.host,
            )
        self._client = client
        self._preload_lock = threading.Lock()
        self._preload_started = False

    def resolve(self, name: str, **variables: Any) -> ResolvedPrompt:
        if self._client is None:
            raise PromptUnavailable(f"{name}: не настроены ключи Langfuse")
        try:
            prompt = self._client.get_prompt(
                name,
                label=PRODUCTION_LABEL,
                cache_ttl_seconds=CACHE_TTL_SECONDS,
                max_retries=MAX_RETRIES,
                fetch_timeout_seconds=FETCH_TIMEOUT_SECONDS,
            )
            text = prompt.compile(**variables)
            if not isinstance(text, str) or not text.strip():
                raise ValueError("empty prompt")
            return ResolvedPrompt(name, text, int(prompt.version), prompt)
        except Exception as error:
            logger.warning(
                "prompt unavailable name=%s error=%s", name, type(error).__name__
            )
            raise PromptUnavailable(f"{name}: production-промпт недоступен") from None

    def preload(self) -> None:
        """Запускает одну фоновую предзагрузку всего каталога."""
        if self._client is None:
            raise PromptUnavailable("не настроены ключи Langfuse")
        with self._preload_lock:
            if self._preload_started:
                return
            self._preload_started = True
        thread = threading.Thread(
            target=self._preload_all, name="langfuse-prompts", daemon=True
        )
        thread.start()

    def _preload_all(self) -> None:
        for name in PROMPT_CATALOG:
            try:
                self.resolve(name)
            except PromptUnavailable:
                pass


def build_prompt_provider(settings: LangfuseSettings) -> PromptProvider:
    """Создаёт единственный источник инструкций независимо от наличия ключей."""
    return LangfusePromptProvider(settings)


def prompt_metadata(resolved: ResolvedPrompt | None) -> dict[str, str | int]:
    """Метаданные одиночной инструкции для generation или span."""
    if resolved is None:
        return {}
    return {
        "prompt_name": resolved.name,
        "prompt_version": resolved.version,
        "prompt_source": resolved.source,
    }


def components_metadata(
    components: list[ResolvedPrompt],
) -> dict[str, list[dict[str, str | int]]]:
    """Метаданные составной инструкции без её текста."""
    return {"prompt_components": [component.metadata for component in components]}
