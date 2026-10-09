"""Провайдеры озвучки и форматы аудио (specs/speech-pipeline)."""

import asyncio
import io
import json
import struct
import wave

import httpx
import pytest

from app.clients import speech
from app.clients.speech import (
    FRAME_BYTES,
    CachedTts,
    EspeakTts,
    QwenTts,
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

ESPEAK_VOICES = {"male": "ru", "female": "ru+f2"}


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
    out = await EspeakTts(ESPEAK_VOICES, speed=150).synthesize("-Привет", "male")

    assert len(out) // 2 == 2400  # 0,1 с на 24 кГц
    assert process.stdin_seen == "-Привет".encode()  # текст не стал опцией командной строки
    assert seen["args"] == ("espeak-ng", "-v", "ru", "-s", "150", "--stdout")


async def test_espeak_failure_becomes_tts_error(monkeypatch):
    async def failing(*args, **kwargs):
        return FakeProcess(b"", b"boom", code=1)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", failing)
    with pytest.raises(TtsError, match="кодом 1"):
        await EspeakTts(ESPEAK_VOICES, 150).synthesize("привет", "male")


async def test_missing_espeak_binary_becomes_tts_error(monkeypatch):
    async def missing(*args, **kwargs):
        raise FileNotFoundError("espeak-ng")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", missing)
    with pytest.raises(TtsError, match="не запустился"):
        await EspeakTts(ESPEAK_VOICES, 150).synthesize("привет", "male")


# ─── SaluteSpeech ─────────────────────────────────────────────────────────────


SALUTE_VOICES = {"male": "Bys_24000", "female": "Nec_24000"}


def salute(handler, **kwargs) -> SaluteTts:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return SaluteTts(auth_key="KEY", scope="SALUTE_SPEECH_PERS", voices=SALUTE_VOICES, client=client, **kwargs)


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
    out = await salute(make_handler(calls)).synthesize("Привет", "male")

    oauth, synth = calls
    assert oauth.headers["Authorization"] == "Basic KEY"
    assert oauth.headers["RqUID"] and b"scope=SALUTE_SPEECH_PERS" in oauth.content
    assert synth.headers["Authorization"] == "Bearer token-1"
    assert synth.headers["Content-Type"] == "application/text"
    assert synth.url.params["format"] == "pcm16" and synth.url.params["voice"] == "Bys_24000"
    assert synth.content == "Привет".encode()
    assert out == b"\x01\x00" * 100


async def test_salute_caches_the_token_between_calls():
    calls: list[httpx.Request] = []
    tts = salute(make_handler(calls))
    await tts.synthesize("раз", "male")
    await tts.synthesize("два", "male")
    assert sum(1 for c in calls if c.url.host == "ngw.devices.sberbank.ru") == 1


async def test_salute_refreshes_the_token_once_on_401():
    calls: list[httpx.Request] = []
    tts = salute(make_handler(calls, synth_status=[401, 200]))
    assert await tts.synthesize("привет", "male")
    synth_calls = [c for c in calls if c.url.host != "ngw.devices.sberbank.ru"]
    assert [c.headers["Authorization"] for c in synth_calls] == ["Bearer token-1", "Bearer token-2"]


@pytest.mark.parametrize("status", [400, 500])
async def test_salute_error_status_becomes_tts_error(status):
    with pytest.raises(TtsError, match=str(status)):
        await salute(make_handler([], synth_status=[status])).synthesize("привет", "male")


async def test_salute_without_token_becomes_tts_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "bad key"})

    with pytest.raises(TtsError, match="токен"):
        await salute(handler).synthesize("привет", "male")


async def test_salute_network_error_becomes_tts_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети")

    with pytest.raises(TtsError):
        await salute(handler).synthesize("привет", "male")


def test_salute_needs_a_24khz_voice():
    with pytest.raises(ValueError, match="24"):
        SaluteTts(auth_key="KEY", scope="S", voices={"male": "Bys_24000", "female": "Nec_8000"})


# ─── выбор провайдера ─────────────────────────────────────────────────────────


