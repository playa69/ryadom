"""Langfuse-only: `openspec/changes/add-langfuse-prompt-management`, «Управляемое применение версии в runtime» и «Работа только с инструкциями Langfuse»."""

import threading
from typing import Any

import pytest

from app.core.config import LangfuseSettings
from app.prompts.catalog import PROMPT_CATALOG
from app.prompts.provider import LangfusePromptProvider, PromptUnavailable


class FakePrompt:
    """Ответ SDK с управляемым результатом компиляции."""

    def __init__(
        self, text: str = "Синтетическая удалённая инструкция", *, broken: bool = False
    ) -> None:
        self.text = text
        self.prompt = text
        self.version = 7
        self.broken = broken

    def compile(self, **variables: Any) -> str:
        """Возвращает текст или имитирует ошибку переменных."""
        if self.broken:
            raise KeyError("missing")
        return self.text


class FakePromptClient:
    """Фиксирует production-запросы без сети."""

    def __init__(self, prompt: FakePrompt | Exception | None = None) -> None:
        self.prompt = prompt or FakePrompt()
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.all_loaded = threading.Event()

    def get_prompt(self, name: str, **kwargs: Any) -> FakePrompt:
        """Возвращает заданный prompt object или ошибку."""
        self.calls.append((name, kwargs))
        if len(self.calls) == len(PROMPT_CATALOG):
            self.all_loaded.set()
        if isinstance(self.prompt, Exception):
            raise self.prompt
        return self.prompt


def settings() -> LangfuseSettings:
    """Создаёт настройки с синтетическими ключами."""
    return LangfuseSettings.model_validate(
        {"LANGFUSE_PUBLIC_KEY": "public-test", "LANGFUSE_SECRET_KEY": "secret-test"}
    )


def test_remote_provider_requests_only_production_without_fallback() -> None:
    """Удалённая версия возвращается с prompt object, локальный текст не передаётся SDK."""
    client = FakePromptClient()
    resolved = LangfusePromptProvider(settings(), client).resolve("agent.dialog.system")
    _, kwargs = client.calls[0]
    assert kwargs == {
        "label": "production",
        "cache_ttl_seconds": 60,
        "max_retries": 1,
        "fetch_timeout_seconds": 2,
    }
    assert "fallback" not in kwargs
    assert (resolved.text, resolved.version, resolved.source) == (
        "Синтетическая удалённая инструкция",
        7,
        "langfuse",
    )
    assert resolved.prompt is client.prompt


def test_missing_keys_and_network_errors_do_not_create_fallback() -> None:
    """Без ключей или при ошибке сети вызов завершается PromptUnavailable."""
    with pytest.raises(PromptUnavailable):
        LangfusePromptProvider(LangfuseSettings()).resolve("agent.dialog.system")
    provider = LangfusePromptProvider(
        settings(), FakePromptClient(RuntimeError("down"))
    )
    with pytest.raises(PromptUnavailable):
        provider.resolve("agent.dialog.system")


def test_compile_error_does_not_use_local_template() -> None:
    """Ошибка компиляции не подставляет шаблон из репозитория."""
    provider = LangfusePromptProvider(
        settings(), FakePromptClient(FakePrompt(broken=True))
    )
    with pytest.raises(PromptUnavailable):
        provider.resolve("agent.digest.weekly.task", period_start="2026-11-02")


def test_empty_remote_prompt_is_rejected() -> None:
    """Пустая удалённая инструкция не уходит модели."""
    provider = LangfusePromptProvider(settings(), FakePromptClient(FakePrompt(" ")))
    with pytest.raises(PromptUnavailable):
        provider.resolve("agent.dialog.system")


def test_preload_covers_catalog_and_tolerates_failures() -> None:
    """Предзагрузка читает весь каталог и не падает при ошибке одного промпта."""
    client = FakePromptClient(RuntimeError("down"))
    provider = LangfusePromptProvider(settings(), client)
    provider.preload()
    provider.preload()
    assert client.all_loaded.wait(2)
    assert {name for name, _ in client.calls} == set(PROMPT_CATALOG)
