"""Озвучка ответов: PCM16 24 кГц моно, как в specs/agent-api «Голос — озвучка ответов».

Провайдеры:
  SaluteTts  SaluteSpeech по REST (целевой провайдер, нужен ключ)
  EspeakTts  локальный espeak-ng (роботизированный голос, ключа не нужно; ставится в контейнер)
Если озвучки нет вовсе, `build_tts` возвращает None, и приложение читает ответы своим голосом.
"""

import asyncio
import io
import logging
import shutil
import struct
import sys
import time
import uuid
import wave
from array import array
from typing import Protocol

import httpx

from app.core.config import SpeechSettings

logger = logging.getLogger("agent.speech")

TTS_RATE = 24_000
FRAME_KIND_TTS = 0x02
# 200 мс речи в кадре: 24000 / 5 сэмплов по 2 байта.
FRAME_BYTES = TTS_RATE // 5 * 2


class TtsError(Exception):
    """Провайдер озвучки не ответил или ответил мусором."""


class TextToSpeech(Protocol):
    name: str

    async def synthesize(self, text: str) -> bytes:
        """Текст → PCM16 little-endian, моно, 24 кГц."""
        ...

    async def aclose(self) -> None: ...


# ─── Формат кадров и аудио ────────────────────────────────────────────────────


def tts_frame(sequence: int, pcm: bytes) -> bytes:
    """Двоичный кадр озвучки: [0x02][номер uint32 BE][PCM16]."""
    return struct.pack(">BI", FRAME_KIND_TTS, sequence) + pcm


def pcm_chunks(pcm: bytes) -> list[bytes]:
    """Нарезка на кадры по 200 мс; последний может быть короче."""
    return [pcm[at : at + FRAME_BYTES] for at in range(0, len(pcm), FRAME_BYTES)]


def _samples(pcm: bytes) -> array:
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) // 2 * 2])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def _bytes(samples: array) -> bytes:
    if sys.byteorder == "big":
        samples = array("h", samples)
        samples.byteswap()
    return samples.tobytes()


def resample(pcm: bytes, source_rate: int, target_rate: int) -> bytes:
    """Линейная передискретизация: для запасного голоса достаточно."""
    if source_rate == target_rate or not pcm:
        return pcm
    source = _samples(pcm)
    count = len(source) * target_rate // source_rate
    out = array("h", bytes(count * 2)) if count else array("h")
    last = len(source) - 1
    for i in range(count):
        position = i * source_rate / target_rate
        index = int(position)
        nxt = source[min(index + 1, last)]
        out[i] = round(source[index] + (nxt - source[index]) * (position - index))
    return _bytes(out)


def pcm_from_wav(wav_bytes: bytes) -> tuple[int, bytes]:
    """(частота, PCM16) из WAV. espeak-ng в stdout пишет WAV с неизвестной длиной данных: читаем до конца."""
    if len(wav_bytes) < 44 or wav_bytes[:4] != b"RIFF" or wav_bytes[8:12] != b"WAVE":
        raise TtsError("синтезатор вернул не WAV")
    rate = struct.unpack_from("<I", wav_bytes, 24)[0]
    offset = 12
    while offset + 8 <= len(wav_bytes):
        chunk_id = wav_bytes[offset : offset + 4]
        size = struct.unpack_from("<I", wav_bytes, offset + 4)[0]
        if chunk_id == b"data":
            start = offset + 8
            end = len(wav_bytes) if size in (0, 0xFFFFFFFF) or start + size > len(wav_bytes) else start + size
            return rate, wav_bytes[start:end]
        offset += 8 + size
    raise TtsError("в WAV нет данных")


