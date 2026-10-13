"""Трейсинг LLM-ходов в Langfuse (app/core/tracing.py).

По умолчанию трейсинг выключен (NullTracer), и приложение ведёт себя как раньше. Здесь проверяются:
маскирование текстов при LANGFUSE_TRACE_TEXT=false, маппинг полей на SDK, устойчивость к сбоям SDK
и fail-fast валидация настроек (enabled без ключей — сервис не стартует).
"""

import os

import pytest

from app.core.tracing import NULL_OBSERVATION, LangfuseObservation, LangfuseTracer, NullTracer, _mask, _usage_details

MESSAGES = [{"role": "user", "content": "мне тяжело"}, {"role": "assistant", "content": "я рядом"}]


# ─── маскирование и расход ────────────────────────────────────────────────────


def test_mask_keeps_text_when_trace_text_on() -> None:
    assert _mask("привет", True) == "привет"
    assert _mask(MESSAGES, True) == MESSAGES


def test_mask_replaces_text_with_length_when_off() -> None:
    assert _mask("привет", False) == "[скрыто, 6 симв.]"
    masked = _mask(MESSAGES, False)
    assert masked[0]["role"] == "user"
    assert masked[0]["content"] == "[скрыто, 10 симв.]"
    assert "тяжело" not in str(masked)


def test_usage_details_keeps_only_ints() -> None:
    assert _usage_details(None) is None
    assert _usage_details({}) is None
    assert _usage_details({"prompt_tokens": 10, "model": "x", "cached": True}) == {"prompt_tokens": 10}


# ─── NullTracer ───────────────────────────────────────────────────────────────


async def test_null_tracer_is_a_noop() -> None:
    tracer = NullTracer()
    turn = tracer.start_turn(name="turn", session_id="d", user_id="u", input="текст")
    span = tracer.start_span(turn, name="stt")
    generation = tracer.start_generation(turn, name="chat")
    for observation in (turn, span, generation):
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
    assert root.kwargs["input"] == "[скрыто, 9 симв.]"
    assert root.updates[0]["output"] == "[скрыто, 7 симв.]"
    assert "плохо" not in str(root.kwargs) and "рядом" not in str(root.updates)


async def test_child_span_and_generation_hang_under_the_turn() -> None:
    tracer, client = make_tracer()
    turn = tracer.start_turn(name="voice_turn", session_id="d", user_id="u")
    stt = tracer.start_span(turn, name="stt", metadata={"audio_bytes": 100})
    chat = tracer.start_generation(turn, name="chat", model="proxy:gigachat", input=MESSAGES)
    stt.update(output="расшифровка")
    stt.end()
    chat.update(output="ответ", usage={"prompt_tokens": 50})
    chat.end()
    turn.end()
    root = client.traces[0]
    assert [child.name for child in root.children] == ["stt", "chat"]
    assert root.children[1].kind == "generation"
    assert all(child.ended for child in root.children)


async def test_orphan_children_are_skipped() -> None:
    tracer, client = make_tracer()
    assert tracer.start_span(None, name="stt") is NULL_OBSERVATION
    assert tracer.start_generation(NULL_OBSERVATION, name="chat") is NULL_OBSERVATION
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