def settings(monkeypatch, **env: str) -> SpeechSettings:
    for key in ("TTS_MODE", "SALUTE_SPEECH_AUTH_KEY", "AGENT_API_TOKEN", "QWEN_TTS_BASE_URL"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return SpeechSettings()


PROXY = {"AGENT_API_TOKEN": "k", "QWEN_TTS_BASE_URL": "https://proxy.example/v1"}


def test_build_tts_none(monkeypatch):
    assert build_tts(settings(monkeypatch, TTS_MODE="none", SALUTE_SPEECH_AUTH_KEY="k", **PROXY)) is None


def test_tts_mode_picks_exactly_the_requested_provider(monkeypatch):
    monkeypatch.setattr(speech.shutil, "which", lambda name: "/usr/bin/espeak-ng")
    # Ключи есть у всех, но решает только режим: никакого «главнее» по наличию ключа.
    keys = {"SALUTE_SPEECH_AUTH_KEY": "k", **PROXY}
    assert build_tts(settings(monkeypatch, TTS_MODE="qwen", **keys)).name == "qwen"
    assert build_tts(settings(monkeypatch, TTS_MODE="salutespeech", **keys)).name == "salutespeech"
    assert build_tts(settings(monkeypatch, TTS_MODE="espeak", **keys)).name == "espeak"


def test_tts_mode_defaults_to_qwen(monkeypatch):
    assert build_tts(settings(monkeypatch, **PROXY)).name == "qwen"


def test_the_qwen_key_is_read_from_agent_api_token(monkeypatch):
    config = settings(monkeypatch, **PROXY)
    assert config.qwen_api_key is not None and config.qwen_api_key.get_secret_value() == "k"
    assert "QWEN_TTS_API_KEY" not in {field.validation_alias for field in SpeechSettings.model_fields.values()}


def test_tts_mode_fails_fast_when_its_credentials_are_missing(monkeypatch):
    monkeypatch.setattr(speech.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="SALUTE_SPEECH_AUTH_KEY"):
        build_tts(settings(monkeypatch, TTS_MODE="salutespeech", **PROXY))
    with pytest.raises(RuntimeError, match="espeak-ng"):
        build_tts(settings(monkeypatch, TTS_MODE="espeak"))
    with pytest.raises(RuntimeError, match="AGENT_API_TOKEN"):
        build_tts(settings(monkeypatch, TTS_MODE="qwen"))  # нет ни ключа, ни адреса
    with pytest.raises(RuntimeError, match="QWEN_TTS_BASE_URL"):
        build_tts(settings(monkeypatch, TTS_MODE="qwen", AGENT_API_TOKEN="k"))  # без адреса прокси Qwen не включается


def test_tts_mode_rejects_unknown_values(monkeypatch):
    with pytest.raises(ValueError):
        settings(monkeypatch, TTS_MODE="auto")


# ─── голоса по роду ───────────────────────────────────────────────────────────


async def test_espeak_uses_the_voice_of_the_requested_gender(monkeypatch):
    seen = []

    async def fake_exec(*args, **kwargs):
        seen.append(args[args.index("-v") + 1])
        return FakeProcess(wav_bytes([100] * 220, 22_050))

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    tts = EspeakTts(ESPEAK_VOICES, 150)
    await tts.synthesize("привет", "male")
    await tts.synthesize("привет", "female")
    assert seen == ["ru", "ru+f2"]


async def test_salute_uses_the_voice_of_the_requested_gender():
    calls: list[httpx.Request] = []
    tts = salute(make_handler(calls))
    await tts.synthesize("раз", "male")
    await tts.synthesize("два", "female")
    voices = [c.url.params["voice"] for c in calls if c.url.host != "ngw.devices.sberbank.ru"]
    assert voices == ["Bys_24000", "Nec_24000"]


# ─── Qwen TTS ─────────────────────────────────────────────────────────────────

QWEN_VOICES = {"male": "loongjohn", "female": "longanhuan_v3.6"}


def qwen(handler) -> QwenTts:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return QwenTts("https://proxy.example/v1/", "proxy-key", "qwen/qwen-audio-3.0-tts-flash", QWEN_VOICES, client=client)


async def test_qwen_asks_the_proxy_for_pcm_with_the_documented_voice():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        # прокси помечает pcm как audio/mpeg, это не должно мешать
        return httpx.Response(200, content=b"\x01\x00" * 50, headers={"content-type": "audio/mpeg"})

    out = await qwen(handler).synthesize("Привет", "male")
    request = seen[0]
    assert str(request.url) == "https://proxy.example/v1/audio/speech"
    assert request.headers["Authorization"] == "Bearer proxy-key"
    assert json.loads(request.content) == {
        "model": "qwen/qwen-audio-3.0-tts-flash",
        "input": "Привет",
        "voice": "loongjohn",
        "response_format": "pcm",
    }
    assert out == b"\x01\x00" * 50


async def test_qwen_female_voice_and_odd_tail_is_dropped():
    bodies = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, content=b"\x01\x00\x02")

    out = await qwen(handler).synthesize("Привет", "female")
    assert bodies[0]["voice"] == "longanhuan_v3.6"
    assert out == b"\x01\x00"  # нечётный хвост отброшен: сэмпл PCM16 занимает два байта


