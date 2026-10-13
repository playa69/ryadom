"""Фоновая работа памяти (MEM-7.1, MEM-7.8): очередь извлечения и цикл обслуживания.

Очередь (`memory_jobs`) опрашивается раз в 5 секунд и сразу, когда завершённый разговор поставил задание; одновременно идёт
не больше `MEMORY_WORKERS` заданий. Обслуживание раз в `MEMORY_MAINTENANCE_SECONDS`: простой открытых диалогов, повторы
упавших заданий, сроки жизни фактов, чистка истёкших строк, удаление разговоров «Без памяти» через 24 часа, забывание памяти
неактивных людей. Падение одного шага или задания не останавливает цикл; в журнал — только id и коды (I4).

Сроки и чистка работают при любом `MEMORY_MODE`, если есть диск: это обещания человеку о хранении, а не часть функции.
Извлечение — только в режимах shadow и on при настроенной модели.
"""

import asyncio
import logging
from datetime import timedelta
from typing import Any

from app.core.config import MemorySettings
from app.core.metrics import MEMORY_FACTS_TOTAL, MEMORY_JOBS
from app.memory import rules_ru as R
from app.memory import store as S
from app.memory.models import Job, days, iso
from app.memory.service import MAX_ATTEMPTS, MemoryService
from app.services.dialog_store import DialogStore

logger = logging.getLogger("agent.memory")

POLL_SECONDS = 5.0
STOP_TIMEOUT_SECONDS = 10.0
HOURLY = timedelta(hours=1)


