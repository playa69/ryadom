"""Очередь и обслуживание памяти (MEM-7.1, MEM-7.8): триггеры, условия постановки, идемпотентность (I12), повторы с паузами,
возврат оборванных заданий после перезапуска, гонка с «забыть всё» (I9), падение задания не валит цикл, сроки и чистка,
удаление разговоров «Без памяти», забывание неактивных, подсказка тона после кризиса."""

import asyncio
from pathlib import Path
from typing import Any

from prometheus_client import REGISTRY

from app.memory import store as S
from app.memory.service import MemoryService
from app.memory.worker import MemoryWorker
from app.services.dialog_store import DialogStore
from tests.memory_support import (
    FOUR,
    Clock,
    FakeModel,
    answer,
    close_env,
    enable,
    job_of,
    make_env,
    model_error,
    op,
    run_job,
    talk,
    user,
)


async def env(
    tmp_path: Path, *answers: Any, clock: Clock | None = None, **settings: Any
) -> tuple[DialogStore, MemoryService, str]:
    store, _, service = await make_env(tmp_path / "w.sqlite3", FakeModel(*answers), clock, **settings)
    u = user()
    await store.ensure_user(u)
    await enable(service, u)
    return store, service, u


async def rows(service: MemoryService, sql: str, *args: Any) -> list[tuple[Any, ...]]:
    assert service.db is not None
    return await asyncio.to_thread(service.db.run, lambda conn: conn.execute(sql, args).fetchall())


def failures(reason: str) -> float:
    return REGISTRY.get_sample_value("agent_memory_extraction_failures_total", {"reason": reason}) or 0.0


# ─── триггеры ─────────────────────────────────────────────────────────────────


async def test_dialog_end_queues_a_job(tmp_path: Path) -> None:
    store, service, u = await env(tmp_path)
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    store.end(dialog, None, None)
    await service.drain()
    job = await job_of(service, dialog.id)
    assert job is not None and job.status == "queued" and service.wake.is_set()
    await close_env(store, service)


async def test_new_dialog_queues_the_previous_one(tmp_path: Path) -> None:
    store, service, u = await env(tmp_path)
    first, _, _ = store.start(u)
    talk(store, first, *FOUR)
    store.start(u, new=True)
    await service.drain()
    assert (await job_of(service, first.id)).status == "queued"  # type: ignore[union-attr]
    await close_env(store, service)


async def test_idle_dialog_gets_a_job_without_being_ended(tmp_path: Path) -> None:
    clock = Clock()
    store, service, u = await env(tmp_path, clock=clock)
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    await store.flush()
    worker = MemoryWorker(service, store, service._cfg)
    await worker.maintain()
    assert await job_of(service, dialog.id) is None  # ещё не простой
    clock.advance(minutes=21)
    worker._last_hourly = clock()
    await worker.maintain()
    job = await job_of(service, dialog.id)
    assert job is not None and job.status == "queued" and dialog.ended_at is None
    await close_env(store, service)


# ─── условия постановки (MEM-7.1) ─────────────────────────────────────────────


async def test_nothing_is_written_for_a_person_without_memory(tmp_path: Path) -> None:
    store, _, service = await make_env(tmp_path / "w.sqlite3", FakeModel())
    u = user()
    await store.ensure_user(u)
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    assert await service.enqueue(dialog) is None
    assert await rows(service, "SELECT * FROM memory_jobs") == []  # I1: ни строки памяти без согласия
    await close_env(store, service)


async def test_memory_off_dialog_gets_no_job(tmp_path: Path) -> None:
    store, service, u = await env(tmp_path)
    dialog, _, _ = store.start(u, memory_mode="off")
    talk(store, dialog, *FOUR)
    store.end(dialog, None, None)
    await service.drain()
    assert await job_of(service, dialog.id) is None  # I2
    await close_env(store, service)


async def test_dialog_started_before_enabling_is_not_extracted(tmp_path: Path) -> None:
    clock = Clock()
    store, _, service = await make_env(tmp_path / "w.sqlite3", FakeModel(), clock)
    u = user()
    await store.ensure_user(u)
    before, _, _ = store.start(u)  # начат до включения памяти
    talk(store, before, *FOUR)
    clock.advance(seconds=5)
    await enable(service, u)
    assert await run_job(service, before) == "skipped"
    assert (await job_of(service, before.id)).skip_reason == "epoch"  # type: ignore[union-attr]  # I9
    await close_env(store, service)


async def test_short_and_crisis_dialogs_are_skipped(tmp_path: Path) -> None:
    store, service, u = await env(tmp_path)
    short, _, _ = store.start(u)
    talk(store, short, "Привет", "Пока")
    assert await run_job(service, short) == "skipped"
    assert (await job_of(service, short.id)).skip_reason == "too_short"  # type: ignore[union-attr]
    crisis, _, _ = store.start(u, new=True)
    talk(store, crisis, *FOUR)
    store.mark_crisis(crisis)
    assert await run_job(service, crisis) == "skipped"
    assert (await job_of(service, crisis.id)).skip_reason == "crisis"  # type: ignore[union-attr]  # I13
    await close_env(store, service)