@pytest.mark.parametrize("status", [400, 500])
async def test_qwen_error_status_becomes_tts_error(status):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "Internal server error"}})

    with pytest.raises(TtsError, match=str(status)):
        await qwen(handler).synthesize("Привет", "male")


async def test_qwen_server_error_hints_at_voice_and_format():
    with pytest.raises(TtsError, match="loongjohn"):
        await qwen(lambda request: httpx.Response(500, json={})).synthesize("Привет", "male")


async def test_qwen_empty_audio_and_network_error_become_tts_error():
    with pytest.raises(TtsError, match="пустое"):
        await qwen(lambda request: httpx.Response(200, content=b"")).synthesize("Привет", "male")

    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети")

    with pytest.raises(TtsError, match="не ответил"):
        await qwen(broken).synthesize("Привет", "male")


# ─── память фраз ──────────────────────────────────────────────────────────────


class CountingTts:
    name = "counting"

    def __init__(self, fail: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self.fail = fail

    async def synthesize(self, text: str, voice: str) -> bytes:
        self.calls.append((voice, text))
        if self.fail:
            raise TtsError("сломано")
        return pcm([len(self.calls)])

    async def aclose(self) -> None:
        return None


async def test_cached_tts_synthesizes_a_phrase_once_per_voice():
    inner = CountingTts()
    tts = CachedTts(inner, max_items=8)
    first = await tts.synthesize("Привет", "male")
    assert await tts.synthesize("Привет", "male") == first
    await tts.synthesize("Привет", "female")  # другой голос — другая запись
    assert inner.calls == [("male", "Привет"), ("female", "Привет")]
    assert tts.name == "counting"


async def test_cached_tts_forgets_the_oldest_phrase_first():
    inner = CountingTts()
    tts = CachedTts(inner, max_items=2)
    for text in ("раз", "два", "раз", "три"):  # «раз» освежили, значит забудется «два»
        await tts.synthesize(text, "male")
    await tts.synthesize("раз", "male")
    await tts.synthesize("два", "male")
    assert [text for _, text in inner.calls] == ["раз", "два", "три", "два"]


async def test_cached_tts_does_not_remember_a_failure():
    inner = CountingTts(fail=True)
    tts = CachedTts(inner, max_items=8)
    for _ in range(2):
        with pytest.raises(TtsError):
            await tts.synthesize("Привет", "male")
    inner.fail = False
    await tts.synthesize("Привет", "male")
    assert len(inner.calls) == 3


async def test_warm_up_voices_every_text_in_both_voices_and_survives_a_failure():
    inner = CountingTts()
    tts = CachedTts(inner, max_items=8)
    await tts.warm_up(["Я рядом.", "С чего начнём?"])
    assert sorted(inner.calls) == sorted(
        [(v, t) for v in ("male", "female") for t in ("Я рядом.", "С чего начнём?")]
    )
    await tts.synthesize("Я рядом.", "female")
    assert len(inner.calls) == 4  # из памяти

    broken = CachedTts(CountingTts(fail=True), max_items=8)
    await broken.warm_up(["Я рядом."])  # не бросает: фраза озвучится при первом обращении


def test_build_tts_wraps_the_provider_in_the_phrase_cache_unless_disabled(monkeypatch):
    assert isinstance(build_tts(settings(monkeypatch, **PROXY)), CachedTts)
    assert isinstance(build_tts(settings(monkeypatch, TTS_CACHE_ITEMS="0", **PROXY)), QwenTts)