class MemoryWorker:
    def __init__(
        self,
        service: MemoryService,
        store: DialogStore,
        config: MemorySettings,
        poll_seconds: float = POLL_SECONDS,
    ) -> None:
        self._service = service
        self._store = store
        self._cfg = config
        self._poll = poll_seconds
        self._loops: list[asyncio.Task[None]] = []
        self._running: set[asyncio.Task[Any]] = set()
        self._idle_checked: dict[str, str] = {}  # dialog_id → время последней реплики, по которому уже ставили задание
        self._last_hourly = None

    # ─── жизненный цикл ───────────────────────────────────────────────────────

    async def start(self) -> None:
        """После `store.attach`: задания, оборванные прошлым запуском, возвращаются в очередь; циклы запускаются."""
        db = self._service.db
        if db is None:
            return
        requeued = await asyncio.to_thread(db.run, S.requeue_running)
        if requeued:
            logger.info("memory jobs requeued after restart count=%d", requeued)
        self._loops = [
            asyncio.create_task(self._queue_loop(), name="memory-queue"),
            asyncio.create_task(self._maintenance_loop(), name="memory-maintenance"),
        ]

    async def stop(self, timeout: float = STOP_TIMEOUT_SECONDS) -> None:
        """Перед `store.detach`: циклы останавливаются, идущее задание дожидается не дольше `timeout`; недоделанное остаётся
        `running` и после перезапуска снова попадает в очередь."""
        for loop in self._loops:
            loop.cancel()
        await asyncio.gather(*self._loops, return_exceptions=True)
        self._loops = []
        if self._running:
            _, pending = await asyncio.wait(set(self._running), timeout=timeout)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        await self._service.drain()

    # ─── очередь ──────────────────────────────────────────────────────────────

    async def _queue_loop(self) -> None:
        wake = self._service.wake
        while True:
            try:
                await self.run_due()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - цикл не должен умирать
                logger.exception("memory queue iteration failed")
            try:
                await asyncio.wait_for(wake.wait(), self._poll)
            except TimeoutError:
                pass
            wake.clear()

    async def run_due(self) -> int:
        """Взять из очереди до `MEMORY_WORKERS` заданий и выполнить. Возвращает, сколько взято."""
        service = self._service
        db = service.db
        if db is None or not service.available:
            return 0
        free = self._cfg.workers - len(self._running)
        if free <= 0:
            return 0
        jobs: list[Job] = await asyncio.to_thread(db.run, lambda conn: S.due_jobs(conn, iso(service.now()), free))
        for job in jobs:
            task = asyncio.create_task(self._process(job))
            self._running.add(task)
            task.add_done_callback(self._running.discard)
        if jobs:  # wait, а не gather: остановка цикла не должна обрывать идущие задания (их ждёт stop)
            await asyncio.wait(set(self._running))
        return len(jobs)

    async def _process(self, job: Job) -> None:
        try:
            await self._service.process(job)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - падение задания не валит цикл
            logger.exception("memory job crashed dialog=%s", job.dialog_id)

    # ─── обслуживание ─────────────────────────────────────────────────────────

    async def _maintenance_loop(self) -> None:
        while True:
            await asyncio.sleep(self._cfg.maintenance_seconds)
            try:
                await self.maintain()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("memory maintenance failed")

    async def maintain(self) -> None:
        """Один проход обслуживания. Каждый шаг сам по себе: сбой одного не мешает остальным."""
        if self._service.db is None:
            return
        steps = [self._expire, self._purge, self._delete_memory_off, self._job_gauge]
        if self._service.mode != "off":
            steps = [self._idle, self._retry, *steps]
        now = self._service.now()
        if self._last_hourly is None or now - self._last_hourly >= HOURLY:
            self._last_hourly = now
            steps += [self._forget_inactive, self._refresh_briefs]
        for step in steps:
            try:
                await step()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("memory maintenance step failed step=%s", step.__name__)

    async def _db(self, operation: Any) -> Any:
        db = self._service.db
        assert db is not None
        return await asyncio.to_thread(db.run, operation)

    async def _idle(self) -> None:
        """Открытый диалог молчит дольше MEMORY_IDLE_MINUTES (или завершённый остался без задания): ставим извлечение.
        Диалог при этом не завершается."""
        now = self._service.now()
        cutoff = iso(now - timedelta(minutes=self._cfg.idle_minutes))
        rows = await self._db(lambda conn: S.idle_candidates(conn, cutoff, 50))
        for dialog_id, user_id, last_at in rows:
            if self._idle_checked.get(dialog_id) == last_at:
                continue
            self._idle_checked[dialog_id] = last_at
            await self._store.ensure_user(user_id)
            dialog = self._store.get(user_id, dialog_id)
            if dialog is not None:
                await self._service.enqueue(dialog)
        if len(self._idle_checked) > 10_000:
            self._idle_checked.clear()

    async def _retry(self) -> None:
        now = iso(self._service.now())
        if await self._db(lambda conn: S.retry_failed(conn, now, MAX_ATTEMPTS)):
            self._service.wake.set()

    async def _expire(self) -> None:
        now = self._service.now()
        stamp, purge = iso(now), iso(now + days(R.EXPIRED_KEEP_DAYS))
        expired = await self._db(lambda conn: S.expire_due(conn, stamp, purge))
        for user_id in {user_id for user_id, _ in expired}:
            self._service.invalidate(user_id)
        if expired:
            MEMORY_FACTS_TOTAL.labels("expire").inc(len(expired))
            logger.info("memory facts expired count=%d", len(expired))

    async def _purge(self) -> None:
        stamp = iso(self._service.now())
        purged = await self._db(lambda conn: S.purge_due(conn, stamp))
        if purged:
            db = self._service.db
            assert db is not None
            await asyncio.to_thread(db.checkpoint)
            logger.info("memory facts purged count=%d", len(purged))

    async def _delete_memory_off(self) -> None:
        """Разговор «Без памяти» удаляется целиком через 24 часа после последнего сообщения (или закрытия сокета)."""
        now = self._service.now()
        cutoff = iso(now - timedelta(hours=R.MEMORY_OFF_DIALOG_HOURS))
        rows = await self._db(lambda conn: S.memory_off_due(conn, cutoff, 50))
        for dialog_id, user_id in rows:
            dialog = self._store.get(user_id, dialog_id)
            if dialog is not None and (dialog.has_live_socket or (dialog.socket_closed_at or "") > cutoff):
                continue
            await self._store.delete_dialog(user_id, dialog_id, forget_derived=True)
            logger.info("memory-off dialog deleted dialog=%s", dialog_id)

    async def _forget_inactive(self) -> None:
        """Память человека, не заходившего 12 месяцев, стирается (аккаунт и диалоги не трогаются)."""
        cutoff = iso(self._service.now() - days(R.INACTIVE_FORGET_DAYS))
        for user_id in await self._db(lambda conn: S.inactive_users(conn, cutoff, 100)):
            await self._service.forget_all(user_id, actor="system")
            logger.info("memory forgotten for inactivity user=%s", user_id)

    async def _refresh_briefs(self) -> None:
        await self._service.refresh_stale(HOURLY)

    async def _job_gauge(self) -> None:
        counts = await self._db(S.job_counts)
        for status in ("queued", "running", "done", "skipped", "failed"):
            MEMORY_JOBS.labels(status).set(counts.get(status, 0))
