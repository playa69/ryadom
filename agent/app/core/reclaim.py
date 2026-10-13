"""Возврат памяти процесса системе (`MEMORY_RECLAIM_SECONDS`).

Что держало память после нагрузки (замер на стенде с фейковым Gemini Live, 150 человек; RSS 79 → 510 МиБ и не опускался):
  освобождённое glibc  куча и арены потоков не отдаются системе сами, пока свободное не на вершине кучи: это снимает
                       `malloc_trim(0)`
  ссылочные циклы      остатки закрытых соединений с Gemini (TLS-буферы, заголовки, очереди) и сеансов диалога ждали редкой
                       полной сборки мусора. Циклы нашего кода разорваны в источнике (`forget_cancellation`), цикл websockets
                       обходится тем же колбэком (app/clients/gemini_live.py); остальное собирает периодическая сборка
Полная сборка мусора останавливает цикл событий, а с ним и звук, на время обхода всех отслеживаемых объектов. Поэтому
объекты, созданные до начала работы (модули, классы, схемы SDK), после старта замораживаются (`gc.freeze`): сборщик их больше
не обходит, и полная сборка становится короче. `malloc_trim` идёт в отдельном потоке: вызов через ctypes отпускает GIL.
"""

import asyncio
import ctypes
import functools
import gc
import logging
import os
import sys
import time
from collections.abc import Callable

from app.core.metrics import (
    PROCESS_MEMORY_RECLAIM_COLLECTED_OBJECTS_TOTAL,
    PROCESS_MEMORY_RECLAIM_RUNS_TOTAL,
    PROCESS_MEMORY_RECLAIM_SECONDS,
    PROCESS_MEMORY_RECLAIMED_BYTES_TOTAL,
)

logger = logging.getLogger("agent.reclaim")

Trim = Callable[[int], int]

_PAGE_BYTES = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096


def forget_cancellation(task: "asyncio.Task[object]") -> None:
    """Колбэк `add_done_callback`: отменённая задача отдаёт своё CancelledError, чтобы не держать себя циклом.

    Отменённая задача хранит исключение, которым кончилась её корутина, а в его traceback — кадры с локальными переменными,
    обычно и с `self`. Если `self` ссылается на задачу (поле, список задач), выходит цикл self → задача → исключение →
    traceback → кадр → self: его освобождает только полная сборка мусора, а до неё живёт всё, что достижимо из self (очереди
    звука, сокеты, буферы TLS). Забранное исключение задача больше не хранит, и всё это освобождается сразу. Тот, кто потом
    дождётся задачи, всё равно получит CancelledError (новое, без traceback).
    """
    if task.cancelled():
        try:
            task.result()
        except asyncio.CancelledError:
            pass


@functools.cache
def malloc_trim() -> Trim | None:
    """`malloc_trim` из glibc или None (не Linux, другая libc, нет функции). Недоступность пишется в журнал один раз."""
    if not sys.platform.startswith("linux"):
        logger.info("malloc_trim is not available on %s: memory is reclaimed by the garbage collector only", sys.platform)
        return None
    try:
        trim = ctypes.CDLL("libc.so.6").malloc_trim  # CDLL отпускает GIL на время вызова
    except (OSError, AttributeError) as error:
        logger.info("malloc_trim is not available (%s): memory is reclaimed by the garbage collector only", error)
        return None
    trim.argtypes = [ctypes.c_size_t]
    trim.restype = ctypes.c_int
    return trim


def rss_bytes() -> int | None:
    """Резидентная память процесса (RSS) из /proc/self/statm; None — не Linux или не прочитать."""
    try:
        with open("/proc/self/statm", "rb") as statm:
            return int(statm.read().split()[1]) * _PAGE_BYTES
    except (OSError, ValueError, IndexError):
        return None


class MemoryReclaimer:
    """После старта замораживает стартовые объекты для сборщика, затем раз в `interval` секунд возвращает память системе.

    `interval` 0 — только заморозка. `trim` подменяют тесты; по умолчанию — `malloc_trim` glibc, если он есть.
    """

    def __init__(self, interval: float, trim: Trim | None | bool = True) -> None:
        self._interval = interval
        self._trim: Trim | None = malloc_trim() if trim is True else (trim or None)
        self._task: asyncio.Task[None] | None = None
        self._frozen = False

    def start(self, warm_up: "asyncio.Task[object] | None" = None) -> None:
        """Запустить в фоне. `warm_up` — прогрев на старте: замораживать его недоделанные объекты незачем, ждём его."""
        self._task = asyncio.create_task(self._run(warm_up))

    async def stop(self) -> None:
        """Остановить, не дожидаясь идущего malloc_trim (его поток закончит сам), и вернуть замороженное сборщику."""
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        if self._frozen:
            gc.unfreeze()
            self._frozen = False

    async def _run(self, warm_up: "asyncio.Task[object] | None") -> None:
        if warm_up is not None:
            await asyncio.wait({warm_up})
        self._freeze()
        if not self._interval:
            return
        while True:
            await asyncio.sleep(self._interval)
            try:
                await self.reclaim()
            except Exception:  # noqa: BLE001
                logger.exception("memory reclaim failed")

    def _freeze(self) -> None:
        """Всё, что создано до начала работы, живёт до конца процесса: сборщику незачем обходить это при каждой полной сборке."""
        gc.collect()  # мусор старта не замораживаем
        gc.freeze()
        self._frozen = True
        logger.info("gc: %d startup objects frozen", gc.get_freeze_count())

    async def reclaim(self) -> None:
        """Один проход: сборка мусора (пауза цикла событий) и malloc_trim в потоке. Метрики — app/core/metrics.py."""
        before = rss_bytes()
        started = time.perf_counter()
        found = gc.collect()
        gc_seconds = time.perf_counter() - started
        PROCESS_MEMORY_RECLAIM_SECONDS.labels("gc").observe(gc_seconds)
        PROCESS_MEMORY_RECLAIM_COLLECTED_OBJECTS_TOTAL.inc(found)
        trim_seconds = 0.0
        if self._trim is not None:
            started = time.perf_counter()
            await asyncio.to_thread(self._trim, 0)
            trim_seconds = time.perf_counter() - started
            PROCESS_MEMORY_RECLAIM_SECONDS.labels("trim").observe(trim_seconds)
        after = rss_bytes()
        PROCESS_MEMORY_RECLAIM_RUNS_TOTAL.inc()
        if before is not None and after is not None and before > after:
            PROCESS_MEMORY_RECLAIMED_BYTES_TOTAL.inc(before - after)
        logger.debug(
            "memory reclaimed: gc found=%d ms=%.0f, trim ms=%.0f, rss %s -> %s MiB",
            found,
            gc_seconds * 1000,
            trim_seconds * 1000,
            before and before >> 20,
            after and after >> 20,
        )
