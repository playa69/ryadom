"""Имена и назначение промптов; их тексты хранятся только в Langfuse."""

from dataclasses import dataclass


@dataclass(frozen=True)
class PromptDefinition:
    """Идентификатор инструкции и метки её назначения."""

    name: str
    tags: tuple[str, ...]


_DEFINITIONS = (
    PromptDefinition(
        "agent.dialog.system",
        ("agent", "dialog", "gemini-live", "sber", "session-open"),
    ),
    PromptDefinition(
        "agent.dialog.live-addendum",
        ("agent", "dialog", "gemini-live", "sber", "session-open"),
    ),
    PromptDefinition(
        "agent.dialog.memory-rules",
        ("agent", "dialog", "memory", "gemini-live", "sber", "session-open"),
    ),
    PromptDefinition(
        "agent.dialog.self-gender.male",
        ("agent", "dialog", "voice", "gemini-live", "session-open"),
    ),
    PromptDefinition(
        "agent.dialog.self-gender.female",
        ("agent", "dialog", "voice", "gemini-live", "sber", "session-open"),
    ),
    PromptDefinition(
        "agent.dialog.sber-voice-rules", ("agent", "dialog", "sber", "session-open")
    ),
    PromptDefinition(
        "agent.dialog.gemini-tts-verbatim",
        ("agent", "dialog", "tts", "gemini-live", "phrase"),
    ),
    PromptDefinition(
        "agent.mood.instructions", ("agent", "mood", "gemini-live", "sber", "classify")
    ),
    PromptDefinition(
        "agent.mood.sber-json-suffix", ("agent", "mood", "sber", "classify")
    ),
    PromptDefinition(
        "agent.recap.system", ("agent", "recap", "background", "dialog-recap")
    ),
    PromptDefinition(
        "agent.digest.weekly.system", ("agent", "digest", "background", "weekly-digest")
    ),
    PromptDefinition(
        "agent.digest.weekly.task",
        ("agent", "digest", "background", "weekly-digest", "template"),
    ),
    PromptDefinition(
        "agent.digest.weekly.hard-week-suffix",
        ("agent", "digest", "background", "weekly-digest", "hard-week"),
    ),
    PromptDefinition(
        "agent.memory.extract.system", ("agent", "memory", "background", "extract")
    ),
    PromptDefinition(
        "agent.memory.instruction.system", ("agent", "memory", "background", "instruct")
    ),
)

PROMPT_CATALOG = {definition.name: definition for definition in _DEFINITIONS}


def prompt_definition(name: str) -> PromptDefinition:
    """Возвращает метаданные промпта из каталога."""
    return PROMPT_CATALOG[name]
