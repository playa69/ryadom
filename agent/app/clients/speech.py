"""Звук фиксированных фраз: PCM16 24 кГц моно, как в specs/agent-api «Голос — озвучка ответов».

Голос ответов модели приходит от самого Gemini Live (app/api/dialog_live.py). Здесь формат кадров клиенту и озвучка готовых
фраз (приветствие, кризисный ответ, просьба повторить): источник — `GeminiLiveTts` (app/clients/gemini_live.py), `CachedTts`
запоминает озвученное, чтобы фраза звучала сразу и не открывала сессию Gemini на каждый показ.

Голос выбирается по роду (`male` или `female`) или по имени голоса Gemini из профиля.
"""

import asyncio
import logging
import struct
from collections import OrderedDict
from collections.abc import AsyncIterator, Iterable
from typing import Literal, Protocol

from app.services import usage as model_usage

logger = logging.getLogger("agent.speech")

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


class CachedTts:
    """Помнит озвученные фразы. Фиксированные фразы повторяются, и повтор не должен ждать провайдера снова.

    Нужно прежде всего приветствию: клиент ждёт его `tts_start` не дольше 0,9 с, а озвучка фразы Gemini Live открывает новую
    сессию (около секунды). Фразы прогреваются при старте сервиса (`warm_up`), и на соединении звук уже лежит в памяти.
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
