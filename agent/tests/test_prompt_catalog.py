"""Каталог имён: `openspec/changes/add-langfuse-prompt-management`, «Каталог промптов агента»."""

from dataclasses import fields
from pathlib import Path

from app.prompts.catalog import PROMPT_CATALOG
from app.services import replies

EXPECTED_NAMES = {
    "agent.dialog.system",
    "agent.dialog.live-addendum",
    "agent.dialog.memory-rules",
    "agent.dialog.self-gender.male",
    "agent.dialog.self-gender.female",
    "agent.dialog.sber-voice-rules",
    "agent.dialog.gemini-tts-verbatim",
    "agent.mood.instructions",
    "agent.mood.sber-json-suffix",
    "agent.safety.risk",
    "agent.recap.system",
    "agent.digest.weekly.system",
    "agent.digest.weekly.task",
    "agent.digest.weekly.hard-week-suffix",
    "agent.memory.extract.system",
    "agent.memory.instruction.system",
}


def test_catalog_contains_only_names_and_tags() -> None:
    """В каталоге нет поля для текста или локального резерва."""
    assert set(PROMPT_CATALOG) == EXPECTED_NAMES
    assert {field.name for field in fields(next(iter(PROMPT_CATALOG.values())))} == {
        "name",
        "tags",
    }
    for definition in PROMPT_CATALOG.values():
        assert "agent" in definition.tags
        assert len(definition.tags) >= 4


def test_repository_has_no_markdown_prompt_backup() -> None:
    """Прежние файлы инструкций памяти удалены."""
    prompt_dir = Path(__file__).parents[1] / "app" / "memory" / "prompts"
    assert not (prompt_dir / "extract.md").exists()
    assert not (prompt_dir / "instruction.md").exists()


def test_deterministic_safety_mechanisms_remain_code() -> None:
    """Кризисный ответ не входит в удалённо редактируемый каталог."""
    assert callable(replies.is_crisis)
    assert all("кризис" not in name for name in PROMPT_CATALOG)