async def test_crisis_dialog_keeps_only_explicit_requests(tmp_path: Path) -> None:
    store, service, u = await env(
        tmp_path,
        answer(
            op(category="works", text="Помогают вечерние прогулки", evidence=[2]),
            op(category="works", text="Не любит советы в лоб", evidence=[0]),
        ),
    )
    dialog, _, _ = store.start(u)
    talk(store, dialog, "Запомни, что я не люблю советы в лоб", "Меня вечером спасают прогулки", "ну", "вот")
    store.mark_crisis(dialog)
    assert await run_job(service, dialog) == "done"
    facts = await rows(service, "SELECT text, origin FROM memory_facts")
    assert facts == [("Не любит советы в лоб", "user_said")]
    await close_env(store, service)


# ─── идемпотентность и повторы ────────────────────────────────────────────────


async def test_enqueue_is_idempotent_and_revives_only_with_new_talk(tmp_path: Path) -> None:
    store, service, u = await env(tmp_path, answer(), answer())
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    assert await service.enqueue(dialog) == "queued"
    assert await service.enqueue(dialog) == "queued"
    assert len(await rows(service, "SELECT * FROM memory_jobs")) == 1
    job = await job_of(service, dialog.id)
    assert job is not None and await service.process(job) == "done"
    talk(store, dialog, "Ещё одно")
    assert await service.enqueue(dialog) == "done"  # одна новая реплика — мало
    talk(store, dialog, *FOUR[:3])
    assert await service.enqueue(dialog) == "queued"  # набралось четыре
    await close_env(store, service)


async def test_failures_retry_with_pauses_and_then_give_up(tmp_path: Path) -> None:
    clock = Clock()
    store, service, u = await env(tmp_path, model_error(), model_error(), model_error(), clock=clock)
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    worker = MemoryWorker(service, store, service._cfg)
    before = failures("model")
    assert await run_job(service, dialog) == "retry"
    await worker._retry()
    assert (await job_of(service, dialog.id)).status == "failed"  # type: ignore[union-attr]  # пауза 30 с ещё идёт
    clock.advance(seconds=31)
    await worker._retry()
    job = await job_of(service, dialog.id)
    assert job is not None and job.status == "queued"
    assert await service.process(job) == "retry"
    clock.advance(seconds=121)
    await worker._retry()
    job = await job_of(service, dialog.id)
    assert job is not None and await service.process(job) == "failed"
    job = await job_of(service, dialog.id)
    assert job is not None and (job.status, job.attempts, job.skip_reason) == ("failed", 3, "failed")
    clock.advance(minutes=11)
    await worker._retry()
    assert (await job_of(service, dialog.id)).status == "failed"  # type: ignore[union-attr]  # навсегда
    assert failures("model") == before + 1
    await close_env(store, service)


async def test_running_jobs_return_to_the_queue_after_a_restart(tmp_path: Path) -> None:
    store, service, u = await env(tmp_path)
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    await service.enqueue(dialog)
    await rows(service, "UPDATE memory_jobs SET status = 'running'")
    worker = MemoryWorker(service, store, service._cfg)
    await worker.start()
    await worker.stop()
    assert (await job_of(service, dialog.id)).status == "queued"  # type: ignore[union-attr]
    await close_env(store, service)


async def test_forget_all_during_extraction_writes_nothing(tmp_path: Path) -> None:
    """«Забыть всё», пока модель думает: воркер проверяет задание и эпоху внутри транзакции записи (I9)."""
    holder: dict[str, Any] = {}

    async def forget(_: Any) -> None:
        await holder["service"].forget_all(holder["user"])

    model = FakeModel(answer(op(evidence=[2])), hook=forget)
    store, _, service = await make_env(tmp_path / "w.sqlite3", model)
    u = user()
    holder.update(service=service, user=u)
    await store.ensure_user(u)
    await enable(service, u)
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    assert await run_job(service, dialog) == "skipped"
    assert await rows(service, "SELECT * FROM memory_facts") == []
    assert await rows(service, "SELECT * FROM memory_jobs") == []
    await close_env(store, service)


async def test_disabling_during_extraction_writes_nothing(tmp_path: Path) -> None:
    holder: dict[str, Any] = {}

    async def disable(_: Any) -> None:
        await holder["service"].update_settings(holder["user"], False, None)

    store, _, service = await make_env(tmp_path / "w.sqlite3", FakeModel(answer(op(evidence=[2])), hook=disable))
    u = user()
    holder.update(service=service, user=u)
    await store.ensure_user(u)
    await enable(service, u)
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    await run_job(service, dialog)
    assert await rows(service, "SELECT * FROM memory_facts") == []
    await close_env(store, service)


