"""Провайдеры озвучки и форматы аудио (specs/speech-pipeline)."""

import asyncio
import io
import struct
import wave

import httpx
import pytest

from app.clients import speech
from app.clients.speech import (
    FRAME_BYTES,
    EspeakTts,
    SaluteTts,
    TtsError,
    build_tts,
    pcm_chunks,
    pcm_from_wav,
    pcm_to_wav,
    resample,
    tts_frame,
)
from app.core.config import SpeechSettings


def wav_bytes(samples: list[int], rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return buffer.getvalue()


def pcm(samples: list[int]) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


# ─── формат ───────────────────────────────────────────────────────────────────


def test_frame_size_is_200ms_of_24khz_pcm16():
    assert FRAME_BYTES == 9600
    assert len(tts_frame(0, bytes(FRAME_BYTES))) == 9605  # как в контракте: 9605 байт с заголовком


def test_tts_frame_header_is_kind_and_big_endian_sequence():
    frame = tts_frame(258, b"\x01\x02")
    assert frame[:5] == bytes([0x02, 0, 0, 1, 2]) and frame[5:] == b"\x01\x02"


def test_pcm_chunks_split_by_200ms_and_keep_the_tail():
    chunks = pcm_chunks(bytes(FRAME_BYTES * 2 + 100))
    assert [len(c) for c in chunks] == [FRAME_BYTES, FRAME_BYTES, 100]
    assert pcm_chunks(b"") == []


def test_resample_changes_length_and_keeps_the_shape():
    original = pcm(list(range(0, 1000, 10)))  # 100 сэмплов, плавный рост
    doubled = resample(original, 12_000, 24_000)
    assert len(doubled) == len(original) * 2
    samples = struct.unpack(f"<{len(doubled) // 2}h", doubled)
    assert samples[0] == 0 and samples[2] == 10 and samples[1] == 5  # середина между соседями
    assert resample(original, 24_000, 24_000) == original
    assert resample(b"", 12_000, 24_000) == b""


def test_pcm_from_wav_reads_a_regular_wav():
    rate, data = pcm_from_wav(wav_bytes([1, 2, 3, 4], 22_050))
    assert rate == 22_050 and data == pcm([1, 2, 3, 4])


@pytest.mark.parametrize("announced", [0, 0xFFFFFFFF])
def test_pcm_from_wav_reads_to_the_end_when_length_is_unknown(announced):
    """espeak-ng в stdout пишет WAV, у которого длина данных не известна."""
    wav = bytearray(wav_bytes([5, 6, 7], 22_050))
    wav[40:44] = struct.pack("<I", announced)
    rate, data = pcm_from_wav(bytes(wav))
    assert rate == 22_050 and data == pcm([5, 6, 7])


def test_pcm_from_wav_rejects_garbage():
    with pytest.raises(TtsError):
        pcm_from_wav(b"not a wav at all" * 5)


def test_pcm_to_wav_roundtrip():
    rate, data = pcm_from_wav(pcm_to_wav(pcm([9, 8, 7])))
    assert rate == 24_000 and data == pcm([9, 8, 7])


# ─── espeak-ng ────────────────────────────────────────────────────────────────


class FakeProcess:
    def __init__(self, out: bytes, err: bytes = b"", code: int = 0) -> None:
        self._out, self._err, self.returncode = out, err, code
        self.stdin_seen: bytes | None = None

    async def communicate(self, data: bytes | None = None):
        self.stdin_seen = data
        return self._out, self._err


async def test_espeak_converts_to_24khz_and_passes_text_via_stdin(monkeypatch):
    process = FakeProcess(wav_bytes([100] * 2205, 22_050))  # 0,1 с на 22,05 кГц
    seen = {}

    async def fake_exec(*args, **kwargs):
        seen["args"] = args
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    out = await EspeakTts(voice="ru", speed=150).synthesize("-Привет")

    assert len(out) // 2 == 2400  # 0,1 с на 24 кГц
    assert process.stdin_seen == "-Привет".encode()  # текст не стал опцией командной строки
    assert seen["args"] == ("espeak-ng", "-v", "ru", "-s", "150", "--stdout")


async def test_espeak_failure_becomes_tts_error(monkeypatch):
    async def failing(*args, **kwargs):
        return FakeProcess(b"", b"boom", code=1)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", failing)
    with pytest.raises(TtsError, match="кодом 1"):
        await EspeakTts("ru", 150).synthesize("привет")


async def test_missing_espeak_binary_becomes_tts_error(monkeypatch):
    async def missing(*args, **kwargs):
        raise FileNotFoundError("espeak-ng")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", missing)
    with pytest.raises(TtsError, match="не запустился"):
        await EspeakTts("ru", 150).synthesize("привет")


# ─── SaluteSpeech ─────────────────────────────────────────────────────────────


def salute(handler, **kwargs) -> SaluteTts:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return SaluteTts(auth_key="KEY", scope="SALUTE_SPEECH_PERS", voice="May_24000", client=client, **kwargs)


def make_handler(calls: list[httpx.Request], audio: bytes = b"\x01\x00" * 100, synth_status: list[int] | None = None):
    statuses = list(synth_status or [])

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.host == "ngw.devices.sberbank.ru":
            token = f"token-{sum(1 for c in calls if c.url.host == 'ngw.devices.sberbank.ru')}"
            return httpx.Response(200, json={"access_token": token, "expires_at": 4_102_444_800_000})
        status = statuses.pop(0) if statuses else 200
        return httpx.Response(status, content=audio if status == 200 else b"nope")

    return handler


async def test_salute_gets_a_token_then_synthesizes_pcm():
    calls: list[httpx.Request] = []
    out = await salute(make_handler(calls)).synthesize("Привет")

    oauth, synth = calls
    assert oauth.headers["Authorization"] == "Basic KEY"
    assert oauth.headers["RqUID"] and b"scope=SALUTE_SPEECH_PERS" in oauth.content
    assert synth.headers["Authorization"] == "Bearer token-1"
    assert synth.headers["Content-Type"] == "application/text"
    assert synth.url.params["format"] == "pcm16" and synth.url.params["voice"] == "May_24000"
    assert synth.content == "Привет".encode()
    assert out == b"\x01\x00" * 100


async def test_salute_caches_the_token_between_calls():
    calls: list[httpx.Request] = []
    tts = salute(make_handler(calls))
    await tts.synthesize("раз")
    await tts.synthesize("два")
    assert sum(1 for c in calls if c.url.host == "ngw.devices.sberbank.ru") == 1


async def test_salute_refreshes_the_token_once_on_401():
    calls: list[httpx.Request] = []
    tts = salute(make_handler(calls, synth_status=[401, 200]))
    assert await tts.synthesize("привет")
    synth_calls = [c for c in calls if c.url.host != "ngw.devices.sberbank.ru"]
    assert [c.headers["Authorization"] for c in synth_calls] == ["Bearer token-1", "Bearer token-2"]


@pytest.mark.parametrize("status", [400, 500])
async def test_salute_error_status_becomes_tts_error(status):
    with pytest.raises(TtsError, match=str(status)):
        await salute(make_handler([], synth_status=[status])).synthesize("привет")


async def test_salute_without_token_becomes_tts_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "bad key"})

    with pytest.raises(TtsError, match="токен"):
        await salute(handler).synthesize("привет")


