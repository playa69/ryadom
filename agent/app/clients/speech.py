"""Озвучка ответов: PCM16 24 кГц моно, как в specs/agent-api «Голос — озвучка ответов».

Провайдер выбирается явно, `TTS_MODE`:
  qwen          QwenTts: Qwen TTS через OpenAI-совместимый прокси (POST /audio/speech), нужен ключ прокси
  salutespeech  SaluteTts: SaluteSpeech по REST (целевой провайдер, нужен ключ авторизации Сбера)
  espeak        EspeakTts: локальный espeak-ng (роботизированный голос, ключа не нужно; для разработки)
  none          без озвучки: `build_tts` возвращает None, и приложение читает ответы своим голосом

Голос выбирается по роду (`male` или `female`); каждый провайдер отображает его на свои голоса.
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
from collections import OrderedDict
from collections.abc import AsyncIterator, Iterable
from typing import Literal, Protocol

import httpx

from app.core.config import SpeechSettings
from app.services import usage as model_usage

logger = logging.getLogger("agent.speech")

# Соединения с прокси живут дольше 5 секунд простоя (по умолчанию в httpx): между репликами человека обычно 5-30 с,
# и каждая реплика начиналась бы с нового TCP+TLS (замер: +0,07-0,2 с на каждый из трёх запросов хода). Прокси
# держит простаивающее соединение не меньше минуты (проверено), а закрытое им httpx замечает и открывает заново.
KEEPALIVE_LIMITS = httpx.Limits(keepalive_expiry=60)

Voice = Literal["male", "female"]
VOICES: tuple[Voice, ...] = ("male", "female")

TTS_RATE = 24_000
FRAME_KIND_TTS = 0x02
# 200 мс речи в кадре: 24000 / 5 сэмплов по 2 байта.
FRAME_BYTES = TTS_RATE // 5 * 2


class TtsError(Exception):
    """Провайдер озвучки не ответил или ответил мусором."""


class TextToSpeech(Protocol):
    name: str

    async def synthesize(self, text: str, voice: Voice) -> bytes:
        """Текст → PCM16 little-endian, моно, 24 кГц, голосом заданного рода."""
        ...

    async def aclose(self) -> None: ...


async def pcm_stream(tts: TextToSpeech, text: str, voice: Voice) -> AsyncIterator[bytes]:
    """Звук куском за куском. Провайдер, умеющий отдавать звук потоком (`stream`), отдаёт его, остальные целиком."""
    stream = getattr(tts, "stream", None)
    if stream is None:
        yield await tts.synthesize(text, voice)
        return
    async for piece in stream(text, voice):
        yield piece


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

    def __init__(self, voices: dict[Voice, str], speed: int, binary: str = "espeak-ng") -> None:
        self._voices = voices
        self._speed = speed
        self._binary = binary

    async def synthesize(self, text: str, voice: Voice) -> bytes:
        # Текст идёт через stdin: фраза, начинающаяся с «-», не станет опцией.
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary,
                "-v",
                self._voices[voice],
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

    name = "salutespeech"
    OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
    SYNTH_URL = "https://smartspeech.sber.ru/rest/v1/text:synthesize"

    def __init__(
        self,
        auth_key: str,
        scope: str,
        voices: dict[Voice, str],
        timeout_seconds: int = 15,
        ca_bundle: str | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        for voice in voices.values():
            if not voice.endswith("_24000"):
                raise ValueError(f"Голос {voice!r}: нужен вариант на 24 кГц (суффикс _24000)")
        self._auth_key = auth_key
        self._scope = scope
        self._voices = voices
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds, verify=ca_bundle or True, limits=KEEPALIVE_LIMITS)
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

    @model_usage.counted("tts")
    async def synthesize(self, text: str, voice: Voice) -> bytes:
        for attempt in (1, 2):
            token = await self._access_token(force=attempt == 2)
            try:
                response = await self._client.post(
                    self.SYNTH_URL,
                    params={"format": "pcm16", "voice": self._voices[voice]},
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


class QwenTts:
    """Qwen TTS (`qwen/qwen-audio-3.0-tts-flash`) через OpenAI-совместимый прокси: POST {base_url}/audio/speech.

    Формат запроса у прокси обычный (model, input, voice, response_format), но значения у модели свои: голоса
    `loongjohn` и `longanhuan_v3.6`, форматы `mp3` и `pcm`. С чужими значениями (alloy, Cherry, wav) апстрим
    отвечает 400, а прокси превращает это в невнятный 500. Агенту нужен `pcm`: это сырой PCM16, 24 кГц, моно.
    Прокси при этом помечает pcm как audio/mpeg: на тип ответа не смотрим.
    """

    name = "qwen"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        voices: dict[Voice, str],
        timeout_seconds: int = 30,
        client: httpx.AsyncClient | None = None,
        streaming: bool = True,
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/audio/speech"
        self._api_key = api_key
        self._model = model
        self._voices = voices
        self._streaming = streaming
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds, limits=KEEPALIVE_LIMITS)

    def _request(self, text: str, voice: Voice) -> dict:
        return {
            "headers": {"Authorization": f"Bearer {self._api_key}"},
            "json": {"model": self._model, "input": text, "voice": self._voices[voice], "response_format": "pcm"},
        }

    def _record(self, text: str, pcm_bytes: int) -> None:
        """Расход синтеза: токенов у модели нет, оплачиваются символы текста; выход — секунды полученного звука."""
        model_usage.record(self._model, "tts", "input", "text", "chars", len(text))
        model_usage.record(self._model, "tts", "output", "audio", "seconds", round(pcm_bytes / (2 * TTS_RATE), 3))

    async def stream(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        """Звук по мере прихода: прокси отдаёт его кусками, и первые 200 мс можно играть, не дожидаясь конца фразы.

        С `streaming=False` (`QWEN_TTS_STREAM=false`) отдаёт всё одним куском, как `synthesize`.
        """
        if not self._streaming:
            yield await self.synthesize(text, voice)
            return
        carry, total, accepted = b"", 0, False
        try:
            async with self._client.stream("POST", self._url, **self._request(text, voice)) as response:
                if response.status_code != 200:
                    body = (await response.aread()).decode(errors="replace")
                    hint = " (проверьте голос и формат: у модели только loongjohn/longanhuan_v3.6 и mp3/pcm)" if response.status_code >= 500 else ""
                    raise TtsError(f"Qwen TTS ответил {response.status_code}{hint}: {body[:200]}")
                accepted = True
                async for chunk in response.aiter_bytes():
                    data = carry + chunk
                    whole = len(data) // 2 * 2  # сэмпл — два байта: нечётный хвост ждёт следующий кусок
                    carry = data[whole:]
                    if whole:
                        total += whole
                        yield data[:whole]
        except httpx.HTTPError as error:
            raise TtsError(f"Qwen TTS не ответил: {error}") from error
        finally:
            if accepted:  # запрос принят: текст оплачен, даже если озвучку оборвали на середине
                self._record(text, total)
                model_usage.call("tts")
            else:
                model_usage.call("tts", "error")
        if not total:
            raise TtsError("Qwen TTS вернул пустое аудио")

    @model_usage.counted("tts")
    async def synthesize(self, text: str, voice: Voice) -> bytes:
        try:
            response = await self._client.post(self._url, **self._request(text, voice))
        except httpx.HTTPError as error:
            raise TtsError(f"Qwen TTS не ответил: {error}") from error
        if response.status_code != 200:
            hint = " (проверьте голос и формат: у модели только loongjohn/longanhuan_v3.6 и mp3/pcm)" if response.status_code >= 500 else ""
            raise TtsError(f"Qwen TTS ответил {response.status_code}{hint}: {response.text[:200]}")
        pcm = response.content[: len(response.content) // 2 * 2]
        self._record(text, len(pcm))
        if not pcm:
            raise TtsError("Qwen TTS вернул пустое аудио")
        return pcm

    async def aclose(self) -> None:
        await self._client.aclose()


class CachedTts:
    """Помнит озвученные фразы. Ответы агента шаблонные, и повтор не должен ждать провайдера снова.

    Нужно прежде всего приветствию: клиент ждёт его `tts_start` не дольше 0,9 с, а облачный синтез
    (Qwen через прокси) отдаёт первый звук за 1-2 с. Приветствия прогреваются при старте сервиса
    (`warm_up`), и на соединении звук уже лежит в памяти.
    """

    def __init__(self, inner: TextToSpeech, max_items: int) -> None:
        self._inner = inner
        self._max_items = max_items
        self._items: OrderedDict[tuple[Voice, str], bytes] = OrderedDict()
        self.name = inner.name

    async def synthesize(self, text: str, voice: Voice) -> bytes:
        key = (voice, text)
        cached = self._items.get(key)
        if cached is not None:
            self._items.move_to_end(key)
            model_usage.call("tts", cached=True)  # провайдера не звали, но фраза человеку озвучена
            return cached
        pcm = await self._inner.synthesize(text, voice)  # отказ не запоминается
        self._remember(key, pcm)
        return pcm

    def remembered(self, text: str, voice: Voice) -> bytes | None:
        """Озвученная раньше фраза, без обращения к провайдеру (None, если её нет в памяти)."""
        return self._items.get((voice, text))

    def _remember(self, key: tuple[Voice, str], pcm: bytes) -> None:
        self._items[key] = pcm
        while len(self._items) > self._max_items:
            self._items.popitem(last=False)

    async def stream(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        """Запомненное отдаётся сразу целиком; новое идёт потоком и запоминается, только если дошло до конца."""
        key = (voice, text)
        cached = self._items.get(key)
        if cached is not None:
            self._items.move_to_end(key)
            model_usage.call("tts", cached=True)
            yield cached
            return
        parts: list[bytes] = []
        async for piece in pcm_stream(self._inner, text, voice):
            parts.append(piece)
            yield piece
        self._remember(key, b"".join(parts))

    async def warm_up(self, texts: Iterable[str], parallel: int = 1) -> None:
        """Озвучить заранее; отказ провайдера не страшен: фраза озвучится при первом обращении, а прогрев идёт дальше.

        `parallel` — сколько фраз озвучивается одновременно. У Gemini Live каждая фраза — своя сессия, и закрывается она не
        сразу, а после дочитывания расхода (`drained`): место освобождается только тогда, иначе открытые сессии копились бы.
        """
        slots = asyncio.Semaphore(parallel)
        drained = getattr(self._inner, "drained", None)
        counts = {"done": 0, "failed": 0}

        async def one(text: str, voice: Voice) -> None:
            async with slots:
                try:
                    await self.synthesize(text, voice)
                    counts["done"] += 1
                except Exception as error:  # noqa: BLE001 - сбой одной фразы не останавливает прогрев остальных
                    counts["failed"] += 1
                    logger.warning("прогрев озвучки не удался voice=%s: %s", voice, error)
                if drained is not None:
                    await drained()

        await asyncio.gather(*(one(text, voice) for text in texts for voice in VOICES))
        logger.info("прогрев озвучки закончен: озвучено %d, не удалось %d", counts["done"], counts["failed"])

    async def aclose(self) -> None:
        await self._inner.aclose()


def build_tts(settings: SpeechSettings) -> TextToSpeech | None:
    """Выбрать провайдера озвучки по настройкам и обернуть его памятью фраз (`TTS_CACHE_ITEMS`)."""
    tts = _build_provider(settings)
    if tts is None or settings.tts_cache_items == 0:
        return tts
    return CachedTts(tts, settings.tts_cache_items)


def _build_provider(settings: SpeechSettings) -> TextToSpeech | None:
    mode = settings.mode
    if mode == "none":
        return None

    if mode == "salutespeech":
        if settings.salute_auth_key is None:
            raise RuntimeError("TTS_MODE=salutespeech, но SALUTE_SPEECH_AUTH_KEY не задан")
        return SaluteTts(
            auth_key=settings.salute_auth_key.get_secret_value(),
            scope=settings.salute_scope,
            voices={"male": settings.salute_voice_male, "female": settings.salute_voice_female},
            timeout_seconds=settings.salute_timeout_seconds,
            ca_bundle=settings.salute_ca_bundle,
        )

    if mode == "qwen":
        if settings.qwen_api_key is None or not settings.qwen_base_url:
            raise RuntimeError("TTS_MODE=qwen, но не заданы AGENT_API_TOKEN (ключ прокси) и QWEN_TTS_BASE_URL")
        return QwenTts(
            base_url=settings.qwen_base_url,
            api_key=settings.qwen_api_key.get_secret_value(),
            model=settings.qwen_model,
            voices={"male": settings.qwen_voice_male, "female": settings.qwen_voice_female},
            timeout_seconds=settings.qwen_timeout_seconds,
            streaming=settings.qwen_stream,
        )

    if shutil.which(settings.espeak_binary) is None:  # mode == "espeak"
        raise RuntimeError("TTS_MODE=espeak, но espeak-ng не найден в PATH")
    return EspeakTts(
        voices={"male": settings.espeak_voice_male, "female": settings.espeak_voice_female},
        speed=settings.espeak_speed,
        binary=settings.espeak_binary,
    )
