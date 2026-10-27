"""Трейсинг LLM-ходов в Langfuse (app/core/tracing.py).

По умолчанию трейсинг выключен (NullTracer), и приложение ведёт себя как раньше. Здесь проверяются:
маскирование текстов при LANGFUSE_TRACE_TEXT=false, маппинг полей на SDK, устойчивость к сбоям SDK
и fail-fast валидация настроек (enabled без ключей — сервис не стартует).
"""

import os

import pytest

from app.core.config import LangfuseSettings
from app.core.tracing import (
    NULL_OBSERVATION,
    LangfuseObservation,
    LangfuseTracer,
    NullTracer,
    _mask,
    _mask_metadata,
    _mask_status,
    _usage_details,
)

MESSAGES = [{"role": "user", "content": "мне тяжело"}, {"role": "assistant", "content": "я рядом"}]


# ─── маскирование и расход ────────────────────────────────────────────────────


def test_mask_keeps_text_when_trace_text_on() -> None:
    assert _mask("привет", True) == "привет"
    assert _mask(MESSAGES, True) == MESSAGES


def test_mask_replaces_text_with_length_and_words_when_off() -> None:
    assert _mask("привет", False) == "[скрыто: 6 симв., 1 сл.]"
    masked = _mask(MESSAGES, False)
    assert masked[0]["role"] == "user"
    assert masked[0]["content"] == "[скрыто: 10 симв., 2 сл.]"
    assert "тяжело" not in str(masked)


def test_mask_hides_values_of_unexpected_types() -> None:
    assert _mask({"text": "мне плохо"}, False) == "[скрыто]"
    assert "плохо" not in str(_mask([{"role": "user", "content": "мне плохо"}, "мне плохо"], False))


def test_status_loses_the_provider_body_when_off() -> None:
    assert _mask_status("Чат-модель ответила 500: {мне плохо, я не знаю что делать}", False) == "Чат-модель ответила 500"
    assert _mask_status("Чат-модель ответила 500: тело", True) == "Чат-модель ответила 500: тело"
    assert _mask_status(None, False) is None


def test_metadata_keeps_numbers_and_short_names_but_not_long_strings() -> None:
    metadata = {"model": "gemini-3.8-live", "chars": 12, "audio_seconds": 1.5, "flag": True, "note": "мне плохо", "long": "а" * 80}
    masked = _mask_metadata(metadata, False)
    assert masked == {**metadata, "note": "[скрыто]", "long": "[скрыто]"}
    assert _mask_metadata(metadata, True) == metadata


def test_text_is_not_traced_by_default() -> None:
    assert LangfuseSettings().trace_text is False


def test_usage_details_keeps_only_ints() -> None:
    assert _usage_details(None) is None
    assert _usage_details({}) is None
    assert _usage_details({"prompt_tokens": 10, "model": "x", "cached": True}) == {"prompt_tokens": 10}


# ─── NullTracer ───────────────────────────────────────────────────────────────


async def test_null_tracer_is_a_noop() -> None:
    tracer = NullTracer()
    turn = tracer.start_turn(name="turn", session_id="d", user_id="u", input="текст")
    span = tracer.start_span(turn, name="tts")
    for observation in (turn, span):
        observation.update(input="x", output="y", usage={"prompt_tokens": 1}, level="ERROR")
        observation.end()
    await tracer.aclose()


# ─── LangfuseTracer поверх поддельного SDK ────────────────────────────────────


class FakeSpan:
    """Записывает вызовы вместо OTel-экспорта."""

    def __init__(self, name: str, kind: str, **kwargs: object) -> None:
        self.name = name
        self.kind = kind
        self.kwargs = kwargs
        self.trace: dict[str, object] = {}
        self.updates: list[dict[str, object]] = []
        self.children: list["FakeSpan"] = []
        self.ended = False

    def update_trace(self, **kwargs: object) -> None:
        self.trace.update(kwargs)

    def update(self, **kwargs: object) -> "FakeSpan":
        self.updates.append(kwargs)
        return self

    def start_span(self, name: str, **kwargs: object) -> "FakeSpan":
        child = FakeSpan(name, "span", **kwargs)
        self.children.append(child)
        return child

    def start_generation(self, name: str, **kwargs: object) -> "FakeSpan":
        child = FakeSpan(name, "generation", **kwargs)
        self.children.append(child)
        return child

    def end(self) -> None:
        self.ended = True


class FakeLangfuseClient:
    def __init__(self) -> None:
        self.traces: list[FakeSpan] = []
        self.flushed = False

    def start_generation(self, name: str, **kwargs: object) -> FakeSpan:
        span = FakeSpan(name, "generation", **kwargs)
        self.traces.append(span)
        return span

    def flush(self) -> None:
        self.flushed = True


def make_tracer(trace_text: bool = True) -> tuple[LangfuseTracer, FakeLangfuseClient]:
    client = FakeLangfuseClient()
    tracer = LangfuseTracer.__new__(LangfuseTracer)
    tracer._client = client
    tracer._trace_text = trace_text
    tracer.name = "langfuse:fake"
    return tracer, client


async def test_turn_trace_maps_fields_to_sdk() -> None:
    tracer, client = make_tracer()
    turn = tracer.start_turn(
        name="live_turn_voice",
        session_id="dialog-1",
        user_id="user-1",
        model="gemini-3.8-live",
        input="как дела?",
        metadata={"kind": "voice"},
        tags=["gemini_live"],
    )
    turn.update(output="хорошо", usage={"prompt_audio": 100, "model": "x"}, metadata={"ms_out_first": 800})
    turn.end()

    root = client.traces[0]
    assert root.kind == "generation"
    assert root.kwargs["model"] == "gemini-3.8-live"
    assert root.kwargs["input"] == "как дела?"
    assert root.trace == {"session_id": "dialog-1", "user_id": "user-1", "tags": ["gemini_live"]}
    assert root.updates[0]["output"] == "хорошо"
    assert root.updates[0]["usage_details"] == {"prompt_audio": 100}  # не-числа отброшены
    assert root.ended


