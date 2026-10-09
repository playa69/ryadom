"""Юнит-тесты WAV-обёртки и буферизации аудиокадров WS-эндпоинта."""

import io
import math
import struct
import wave

from app.api.internal.ws import (
    AUDIO_FRAME_HEADER_BYTES,
    AUDIO_FRAME_KIND_USER,
    _ConnectionState,
    _buffer_audio,
    _pcm_to_wav,
)


def _sine_pcm16(rate: int, seconds: float) -> bytes:
    """Генерирует PCM16-моно синус 440 Гц."""
    samples = int(rate * seconds)
    return b"".join(
        struct.pack("<h", round(math.sin(2 * math.pi * 440 * i / rate) * 8000))
        for i in range(samples)
    )


def test_pcm_to_wav_wraps_valid_container() -> None:
    """PCM16 16 кГц оборачивается в читаемый WAV с теми же параметрами."""
    pcm = _sine_pcm16(16_000, 0.5)
    wav_bytes = _pcm_to_wav(pcm, 16_000)
    with wave.open(io.BytesIO(wav_bytes), "rb") as parsed:
        assert parsed.getnchannels() == 1
        assert parsed.getsampwidth() == 2
        assert parsed.getframerate() == 16_000
        assert parsed.getnframes() == 8_000
        assert parsed.readframes(8_000) == pcm


def test_pcm_to_wav_empty_input() -> None:
    """Пустой PCM даёт валидный WAV без фреймов."""
    with wave.open(io.BytesIO(_pcm_to_wav(b"", 16_000)), "rb") as parsed:
        assert parsed.getnframes() == 0


def test_buffer_audio_strips_user_frame_header() -> None:
    """Кадр вида 0x01 складывается в буфер без 5-байтового заголовка."""
    state = _ConnectionState({})
    frame = bytes([AUDIO_FRAME_KIND_USER]) + b"\x00\x00\x00\x07" + b"pcm-data"
    _buffer_audio(state, frame)
    assert bytes(state.audio) == b"pcm-data"


def test_buffer_audio_passes_through_frame_without_header() -> None:
    """Короткий кадр или кадр чужого вида попадает в буфер целиком."""
    state = _ConnectionState({})
    _buffer_audio(state, b"abc")
    _buffer_audio(state, bytes([0x02]) + b"\x00\x00\x00\x01" + b"tts")
    assert bytes(state.audio) == b"abc" + bytes([0x02]) + b"\x00\x00\x00\x01" + b"tts"


def test_buffer_audio_accumulates_frames() -> None:
    """Последовательные кадры склеиваются в один поток сэмплов."""
    state = _ConnectionState({})
    for seq in range(3):
        _buffer_audio(
            state,
            bytes([AUDIO_FRAME_KIND_USER]) + seq.to_bytes(4, "big") + bytes([seq, seq]),
        )
    assert bytes(state.audio) == bytes([0, 0, 1, 1, 2, 2])
    assert AUDIO_FRAME_HEADER_BYTES == 5
