import pytest

from app.services.failure import Failure, classify_failure


# openspec/changes/clear-voice-failure-reasons, «Причина сбоя голоса в журнале и метриках»
@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        ("TtsError: SaluteSpeech: ConnectionClosedError: no close frame received or sent", Failure("sber", "tts", "connection_closed")),
        (
            "TtsError: SaluteSpeech: {'type': 'server_error', 'code': 'upstream_error', 'message': 'Speech synthesis failed'}",
            Failure("sber", "tts", "upstream_error"),
        ),
        ("GigaASR: ConnectionClosedError: sent 1011 (internal error) keepalive ping timeout", Failure("sber", "asr", "keepalive_timeout")),
        ("TtsError: SaluteSpeech: ConnectionClosedError: received 1012 (service restart)", Failure("sber", "tts", "service_restart")),
        ("TtsError: SaluteSpeech: TimeoutError: ", Failure("sber", "tts", "timeout")),
        ("TtsError: сессия SaluteSpeech закрыта", Failure("sber", "tts", "session_closed")),
        ("Gemini: You exceeded your current quota", Failure("gemini", "live", "quota")),
        ("gemini 401 Unauthorized", Failure("gemini", "live", "auth")),
        ("something else", Failure("unknown", "unknown", "other")),
    ],
)
def test_failure_is_classified(reason: str, expected: Failure) -> None:
    assert classify_failure(reason) == expected