async def test_a_crashing_job_does_not_stop_the_queue(tmp_path: Path) -> None:
    store, service, u = await env(tmp_path, RuntimeError("неожиданно"), answer(op(evidence=[2])))
    first, _, _ = store.start(u)
    talk(store, first, *FOUR)
    second, _, _ = store.start(u, new=True)  # первый завершён и поставлен
    talk(store, second, *FOUR)
    await service.enqueue(second)
    await service.drain()
    worker = MemoryWorker(service, store, service._cfg)
    assert await worker.run_due() == 1
    assert await worker.run_due() == 1
    statuses = sorted(row[0] for row in await rows(service, "SELECT status FROM memory_jobs"))
    assert statuses == ["done", "failed"]
    await close_env(store, service)


# ─── обслуживание ─────────────────────────────────────────────────────────────


async def test_facts_expire_and_are_purged_later(tmp_path: Path) -> None:
    clock = Clock()
    store, service, u = await env(
        tmp_path, answer(op(category="situation", text="Ищет работу после увольнения", evidence=[0])), clock=clock
    )
    dialog, _, _ = store.start(u)
    talk(store, dialog, "Ищу работу после увольнения", *FOUR[1:])
    await run_job(service, dialog)
    worker = MemoryWorker(service, store, service._cfg)
    clock.advance(days=61)
    worker._last_hourly = clock()
    await worker.maintain()
    assert await rows(service, "SELECT status FROM memory_facts") == [("expired",)]
    clock.advance(days=31)
    await worker.maintain()
    assert await rows(service, "SELECT * FROM memory_facts") == []
    assert await rows(service, "SELECT * FROM memory_fact_sources") == []
    await close_env(store, service)


async def test_memory_off_dialog_is_deleted_after_a_day(tmp_path: Path) -> None:
    clock = Clock()
    store, _, service = await make_env(tmp_path / "w.sqlite3", None, clock, MEMORY_MODE="off")  # обещано при любом режиме
    u = user()
    await store.ensure_user(u)
    dialog, _, _ = store.start(u, memory_mode="off")
    talk(store, dialog, "Это разговор без памяти, его надо удалить")
    store.socket_opened(dialog)
    store.socket_closed(dialog)
    await store.flush()
    worker = MemoryWorker(service, store, service._cfg)
    worker._last_hourly = clock()
    await worker.maintain()
    assert store.get(u, dialog.id) is not None
    clock.advance(hours=25)
    await worker.maintain()
    assert store.get(u, dialog.id) is None
    assert await rows(service, "SELECT * FROM dialogs WHERE id = ?", dialog.id) == []
    assert await rows(service, "SELECT * FROM messages WHERE dialog_id = ?", dialog.id) == []
    await close_env(store, service)


async def test_live_socket_postpones_deletion(tmp_path: Path) -> None:
    clock = Clock()
    store, service, u = await env(tmp_path, clock=clock)
    dialog, _, _ = store.start(u, memory_mode="off")
    talk(store, dialog, "Без памяти")
    store.socket_opened(dialog)
    await store.flush()
    clock.advance(hours=25)
    worker = MemoryWorker(service, store, service._cfg)
    worker._last_hourly = clock()
    await worker.maintain()
    assert store.get(u, dialog.id) is not None
    store.socket_closed(dialog)
    await close_env(store, service)


async def test_inactive_people_are_forgotten_after_a_year(tmp_path: Path) -> None:
    clock = Clock()
    store, service, u = await env(tmp_path, clock=clock)
    await service.add_fact(u, "interest", "Любит джаз и старые пластинки", None)
    worker = MemoryWorker(service, store, service._cfg)
    clock.advance(days=366)
    await worker.maintain()
    assert await rows(service, "SELECT * FROM memory_facts") == []
    assert await rows(service, "SELECT enabled FROM memory_settings") == [(1,)]  # выключатель и согласие не тронуты
    await close_env(store, service)


async def test_crisis_dialog_leaves_a_tone_hint_without_content(tmp_path: Path) -> None:
    store, service, u = await env(tmp_path)
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    store.mark_crisis(dialog)
    store.end(dialog, None, None)
    await service.drain()
    [(until,)] = await rows(service, "SELECT tone_hint_until FROM memory_settings")
    assert until is not None
    assert "бережно" in service.cache.text(u)
    await close_env(store, service)


async def test_job_gauge(tmp_path: Path) -> None:
    store, service, u = await env(tmp_path)
    dialog, _, _ = store.start(u)
    talk(store, dialog, *FOUR)
    await service.enqueue(dialog)
    await MemoryWorker(service, store, service._cfg)._job_gauge()
    assert REGISTRY.get_sample_value("agent_memory_jobs", {"status": "queued"}) == 1
    await close_env(store, service)


def test_store_helpers_have_no_text_columns_in_jobs_and_events() -> None:
    """Задания и события без текстов (I4): только коды, id и время."""
    import sqlite3

    conn = sqlite3.connect(":memory:")
    from app.services.dialog_db import migration_statements

    for statement in migration_statements(0):
        conn.execute(statement)
    for table in ("memory_jobs", "memory_events", "memory_tombstones"):
        names = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        assert not names & {"text", "note", "slots", "message"}, table
    assert S.LIVE_STATUSES == ("candidate", "proposed", "active", "pinned")