def pcm_to_wav(pcm: bytes, rate: int = TTS_RATE) -> bytes:
    """Обёртка PCM16 в WAV, чтобы результат можно было послушать."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm)
    return buffer.getvalue()


# ─── Провайдеры ───────────────────────────────────────────────────────────────


class EspeakTts:
    name = "espeak"

    def __init__(self, voice: str, speed: int, binary: str = "espeak-ng") -> None:
        self._voice = voice
        self._speed = speed
        self._binary = binary

    async def synthesize(self, text: str) -> bytes:
        # Текст идёт через stdin: фраза, начинающаяся с «-», не станет опцией.
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary,
                "-v",
                self._voice,
                "-s",
                str(self._speed),
                "--stdout",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            out, err = await process.communicate(text.encode())
        except OSError as error:
            raise TtsError(f"espeak-ng не запустился: {error}") from error
        if process.returncode != 0:
            raise TtsError(f"espeak-ng завершился с кодом {process.returncode}: {err.decode(errors='replace')[:200]}")
        rate, pcm = pcm_from_wav(out)
        return resample(pcm, rate, TTS_RATE)

    async def aclose(self) -> None:
        return None


class SaluteTts:
    """SaluteSpeech REST: OAuth по ключу авторизации, затем синтез в сырой PCM16.

    Не проверено на живом провайдере: ключа SaluteSpeech в проекте пока нет. Логика покрыта тестами
    на подменённом транспорте, формат ответа — по документации (`format=pcm16`, голос `*_24000`).
    """

    name = "salute"
    OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
    SYNTH_URL = "https://smartspeech.sber.ru/rest/v1/text:synthesize"

    def __init__(
        self,
        auth_key: str,
        scope: str,
        voice: str,
        timeout_seconds: int = 15,
        ca_bundle: str | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not voice.endswith("_24000"):
            raise ValueError(f"Голос {voice!r}: нужен вариант на 24 кГц (суффикс _24000)")
        self._auth_key = auth_key
        self._scope = scope
        self._voice = voice
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds, verify=ca_bundle or True)
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    async def _access_token(self, force: bool = False) -> str:
        async with self._lock:
            if not force and self._token and time.time() < self._expires_at - 60:
                return self._token
            try:
                response = await self._client.post(
                    self.OAUTH_URL,
                    headers={
                        "Authorization": f"Basic {self._auth_key}",
                        "RqUID": str(uuid.uuid4()),
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Accept": "application/json",
                    },
                    data={"scope": self._scope},
                )
                response.raise_for_status()
                body = response.json()
                self._token = body["access_token"]
            except (httpx.HTTPError, KeyError, ValueError) as error:
                raise TtsError(f"SaluteSpeech не выдал токен: {error}") from error
            # `expires_at` приходит в миллисекундах; без него считаем токен живым полчаса.
            expires_ms = body.get("expires_at")
            self._expires_at = expires_ms / 1000 if isinstance(expires_ms, int | float) else time.time() + 1800
            return self._token

    async def synthesize(self, text: str) -> bytes:
        for attempt in (1, 2):
            token = await self._access_token(force=attempt == 2)
            try:
                response = await self._client.post(
                    self.SYNTH_URL,
                    params={"format": "pcm16", "voice": self._voice},
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/text"},
                    content=text.encode(),
                )
            except httpx.HTTPError as error:
                raise TtsError(f"SaluteSpeech не ответил: {error}") from error
            if response.status_code == 401 and attempt == 1:
                continue  # токен мог протухнуть раньше срока: берём новый и повторяем один раз
            if response.status_code != 200:
                raise TtsError(f"SaluteSpeech ответил {response.status_code}: {response.text[:200]}")
            if not response.content:
                raise TtsError("SaluteSpeech вернул пустое аудио")
            return response.content
        raise TtsError("SaluteSpeech отклонил токен")  # недостижимо, но явно

    async def aclose(self) -> None:
        await self._client.aclose()


def build_tts(settings: SpeechSettings) -> TextToSpeech | None:
    """Выбрать провайдера озвучки по настройкам (см. SpeechSettings.tts_provider)."""
    provider = settings.tts_provider
    has_key = settings.salute_auth_key is not None
    has_espeak = shutil.which(settings.espeak_binary) is not None

    if provider == "none":
        return None
    if provider == "salute" and not has_key:
        raise RuntimeError("TTS_PROVIDER=salute, но SALUTE_SPEECH_AUTH_KEY не задан")
    if provider == "espeak" and not has_espeak:
        raise RuntimeError("TTS_PROVIDER=espeak, но espeak-ng не найден в PATH")

    if provider == "salute" or (provider == "auto" and has_key):
        assert settings.salute_auth_key is not None
        return SaluteTts(
            auth_key=settings.salute_auth_key.get_secret_value(),
            scope=settings.salute_scope,
            voice=settings.salute_voice,
            timeout_seconds=settings.salute_timeout_seconds,
            ca_bundle=settings.salute_ca_bundle,
        )
    if provider == "espeak" or (provider == "auto" and has_espeak):
        return EspeakTts(voice=settings.espeak_voice, speed=settings.espeak_speed, binary=settings.espeak_binary)

    logger.warning("озвучки нет: ни ключа SaluteSpeech, ни espeak-ng; приложение будет читать ответы само")
    return None