async def test_salute_network_error_becomes_tts_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети")

    with pytest.raises(TtsError):
        await salute(handler).synthesize("привет")


def test_salute_needs_a_24khz_voice():
    with pytest.raises(ValueError, match="24"):
        SaluteTts(auth_key="KEY", scope="S", voice="Nec_8000")


# ─── выбор провайдера ─────────────────────────────────────────────────────────


def settings(monkeypatch, **env: str) -> SpeechSettings:
    for key in ("TTS_PROVIDER", "SALUTE_SPEECH_AUTH_KEY"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return SpeechSettings()


def test_build_tts_none(monkeypatch):
    assert build_tts(settings(monkeypatch, TTS_PROVIDER="none", SALUTE_SPEECH_AUTH_KEY="k")) is None


def test_build_tts_auto_prefers_salute_then_espeak_then_nothing(monkeypatch):
    monkeypatch.setattr(speech.shutil, "which", lambda name: "/usr/bin/espeak-ng")
    assert build_tts(settings(monkeypatch, SALUTE_SPEECH_AUTH_KEY="k")).name == "salute"
    assert build_tts(settings(monkeypatch)).name == "espeak"
    monkeypatch.setattr(speech.shutil, "which", lambda name: None)
    assert build_tts(settings(monkeypatch)) is None


def test_build_tts_explicit_provider_fails_fast_when_unavailable(monkeypatch):
    monkeypatch.setattr(speech.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="SALUTE_SPEECH_AUTH_KEY"):
        build_tts(settings(monkeypatch, TTS_PROVIDER="salute"))
    with pytest.raises(RuntimeError, match="espeak-ng"):
        build_tts(settings(monkeypatch, TTS_PROVIDER="espeak"))
