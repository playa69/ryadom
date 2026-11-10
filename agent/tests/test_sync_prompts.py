"""Внешний seed: `openspec/changes/add-langfuse-prompt-management`, «Начальная загрузка не затирает административные изменения»."""

import json
from pathlib import Path
from typing import Any

import pytest

from app.prompts.catalog import PROMPT_CATALOG
from scripts.sync_prompts import SeedError, load_seed, sync_prompts


class NotFoundError(Exception):
    """Отсутствующий production-промпт."""

    status_code = 404


class RemotePrompt:
    """Существующая административная версия."""

    def __init__(self, text: str, version: int = 1) -> None:
        self.prompt = text
        self.version = version


class SyncClient:
    """In-memory Langfuse для проверки создания и запрета перезаписи."""

    def __init__(self, existing: dict[str, str] | None = None) -> None:
        self.existing = existing or {}
        self.created: list[dict[str, Any]] = []

    def get_prompt(self, name: str, **kwargs: Any) -> RemotePrompt:
        """Возвращает production-версию или 404."""
        assert kwargs["label"] == "production"
        if name not in self.existing:
            raise NotFoundError(name)
        return RemotePrompt(self.existing[name])

    def create_prompt(self, **kwargs: Any) -> None:
        """Сохраняет вызов создания."""
        self.created.append(kwargs)
        self.existing[kwargs["name"]] = kwargs["prompt"]


def seed() -> dict[str, str]:
    """Создаёт полный набор коротких синтетических текстов."""
    return {name: f"seed:{name}" for name in PROMPT_CATALOG}


def test_seed_must_be_complete_and_outside_repository(tmp_path: Path) -> None:
    """Файл проверяется до обращения к Langfuse и не может лежать в git."""
    path = tmp_path / "prompts.json"
    path.write_text(json.dumps(seed()), encoding="utf-8")
    assert load_seed(path) == seed()
    path.write_text("{}", encoding="utf-8")
    with pytest.raises(SeedError):
        load_seed(path)
    inside = Path(__file__).parents[1] / "seed.json"
    with pytest.raises(SeedError):
        load_seed(inside)


def test_empty_project_creates_exactly_catalog_once() -> None:
    """Первичная загрузка создаёт 16 production-версий, повторная ничего не меняет."""
    client = SyncClient()
    assert len(sync_prompts(client, seed())) == 16
    assert len(client.created) == 16
    assert all(call["labels"] == ["production"] for call in client.created)
    assert all(call["tags"] for call in client.created)
    assert sync_prompts(client, seed()) == [f"same {name}" for name in PROMPT_CATALOG]
    assert len(client.created) == 16


def test_administrative_change_is_never_overwritten() -> None:
    """Отличающаяся production-версия сохраняет текст и label."""
    client = SyncClient({"agent.dialog.system": "Административная версия"})
    statuses = sync_prompts(client, seed())
    assert "changed — skipped agent.dialog.system" in statuses
    assert client.existing["agent.dialog.system"] == "Административная версия"
    assert all(call["name"] != "agent.dialog.system" for call in client.created)


def test_check_does_not_create_anything() -> None:
    """Режим без seed только сообщает missing/present."""
    client = SyncClient()
    assert sync_prompts(client) == [f"missing {name}" for name in PROMPT_CATALOG]
    assert client.created == []
