"""Прозрачность отказов (PROTEUS-282): код причины, строка журнала с полями, счётчики ошибок и перехода на запасной путь."""

import logging

import pytest
from prometheus_client import REGISTRY

from app.clients.gemini_live import LiveError
from app.clients.sber_voice import FallbackConnector, FallbackTts
from app.core.failure import record_failure
from app.core.reasons import REASONS, classify
from app.services import usage as model_usage
from tests.test_sber_voice import _Opener, _Tts


def errors(component: str, pipeline: str, reason: str) -> float:
    labels = {"component": component, "pipeline": pipeline, "reason": reason}
    return REGISTRY.get_sample_value("agent_component_errors_total", labels) or 0.0


def fallbacks(source: str, target: str, scope: str, reason: str) -> float:
    labels = {"from": source, "to": target, "scope": scope, "reason": reason}
    return REGISTRY.get_sample_value("agent_pipeline_fallbacks_total", labels) or 0.0


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (LiveError("Gemini Live не открылся: APIError: 1011 You exceeded your current quota"), "quota"),
        (TimeoutError(), "timeout"),
        ("GigaASR не прислал расшифровку: таймаут", "timeout"),
        ("GigaChat ответил 401: unauthorized", "auth"),
        ("GigaASR не открылся: ConnectionRefusedError", "connect"),
        ("соединение закрыто", "closed"),
        ("SaluteSpeech вернул пустое аудио", "empty"),
        ("Фоновая модель ответила 502", "bad_response"),
        ("что-то совсем другое", "unknown"),
    ],
)
def test_reason_code_comes_from_the_error_and_is_from_the_closed_set(error: object, reason: str) -> None:
    assert classify(error) == reason
    assert reason in REASONS


def test_failure_line_has_the_fields_and_no_vendor_text(caplog: pytest.LogCaptureFixture) -> None:
    before = errors("gigaasr", "sber", "closed")
    with caplog.at_level(logging.WARNING, logger="agent.test"):
        record_failure(
            logging.getLogger("agent.test"), "voice link closed", "gigaasr", "sber", RuntimeError("секретный ответ вендора, соединение закрыто"),
            dialog_id="d-1", turn="t-1", user_id="u-1",
        )
    line = caplog.messages[0]
    for field in ("component=gigaasr", "reason=closed", "pipeline=sber", "dialog_id=d-1", "turn=t-1", "user_id=u-1"):
        assert field in line
    assert "секретный" not in line
    assert errors("gigaasr", "sber", "closed") == before + 1


def test_component_call_carries_pipeline_and_reason_to_the_session() -> None:
    seen: list[tuple] = []
    model_usage.bind_calls(lambda *args: seen.append(args))
    model_usage.call("live", "error", pipeline="sber", reason="timeout")
    assert seen == [("live", "error", False, "sber", "timeout")]


async def test_primary_that_does_not_open_counts_a_fallback_with_the_reason() -> None:
    before = fallbacks("sber", "gemini", "connect", "connect")
    sber, gemini = _Opener("sber", fail=True), _Opener("gemini")
    sber.pipeline, gemini.pipeline = "sber", "gemini"
    sber.fail_text = "GigaASR не открылся: ConnectionRefusedError"
    await FallbackConnector(sber, gemini).open("male", "промпт")
    assert fallbacks("sber", "gemini", "connect", "connect") == before + 1


async def test_phrase_voiced_by_the_fallback_counts_the_vendor_error_and_the_fallback() -> None:
    errors_before = errors("salutespeech", "sber", "unknown")
    fallbacks_before = fallbacks("sber", "gemini", "tts", "unknown")
    tts = FallbackTts(_Tts("salute", fail_after=0), _Tts("gemini", [b"\x01\x00"]), "sber", "gemini")
    assert await tts.synthesize("Привет.", "male") == b"\x01\x00"
    assert errors("salutespeech", "sber", "unknown") == errors_before + 1
    assert fallbacks("sber", "gemini", "tts", "unknown") == fallbacks_before + 1

