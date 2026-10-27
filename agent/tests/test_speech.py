"""Формат кадров озвучки и память фраз (specs/speech-pipeline)."""

import struct

import pytest

from app.clients.speech import FRAME_BYTES, CachedTts, TtsError, pcm_stream, tts_frame


def pcm(samples: list[int]) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


# ─── формат ───────────────────────────────────────────────────────────────────


def test_frame_size_is_200ms_of_24khz_pcm16():
    assert FRAME_BYTES == 9600
    assert len(tts_frame(0, bytes(FRAME_BYTES))) == 9605  # как в контракте: 9605 байт с заголовком


def test_tts_frame_header_is_kind_and_big_endian_sequence():
    frame = tts_frame(258, b"\x01\x02")
    assert frame[:5] == bytes([0x02, 0, 0, 1, 2]) and frame[5:] == b"\x01\x02"


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


class WholeOnlyTts:
    """Провайдер без потока: отдаёт звук только целиком."""

    name = "whole"

    async def synthesize(self, text: str, voice: str) -> bytes:
        return b"\x01\x00" * 4

    async def aclose(self) -> None:
        return None


async def test_a_provider_without_a_stream_is_read_whole():
    assert [piece async for piece in pcm_stream(WholeOnlyTts(), "Привет.", "male")] == [b"\x01\x00" * 4]


async def test_cache_replays_a_finished_stream_but_forgets_an_unfinished_one():
    calls = []

    class Source(WholeOnlyTts):
        async def stream(self, text, voice):
            calls.append(text)
            yield b"\x01\x00" * 2
            if text == "обрыв":
                raise TtsError("связь оборвалась")
            yield b"\x02\x00" * 2

    cached = CachedTts(Source(), 8)
    first = b"".join([p async for p in cached.stream("целая", "male")])
    again = b"".join([p async for p in cached.stream("целая", "male")])
    assert first == again == b"\x01\x00" * 2 + b"\x02\x00" * 2 and calls == ["целая"]  # второй раз из памяти

    for _ in range(2):
        with pytest.raises(TtsError):
            [_ async for _ in cached.stream("обрыв", "male")]
    assert calls.count("обрыв") == 2  # обрезок не запомнился
