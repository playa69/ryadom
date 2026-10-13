"""Приёмник Langfuse получает те же числа, что и база диалогов, и не уносит текст реплики."""

import json

import httpx
import pytest
from pydantic import ValidationError

from app.core.config import LangfuseSettings
from app.services.langfuse_usage import LangfuseUsageSink, events_for, start_langfuse_sink
from app.services.usage import Usage, install_langfuse, record


def test_events_carry_tokens_and_no_prompt_fields() -> None:
    events = events_for(Usage("gemini-3.8-live", "live", "input", "audio", "tokens", 12))
    generation = next(event["body"] for event in events if event["type"] == "generation-create")
    assert generation["model"] == "gemini-3.8-live"
    assert generation["usageDetails"] == {"input": 12}
    assert generation["metadata"]["modality"] == "audio"
    assert "input" not in generation
    assert "output" not in generation
    assert "привет" not in json.dumps(events)


def test_non_token_units_do_not_land_in_input_output() -> None:
    events = events_for(Usage("whisper-large-v3", "stt", "input", "audio", "seconds", 1.5))
    generation = next(event["body"] for event in events if event["type"] == "generation-create")
    assert generation["usageDetails"] == {"input_audio_seconds": 1.5}
    assert "input" not in generation["usageDetails"]


def test_flush_posts_a_batch_and_a_failure_does_not_raise() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        assert request.headers["authorization"].startswith("Basic ")
        return httpx.Response(207, json={"successes": [], "errors": []})

    sink = LangfuseUsageSink("http://langfuse.test", "pk", "sk", client=httpx.Client(transport=httpx.MockTransport(handler)), start_thread=False)
    sink.emit(Usage("chat-model", "chat", "output", "text", "tokens", 9))
    sink.flush()
    assert seen[0]["batch"][1]["body"]["usageDetails"] == {"output": 9}

    def fail(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"message": "down"})

    broken = LangfuseUsageSink("http://langfuse.test", "pk", "sk", client=httpx.Client(transport=httpx.MockTransport(fail)), start_thread=False)
    broken.emit(Usage("chat-model", "chat", "input", "text", "tokens", 3))
    broken.flush()


def test_record_forwards_to_the_installed_sink() -> None:
    seen: list[Usage] = []

    class Fake:
        def emit(self, item: Usage) -> None:
            seen.append(item)

    install_langfuse(Fake())
    try:
        record("chat-model", "chat", "input", "text", "tokens", 4)
        record("chat-model", "chat", "input", "text", "tokens", 0)
    finally:
        install_langfuse(None)
    assert seen == [Usage("chat-model", "chat", "input", "text", "tokens", 4)]


def test_sink_stays_off_by_default_and_when_only_tracing_is_on() -> None:
    off = LangfuseSettings(LANGFUSE_HOST="http://langfuse.test")
    assert off.usage_sink_active is False
    assert start_langfuse_sink(off) is None
    tracing_only = LangfuseSettings(
        LANGFUSE_ENABLED="true", LANGFUSE_HOST="http://langfuse.test", LANGFUSE_PUBLIC_KEY="pk", LANGFUSE_SECRET_KEY="sk"
    )
    # Расход ходов уже идёт в трассах: приёмник отдельно, иначе в Langfuse он задвоится.
    assert tracing_only.usage_sink_active is False
    assert start_langfuse_sink(tracing_only) is None


def test_sink_starts_only_with_its_own_switch() -> None:
    settings = LangfuseSettings(
        LANGFUSE_ENABLED="true",
        LANGFUSE_USAGE_SINK="true",
        LANGFUSE_HOST="http://langfuse.test",
        LANGFUSE_PUBLIC_KEY="pk",
        LANGFUSE_SECRET_KEY="sk",
    )
    assert settings.usage_sink_active is True
    sink = start_langfuse_sink(settings)
    try:
        assert sink is not None
    finally:
        install_langfuse(None)
        if sink is not None:
            sink.close()


def test_host_without_scheme_is_rejected() -> None:
    with pytest.raises(ValidationError, match="LANGFUSE_HOST"):
        LangfuseSettings(LANGFUSE_HOST="langfuse-web.infra:3000", LANGFUSE_PUBLIC_KEY="pk", LANGFUSE_SECRET_KEY="sk")
