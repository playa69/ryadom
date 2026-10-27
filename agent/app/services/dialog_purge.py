"""Физическая очистка мягко стёртого (PROTEUS-255).

Стирание человека, удаление разговора и срок хранения только ставят `deleted_at` у `dialogs` и `voice_prefs`: чтения помеченное не
видят, запись его не воскрешает (`app/services/dialog_db.py`). Здесь помеченное больше часа назад убирается из базы: диалоги вместе
с сообщениями, идентификаторами клиента и отпечатками реплик, выбор голоса. Строки расхода моделей (`model_usage`) не удаляются, а
теряют `dialog_id` и `message_id`: модель, количество и время остаются для отчётов о стоимости.

Обещание человеку: для него данные исчезают сразу (пометка), из базы агента — в течение часа (этот цикл), из резервных копий кластера —
за срок их хранения (30 дней). Заметки памяти, настройки памяти и разговоров и очередь Cognee здесь не нужны: стирание человека
удаляет их само и сразу, а удаление одного разговора заметки намеренно оставляет.

Агент — единственный писатель своей базы и работает в одной реплике, но цикл не ломается и при двух: пачка берёт строки с
`FOR UPDATE SKIP LOCKED`, удаление идемпотентно, а счётчики считают только то, что удалила своя транзакция.
"""

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from app.core.metrics import (
    DIALOG_DB_ERRORS_TOTAL,
    DIALOG_PURGE_DELETED_ROWS_TOTAL,
    DIALOG_PURGE_OVERDUE_ROWS,
    DIALOG_PURGE_USAGE_ANONYMIZED_TOTAL,
)
from app.services.dialog_db import DialogDatabase, PurgeStats, iso_utc

logger = logging.getLogger("agent.purge")

# Как часто искать помеченное.
PURGE_INTERVAL_SECONDS = 600
# Первый проход после старта пода: не конкурировать с прогревом фраз и первыми сокетами, но и не ждать целый интервал.
PURGE_FIRST_DELAY_SECONDS = 60
# Помеченное моложе часа не трогается: запас на операции, которые ещё помнят только что стёртый разговор (очередь Cognee), и на разбор
# ошибочного стирания до необратимого шага.
PURGE_GRACE = timedelta(hours=1)
# Пометка старше двух часов при работающей очистке не встречается (час ожидания и интервал проходов); метрика считает такие строки.
PURGE_OVERDUE_AFTER = timedelta(hours=2)
# Сколько диалогов (или строк выбора голоса) уходит одной транзакцией: короткая транзакция не держит блокировки и не мешает писателю.
PURGE_BATCH = 500
# Пауза между пачками одного прохода: за это время писатель и чтения берут общий замок базы.
PURGE_BATCH_PAUSE_SECONDS = 0.1


def _count(stats: PurgeStats) -> None:
    """Метрики по пачке сразу после её коммита: прогресс виден, даже если следующая пачка упадёт."""
    for table in ("dialogs", "messages", "client_ids", "memory_sources", "voice_prefs"):
        deleted = getattr(stats, table)
        if deleted:
            DIALOG_PURGE_DELETED_ROWS_TOTAL.labels(table).inc(deleted)
    if stats.usage_anonymized:
        DIALOG_PURGE_USAGE_ANONYMIZED_TOTAL.inc(stats.usage_anonymized)


async def _purge_dialogs(db: DialogDatabase, cutoff: str, total: PurgeStats) -> None:
    """Диалоги пачками, пока пачки приходят полными."""
    while True:
        stats = await asyncio.to_thread(db.purge_dialogs, cutoff, PURGE_BATCH)
        _count(stats)
        total.add(stats)
        if stats.dialogs < PURGE_BATCH:
            return
        await asyncio.sleep(PURGE_BATCH_PAUSE_SECONDS)


async def _purge_voice_prefs(db: DialogDatabase, cutoff: str, total: PurgeStats) -> None:
    """Выбор голоса пачками, пока пачки приходят полными."""
    while True:
        stats = PurgeStats(voice_prefs=await asyncio.to_thread(db.purge_voice_prefs, cutoff, PURGE_BATCH))
        _count(stats)
        total.add(stats)
        if stats.voice_prefs < PURGE_BATCH:
            return
        await asyncio.sleep(PURGE_BATCH_PAUSE_SECONDS)


async def purge_pass(db: DialogDatabase, now: datetime) -> PurgeStats:
    """Один проход: диалоги, затем выбор голоса, затем обновление gauge просроченного. Сбой любого шага не мешает остальным (счётчик
    `agent_dialog_db_errors_total{op="purge"}`, трассировка в журнале): следующий проход повторит. Возвращает, сколько убрано."""
    cutoff = iso_utc(now - PURGE_GRACE)
    total = PurgeStats()
    for table, step in (("dialogs", _purge_dialogs), ("voice_prefs", _purge_voice_prefs)):
        try:
            await step(db, cutoff, total)
        except Exception:  # noqa: BLE001 - база недоступна или запрос не прошёл: повторим на следующем проходе
            DIALOG_DB_ERRORS_TOTAL.labels("purge").inc()
            logger.exception("dialog purge failed table=%s", table)
    try:
        overdue = await asyncio.to_thread(db.marked_counts, iso_utc(now - PURGE_OVERDUE_AFTER))
    except Exception:  # noqa: BLE001
        DIALOG_DB_ERRORS_TOTAL.labels("purge").inc()
        logger.exception("dialog purge overdue count failed")
    else:
        DIALOG_PURGE_OVERDUE_ROWS.labels("dialogs").set(overdue[0])
        DIALOG_PURGE_OVERDUE_ROWS.labels("voice_prefs").set(overdue[1])
        if overdue[0] or overdue[1]:
            logger.warning("dialog purge overdue dialogs=%d voice_prefs=%d", *overdue)
    if total.total:
        logger.info(
            "dialog purge dialogs=%d messages=%d client_ids=%d memory_sources=%d voice_prefs=%d usage_anonymized=%d",
            total.dialogs,
            total.messages,
            total.client_ids,
            total.memory_sources,
            total.voice_prefs,
            total.usage_anonymized,
        )
    return total


async def purge_loop(get_database: Callable[[], DialogDatabase | None]) -> None:
    """Фон: раз в `PURGE_INTERVAL_SECONDS` физическая очистка. Базу берёт на каждом проходе: её могли не открыть при старте (диалоги
    тогда только в памяти) — очищать нечего. Запускает и останавливает приложение (lifespan)."""
    await asyncio.sleep(PURGE_FIRST_DELAY_SECONDS)
    while True:
        db = get_database()
        if db is not None:
            try:
                await purge_pass(db, datetime.now(UTC))
            except Exception:  # noqa: BLE001 - цикл не должен умирать: без него помеченное лежало бы бессрочно
                DIALOG_DB_ERRORS_TOTAL.labels("purge").inc()
                logger.exception("dialog purge pass failed")
        await asyncio.sleep(PURGE_INTERVAL_SECONDS)