async def test_trace_text_off_masks_input_and_output() -> None:
    tracer, client = make_tracer(trace_text=False)
    turn = tracer.start_turn(name="t", session_id="d", user_id="u", input="мне плохо")
    turn.update(output="я рядом")
    turn.end()
    root = client.traces[0]
    assert root.kwargs["input"] == "[скрыто: 9 симв., 2 сл.]"
    assert root.updates[0]["output"] == "[скрыто: 7 симв., 2 сл.]"
    assert "плохо" not in str(root.kwargs) and "рядом" not in str(root.updates)


async def test_trace_text_off_keeps_sizes_and_no_text_anywhere() -> None:
    """Ни в одном поле трассы (вход, выход, метаданные, статус, вложенные наблюдения) нет текста реплики."""
    tracer, client = make_tracer(trace_text=False)
    secret = "мне очень тяжело сегодня"
    turn = tracer.start_turn(name="t", session_id="d", user_id="u", input=secret, metadata={"user_chars": len(secret)})
    first = tracer.start_span(turn, name="tts", input=secret, metadata={"text": secret})
    first.update(output=secret, level="ERROR", status=f"Озвучка ответила 500: {secret}", metadata={"user_words": 4})
    second = tracer.start_span(turn, name="tts", input=secret, metadata={"text": secret})
    second.update(output=secret)
    for observation in (second, first, turn):
        observation.end()
    root = client.traces[0]
    dump = str(root.kwargs) + str(root.updates) + str([(c.kwargs, c.updates) for c in root.children])
    assert "тяжело" not in dump
    assert "user_chars" in dump and "user_words" in dump


async def test_child_spans_hang_under_the_turn() -> None:
    tracer, client = make_tracer()
    turn = tracer.start_turn(name="live_turn_voice", session_id="d", user_id="u")
    first = tracer.start_span(turn, name="tts", metadata={"first": True, "chars": 8})
    second = tracer.start_span(turn, name="tts", metadata={"first": False, "chars": 14})
    first.update(output="Я рядом.")
    first.end()
    second.update(output="С чего начнём?")
    second.end()
    turn.end()
    root = client.traces[0]
    assert [child.name for child in root.children] == ["tts", "tts"]
    assert all(child.kind == "span" for child in root.children)
    assert all(child.ended for child in root.children)


async def test_orphan_children_are_skipped() -> None:
    tracer, client = make_tracer()
    assert tracer.start_span(None, name="tts") is NULL_OBSERVATION
    assert tracer.start_span(NULL_OBSERVATION, name="tts") is NULL_OBSERVATION
    assert client.traces == []


async def test_children_of_an_ended_parent_are_skipped() -> None:
    tracer, client = make_tracer()
    turn = tracer.start_turn(name="t", session_id="d", user_id="u")
    turn.end()
    assert tracer.start_span(turn, name="tts") is NULL_OBSERVATION
    assert client.traces[0].children == []


async def test_update_after_end_is_ignored() -> None:
    tracer, client = make_tracer()
    turn = tracer.start_turn(name="t", session_id="d", user_id="u")
    turn.end()
    turn.end()  # повторный end безопасен
    turn.update(output="поздно")
    assert client.traces[0].updates == []


async def test_sdk_failure_falls_back_to_null_and_never_raises() -> None:
    tracer, _ = make_tracer()

    class BrokenSpan(FakeSpan):
        def update(self, **kwargs: object) -> "BrokenSpan":
            raise RuntimeError("otel сломан")

        def end(self) -> None:
            raise RuntimeError("otel сломан")

    def broken_start(name: str, **kwargs: object) -> BrokenSpan:
        return BrokenSpan(name, "generation", **kwargs)

    tracer._client.start_generation = broken_start  # type: ignore[method-assign]
    turn = tracer.start_turn(name="t", session_id="d", user_id="u")  # не падает
    turn.update(output="x")  # warning в журнал, исключения нет
    turn.end()
    tracer._client.start_generation = lambda name, **kwargs: (_ for _ in ()).throw(RuntimeError("sdk down"))  # type: ignore[method-assign]
    assert tracer.start_turn(name="t", session_id="d", user_id="u") is NULL_OBSERVATION


async def test_aclose_flushes() -> None:
    tracer, client = make_tracer()
    await tracer.aclose()
    assert client.flushed


# ─── настройки: fail-fast ─────────────────────────────────────────────────────


def test_enabled_without_keys_fails_fast() -> None:
    from pydantic import ValidationError

    from app.core.config import LangfuseSettings

    os.environ["LANGFUSE_ENABLED"] = "true"
    os.environ.pop("LANGFUSE_PUBLIC_KEY", None)
    os.environ.pop("LANGFUSE_SECRET_KEY", None)
    try:
        with pytest.raises(ValidationError, match="LANGFUSE_PUBLIC_KEY"):
            LangfuseSettings()
    finally:
        os.environ.pop("LANGFUSE_ENABLED", None)


def test_disabled_by_default() -> None:
    from app.core.config import LangfuseSettings
    from app.core.tracing import build_tracer

    assert build_tracer(LangfuseSettings()).name == "null"


def test_native_fastapi_telemetry_is_off() -> None:
    """Встроенная телеметрия FastAPI не должна слать в Langfuse трассы запросов (GET /health, пути с id человека)."""
    from app.main import create_app

    config = create_app()._telemetry  # type: ignore[attr-defined]
    assert config["tracing"] is False and config["operation_spans"] is False and config["auto_configure"] is False
