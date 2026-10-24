"""Выгрузка давно неактивных людей из памяти пода и загрузка обратно с диска (DIALOG_IDLE_EVICT_SECONDS, DIALOG_MAX_USERS_IN_MEMORY).

Время подставное: `evict_idle(now)` получает «сейчас» на час позже настоящего. Запись на диск в тестах хранилища — вручную
(`flush`), фоновая запись не успевает сработать. В тестах приложения выгрузка зовётся в его цикле событий (`client.portal`).
"""

import asyncio
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app.core.config import APP_CONFIG
from app.main import create_app
from app.services.dialog_db import DialogDbError, DialogWrite
from tests.fake_db import FakeDialogDatabase as DialogDatabase
from app.services.dialog_store import DialogStore
from tests.conftest import AUTH, FakeTts, has, read_frames, send_user_message, start_dialog, ws_url
from tests.test_persistence import app_client, say

HOUR = 3600.0


def later(seconds: float = HOUR) -> float:
    return time.monotonic() + seconds


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


async def make_store(
    path: Path, idle: float = 1800, cap: int = 0, db: DialogDatabase | None = None
) -> tuple[DialogStore, DialogDatabase]:
    store = DialogStore(idle_evict_seconds=idle, max_users_in_memory=cap)
    db = db or DialogDatabase(str(path))
    await store.attach(db, flush_interval=60)  # фоновой записи не ждём: вызываем вручную
    return store, db


def in_memory(store: DialogStore, user: str) -> bool:
    """Осталось ли о человеке в памяти хранилища хоть что-то."""
    return any(
        user in part
        for part in (store._users, store._loaded, store._voice_prefs, store._persisted_prefs, store._last_access)
    )


def picture(store: DialogStore, user: str) -> list[tuple[Any, ...]]:
    """Всё, что должно пережить выгрузку, в порядке журнала (от новых к старым)."""
    return [
        (
            d.id,
            d.started_at,
            d.ended_at,
            d.summary,
            d.greeting,
            d.voice,
            d.reply_index,
            dict(d.client_ids),
            [(m.id, m.role, m.text, m.created_at) for m in d.messages],
        )
        for d in store.list(user, 50, None)[0]
    ]


# ─── Хранилище ────────────────────────────────────────────────────────────────────────────────────────────────────


async def test_evicted_user_comes_back_from_disk_exactly_as_before(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, _ = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    first, _, _ = store.start(user, "female")
    q = store.add_message(first, "user", "Мне сегодня тревожно")
    first.client_ids["c-1"] = q.id
    store.add_message(first, "assistant", "Я рядом. Что случилось?")
    first.reply_index = 2
    summary = store.end(first, "Тревога", 4)
    second, _, _ = store.start(user)
    store.add_message(second, "user", "Снова я")
    before = picture(store, user)
    assert [item[0] for item in before] == [second.id, first.id]
    assert await store.flush()

    assert store.evict_idle(later()) == 1
    assert not in_memory(store, user)
    assert first.id not in store._persisted and second.id not in store._persisted

    await store.ensure_user(user)
    assert picture(store, user) == before  # сообщения, client_ids, reply_index, сводка, голос, порядок журнала
    assert store.get(user, first.id).summary == summary  # type: ignore[union-attr]
    assert store._voice_prefs[user] == "female"
    reopened, resumed, _ = store.start(user)
    assert resumed and reopened.id == second.id and reopened is not second  # тот же диалог, свежий объект с диска
    assert reopened.voice == "female"  # выбор голоса тоже вернулся
    await store.detach()


async def test_live_socket_keeps_the_user_in_memory_until_it_is_closed_and_written(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, db = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.socket_opened(dialog)
    message = store.add_message(dialog, "assistant", "Я")
    assert await store.flush()

    skipped = sample("agent_dialog_evictions_skipped_total", reason="socket")
    assert store.evict_idle(later()) == 0  # сокет молчит дольше срока, но жив: сессия держит объект диалога
    assert store.get(user, dialog.id) is dialog
    assert sample("agent_dialog_evictions_skipped_total", reason="socket") == skipped + 1

    message.text = "Я рядом. Расскажи, что случилось."  # сессия дописывает ответ на месте уже после срока
    store.socket_closed(dialog)
    assert store.evict_idle(later()) == 0  # закрытие записано ещё не на диск
    assert await store.flush()
    assert store.evict_idle(later()) == 1
    assert [m[2] for m in db.load_user(user)[0][0].messages] == ["Я рядом. Расскажи, что случилось."]
    await store.ensure_user(user)
    restored = store.get(user, dialog.id)
    assert restored is not None and not restored.has_live_socket
    assert [m.text for m in restored.messages] == ["Я рядом. Расскажи, что случилось."]
    await store.detach()


async def test_unsaved_changes_keep_the_user_in_memory(tmp_path: Path) -> None:
    class Flaky(DialogDatabase):
        fail = 0

        def apply(self, writes: list[DialogWrite]) -> None:
            if self.fail:
                self.fail -= 1
                raise DialogDbError("disk I/O error")
            super().apply(writes)

    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    store, db = await make_store(path, db=Flaky(str(path)))
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    message = store.add_message(dialog, "user", "привет")
    dirty = sample("agent_dialog_evictions_skipped_total", reason="dirty")
    assert store.evict_idle(later()) == 0  # ждёт записи

    db.fail = 2  # пачка и повтор по одному диалогу: изменения остаются только в памяти
    assert await store.flush() is False
    assert store.evict_idle(later()) == 0
    assert await store.flush() is True

    message.text = "привет, это правка на месте"  # после записи и без _touch: так дописывается ответ
    assert store.evict_idle(later()) == 0  # снимок записанного отстаёт от памяти
    assert dialog.id in store._dirty  # и диалог снова в очереди записи: выгрузится на следующем проходе
    assert sample("agent_dialog_evictions_skipped_total", reason="dirty") == dirty + 3
    assert await store.flush()

    store._voice_prefs[user] = "female"  # выбор голоса, ещё не записанный на диск
    assert store.evict_idle(later()) == 0
    assert await store.flush()
    assert store.evict_idle(later()) == 1
    stored, pref = db.load_user(user)
    assert [m[2] for m in stored[0].messages] == ["привет, это правка на месте"] and pref == "female"
    await store.detach()


async def test_user_is_not_evicted_while_their_write_is_in_flight(tmp_path: Path) -> None:
    class Slow(DialogDatabase):
        def __init__(self, path: str) -> None:
            super().__init__(path)
            self.entered, self.release = threading.Event(), threading.Event()

        def apply(self, writes: list[DialogWrite]) -> None:
            self.entered.set()
            self.release.wait(5)
            super().apply(writes)

    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    store, db = await make_store(path, db=Slow(str(path)))
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "привет")
    flushing = asyncio.create_task(store.flush())
    for _ in range(500):
        if db.entered.is_set():
            break
        await asyncio.sleep(0.01)
    assert dialog.id not in store._dirty  # пачка снята с очереди, запись идёт в потоке
    assert store.evict_idle(later()) == 0
    db.release.set()
    assert await flushing
    assert await store.flush()  # повторно поставленный в очередь диалог уже записан: писать нечего
    assert store.evict_idle(later()) == 1
    await store.detach()


async def test_store_without_a_disk_never_evicts() -> None:
    plain = DialogStore(idle_evict_seconds=1, max_users_in_memory=1)
    configured = DialogStore(idle_evict_seconds=1, max_users_in_memory=1)
    configured.require_disk()  # DIALOG_DB_PATH задан, но файл не открылся: выгружать некуда
    for store in (plain, configured):
        users = [str(uuid.uuid4()) for _ in range(3)]
        for user in users:
            await store.ensure_user(user)  # без диска ничего не делает
            dialog, _, _ = store.start(user)
            store.add_message(dialog, "user", "привет")
        assert store.evict_idle(later(10 * HOUR)) == 0
        assert all(store.open_dialog(user) is not None for user in users)
        assert sample("agent_dialog_users_in_memory") == 3  # размеры памяти считаются и без диска


async def test_eviction_switched_off_keeps_everyone(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, _ = await make_store(tmp_path / "d.sqlite3", idle=0, cap=0)
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "привет")
    assert await store.flush()
    assert store.evict_idle(later(100 * HOUR)) == 0
    assert store.get(user, dialog.id) is dialog
    await store.detach()


async def test_nothing_is_evicted_once_the_disk_is_detached(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, _ = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "привет")
    await store.detach()  # остановка пода: всё записано, но диска у хранилища больше нет
    assert not store.persistent
    assert store.evict_idle(later()) == 0  # без диска выгружать некуда, даже если человек остался отмеченным загруженным
    assert store.get(user, dialog.id) is dialog


async def test_a_dialog_waiting_to_be_replaced_keeps_the_person_in_memory(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, _ = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    assert await store.flush()
    dialog.on_replaced = lambda summary: None  # сессия ждёт завершения диалога снаружи (человек начнёт новый на другом экране)
    assert store.evict_idle(later()) == 0
    dialog.on_replaced = None
    assert store.evict_idle(later()) == 1
    await store.detach()


async def test_a_person_whose_load_is_in_flight_is_left_alone(tmp_path: Path) -> None:
    class Slow(DialogDatabase):
        def __init__(self, path: str) -> None:
            super().__init__(path)
            self.slow = False
            self.entered, self.release = threading.Event(), threading.Event()

        def load_user(self, user_id: str) -> Any:
            if self.slow:
                self.entered.set()
                self.release.wait(5)
            return super().load_user(user_id)

    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    store, db = await make_store(path, db=Slow(str(path)))
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "привет")
    assert await store.flush()
    assert store.evict_idle(later()) == 1

    reloads = sample("agent_dialog_loads_total", kind="reload")
    db.slow = True
    loading = asyncio.create_task(store.ensure_user(user))
    for _ in range(500):
        if db.entered.is_set():
            break
        await asyncio.sleep(0.01)
    assert db.entered.is_set() and user not in store._loaded  # диск читается в потоке, человека в памяти ещё нет
    assert store.evict_idle(later()) == 0  # выгрузка идущую загрузку не трогает
    assert user in store._evicted  # и метка «выгружали» остаётся: загрузка посчитается как reload
    db.release.set()
    await loading
    restored = store.get(user, dialog.id)
    assert restored is not None and [m.text for m in restored.messages] == ["привет"] and user in store._loaded
    assert sample("agent_dialog_loads_total", kind="reload") == reloads + 1
    await store.detach()


async def test_a_failed_load_leaves_no_trace_and_can_be_repeated(tmp_path: Path) -> None:
    class Flaky(DialogDatabase):
        fail = 0

        def load_user(self, user_id: str) -> Any:
            if self.fail:
                self.fail -= 1
                raise DialogDbError("disk I/O error")
            return super().load_user(user_id)

    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    store, db = await make_store(path, db=Flaky(str(path)))
    db.fail = 1
    errors = sample("agent_dialog_db_errors_total", op="load")
    with pytest.raises(DialogDbError):
        await store.ensure_user(user)
    assert sample("agent_dialog_db_errors_total", op="load") == errors + 1
    assert not in_memory(store, user)  # ни отметки обращения, ни «загружен»: пустой истории человеку не показали
    assert store.evict_idle(later()) == 0
    await store.ensure_user(user)  # диск ожил: следующее обращение загружает как обычно
    assert user in store._loaded and user in store._last_access
    await store.detach()


async def test_the_background_loop_survives_a_failed_pass() -> None:
    store = DialogStore()
    calls: list[float] = []

    def flaky(now: float) -> int:
        calls.append(now)
        if len(calls) == 1:
            raise RuntimeError("сбой прохода")
        return 0

    store.evict_idle = flaky  # type: ignore[method-assign]
    loop = asyncio.create_task(store.evict_loop(0.01))
    for _ in range(300):
        if len(calls) >= 3:
            break
        await asyncio.sleep(0.01)
    loop.cancel()
    await asyncio.gather(loop, return_exceptions=True)
    assert len(calls) >= 3  # после сбоя первого прохода выгрузка продолжает работать


async def test_after_eviction_the_disk_is_read_again(tmp_path: Path) -> None:
    class Counting(DialogDatabase):
        loads = 0

        def load_user(self, user_id: str) -> Any:
            self.loads += 1
            return super().load_user(user_id)

    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    first, reload = sample("agent_dialog_loads_total", kind="first"), sample("agent_dialog_loads_total", kind="reload")
    store, db = await make_store(path, db=Counting(str(path)))
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "привет")
    assert await store.flush()
    await store.ensure_user(user)
    assert db.loads == 1  # загруженный человек с диска повторно не читается
    assert store.evict_idle(later()) == 1

    # Пока человек выгружен, его строка на диске меняется: значит, следующая загрузка видна по данным, а не по счётчику.
    row = list(DialogStore._row_of(dialog))
    row[6], row[7] = "female", 7  # голос и номер ответа: колонки строки диалога (позже в строку добавляются новые поля, эти на месте)
    db.apply([DialogWrite(dialog.id, tuple(row))])
    await store.ensure_user(user)
    assert db.loads == 2
    restored = store.get(user, dialog.id)
    assert restored is not None and restored is not dialog
    assert (restored.reply_index, restored.voice, [m.text for m in restored.messages]) == (7, "female", ["привет"])
    assert sample("agent_dialog_loads_total", kind="first") == first + 1
    assert sample("agent_dialog_loads_total", kind="reload") == reload + 1
    await store.detach()


async def test_a_stale_dialog_object_does_not_overwrite_the_reloaded_one(tmp_path: Path) -> None:
    """Объект диалога, взятый до выгрузки, после неё хранилищу не принадлежит: его правки не пишутся и не затирают свежие.
    В коде такого держателя нет (обработчики берут диалог после `ensure_user` без await, сокет держит человека в памяти)."""
    user = str(uuid.uuid4())
    store, db = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    stale, _, _ = store.start(user)
    store.add_message(stale, "user", "привет")
    assert await store.flush()
    assert store.evict_idle(later()) == 1

    await store.ensure_user(user)
    fresh = store.get(user, stale.id)
    assert fresh is not None and fresh is not stale
    store.add_message(fresh, "assistant", "Я рядом.")
    store.add_message(stale, "user", "из устаревшего объекта")
    store.end(stale, None, None)
    assert await store.flush()
    saved = db.load_user(user)[0][0]
    assert [m[2] for m in saved.messages] == ["привет", "Я рядом."] and saved.ended_at is None
    assert store.open_dialog(user) is fresh
    await store.detach()


async def test_evicted_user_can_be_erased(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, db = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female")
    store.add_message(dialog, "user", "личное")
    assert await store.flush()
    assert store.evict_idle(later()) == 1

    await store.erase_user_durable(user)
    assert db.load_user(user) == ([], None) and db.counts() == (0, 0)
    assert user not in store._evicted  # даже id стёртого человека в памяти не остаётся
    await store.ensure_user(user)
    assert store.list(user, 10, None)[0] == [] and user not in store._voice_prefs
    await store.detach()


async def test_erase_during_a_reload_does_not_bring_the_person_back(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, db = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "личное")
    assert await store.flush()
    assert store.evict_idle(later()) == 1

    loading = asyncio.create_task(store.ensure_user(user))
    await asyncio.sleep(0)  # загрузка уже читает диск
    await store.erase_user_durable(user)
    await loading
    assert store.get(user, dialog.id) is None  # прочитанное с диска не вернулось в память после стирания
    assert db.load_user(user) == ([], None)
    assert user not in store._loaded and user not in store._evicted
    await store.detach()


async def test_reload_of_an_evicted_user_waits_for_the_erase(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, db = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "личное")
    assert await store.flush()
    assert store.evict_idle(later()) == 1

    erasing = asyncio.create_task(store.erase_user_durable(user))
    await asyncio.sleep(0)  # стирание держит замок загрузки и стирает диск
    loading = asyncio.create_task(store.ensure_user(user))  # загрузка ждёт конца стирания
    await asyncio.sleep(0)
    await erasing
    await loading
    assert store.list(user, 10, None)[0] == [] and db.load_user(user) == ([], None)
    assert user in store._loaded and user in store._last_access and user not in store._evicted  # загружен пустым
    assert store.evict_idle(later()) == 1  # и снова может быть выгружен
    await store.detach()


async def test_eviction_pass_during_an_erase_leaves_the_person_to_the_erase(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, db = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "личное")
    assert await store.flush()

    erasing = asyncio.create_task(store.erase_user_durable(user))
    await asyncio.sleep(0)  # стирание убрало человека из памяти и стирает диск, отметка загрузки ещё стоит
    assert user in store._loaded
    assert store.evict_idle(later()) == 0  # стираемого выгрузка не трогает
    await erasing
    assert not in_memory(store, user) and user not in store._evicted
    assert db.load_user(user) == ([], None)
    await store.detach()


async def test_access_and_eviction_in_the_middle_of_an_erase_leave_nothing_behind(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, _ = await make_store(tmp_path / "d.sqlite3")
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "личное")
    assert await store.flush()

    erasing = asyncio.create_task(store.erase_user_durable(user))
    await asyncio.sleep(0)
    await store.ensure_user(user)  # запрос посреди стирания: человек ещё отмечен загруженным, отметка обращения ставится снова
    assert store.evict_idle(later()) == 1  # в памяти о нём уже ничего, выгрузка снимает отметки
    await erasing
    assert not in_memory(store, user) and user not in store._evicted  # id стёртого не запомнен ни для метрики, ни для выгрузки

    other = str(uuid.uuid4())
    await store.ensure_user(other)
    store.start(other)
    assert await store.flush()
    erasing = asyncio.create_task(store.erase_user_durable(other))
    await asyncio.sleep(0)
    await store.ensure_user(other)
    await erasing
    assert not in_memory(store, other)  # отметка обращения, поставленная посреди стирания, не осталась навсегда
    await store.detach()


async def test_activity_through_the_store_resets_the_idle_clock(tmp_path: Path) -> None:
    user = str(uuid.uuid4())
    store, _ = await make_store(tmp_path / "d.sqlite3", idle=HOUR)
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    assert await store.flush()
    store._last_access[user] = time.monotonic() - 2 * HOUR  # последний запрос был давно…
    store.socket_opened(dialog)
    store.add_message(dialog, "user", "привет")  # …но человек говорит в сокете
    store.socket_closed(dialog)  # простой считается от закрытия сокета
    assert await store.flush()
    assert store.evict_idle(time.monotonic() + HOUR / 2) == 0
    assert store.evict_idle(later(HOUR + 1)) == 1
    await store.detach()


async def test_the_cap_evicts_the_least_recently_used_first(tmp_path: Path) -> None:
    store, _ = await make_store(tmp_path / "d.sqlite3", idle=0, cap=2)
    users = [str(uuid.uuid4()) for _ in range(4)]
    for user in users:
        await store.ensure_user(user)
        dialog, _, _ = store.start(user)
        store.add_message(dialog, "user", "привет")
    assert await store.flush()
    oldest = store.open_dialog(users[0])
    assert oldest is not None
    store.socket_opened(oldest)  # самого давнего держит сокет
    base = time.monotonic()
    for offset, user in zip((0, 10, 20, 30), users, strict=True):
        store._last_access[user] = base + offset  # порядок обращений задаём явно: часы monotonic в Windows грубые
    socket = sample("agent_dialog_evictions_skipped_total", reason="socket")

    assert store.evict_idle(base + 30 + HOUR) == 2  # потолок мягкий: вместо занятого сокетом выгружаются следующие
    assert [user in store._loaded for user in users] == [True, False, False, True]
    assert sample("agent_dialog_evictions_skipped_total", reason="socket") == socket + 1
    store.socket_closed(oldest)
    await store.detach()


async def test_the_cap_does_not_evict_users_seen_within_the_last_minute(tmp_path: Path) -> None:
    store, _ = await make_store(tmp_path / "d.sqlite3", idle=0, cap=1)
    users = [str(uuid.uuid4()) for _ in range(2)]
    for user in users:
        await store.ensure_user(user)
        store.start(user)
    assert await store.flush()
    base = time.monotonic()
    store._last_access[users[0]], store._last_access[users[1]] = base, base + 30

    assert store.evict_idle(base + 45) == 0  # оба обращались меньше минуты назад: например, между стартом и сокетом
    assert store.evict_idle(base + 75) == 1  # самый давний выгружен, и людей стало не больше потолка
    assert [user in store._loaded for user in users] == [False, True]
    await store.detach()


# ─── Приложение целиком ───────────────────────────────────────────────────────────────────────────────────────────


def dialog_url(user: str, dialog_id: str = "") -> str:
    return f"/v1/users/{user}/dialogs" + (f"/{dialog_id}" if dialog_id else "")


def test_rest_and_socket_work_the_same_after_eviction(tmp_path: Path) -> None:
    path = tmp_path / "dialogs.sqlite3"
    user = str(uuid.uuid4())
    with app_client(path) as client:
        store: DialogStore = client.app.state.store  # type: ignore[attr-defined]
        dialog = start_dialog(client, user)
        dialog_id = dialog["dialogId"]
        say(client, user, dialog_id, "Мне сегодня тревожно", "c-1")
        journal = client.get(dialog_url(user), headers=AUTH).json()
        history = client.get(dialog_url(user, dialog_id), headers=AUTH).json()
        assert [m["role"] for m in history["messages"]] == ["user", "assistant"]

        def evict() -> None:
            client.portal.call(store.flush)
            assert client.portal.call(store.evict_idle, later()) == 1
            assert not client.portal.call(in_memory, store, user)

        evict()
        assert client.get(dialog_url(user), headers=AUTH).json() == journal
        assert client.get(dialog_url(user, dialog_id), headers=AUTH).json() == history

        evict()
        resumed = start_dialog(client, user)
        assert (resumed["dialogId"], resumed["resumed"], resumed["messageCount"]) == (dialog_id, True, 2)

        evict()  # повтор реплики без ack после выгрузки: тот же messageId, второго сообщения и ответа нет
        frames = say(client, user, dialog_id, "Мне сегодня тревожно", "c-1", until="ack")
        assert has(frames, "ack", id="c-1", messageId=history["messages"][0]["id"])

        evict()  # переподключение продолжает тот же диалог
        say(client, user, dialog_id, "И ещё одно", "c-2")
        after = client.get(dialog_url(user, dialog_id), headers=AUTH).json()["messages"]
        assert after[:2] == history["messages"] and [m["role"] for m in after[2:]] == ["user", "assistant"]

        evict()  # завершение и новый разговор после выгрузки
        new = client.post(dialog_url(user), json={"new": True}, headers=AUTH).json()
        assert new["dialogId"] != dialog_id and new["resumed"] is False
        items = {i["dialogId"]: i for i in client.get(dialog_url(user), headers=AUTH).json()["items"]}
        assert items[dialog_id]["endedAt"] is not None and items[new["dialogId"]]["endedAt"] is None


def test_greeting_after_eviction_is_not_voiced_and_the_dialog_still_works(tmp_path: Path) -> None:
    path = tmp_path / "dialogs.sqlite3"
    user = str(uuid.uuid4())
    voice = FakeTts()
    app = create_app(lambda: voice, lambda: (None, None), database_factory=lambda: DialogDatabase(str(path)))
    with TestClient(app) as client:
        store: DialogStore = client.app.state.store  # type: ignore[attr-defined]
        dialog = start_dialog(client, user)
        client.portal.call(store.flush)
        assert client.portal.call(store.evict_idle, later()) == 1  # сокет открылся позже срока: неозвученное приветствие забыто
        with client.websocket_connect(ws_url(user, dialog["dialogId"]), headers=AUTH) as ws:
            ready = read_frames(ws, lambda f: has(f, "ready"))
            send_user_message(ws, "c-1", "привет")
            frames = read_frames(ws, lambda f: has(f, "assistant_end") and has(f, "tts_end"))
        assert not has(ready + frames, "tts_start", messageId="greeting")
        assert has(frames, "ack", id="c-1") and has(frames, "assistant_end")
        assert "С чего начнём?" not in voice.calls  # клиент прочтёт приветствие сам, из ответа на старт


@pytest.fixture
def fast_eviction(monkeypatch: pytest.MonkeyPatch) -> None:
    """Выгрузка в фоне за доли секунды: срок 0,3 с, проход раз в 50 мс (в бою 1800 и 60 с)."""
    monkeypatch.setattr(APP_CONFIG.dialog, "idle_evict_seconds", 0.3)
    monkeypatch.setattr(APP_CONFIG.dialog, "evict_interval_seconds", 0.05)


def wait_until(check: Any, seconds: float = 5.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.05)
    return check()


@pytest.mark.usefixtures("fast_eviction")
def test_a_live_socket_outlives_the_idle_limit_and_then_the_user_is_evicted(tmp_path: Path) -> None:
    path = tmp_path / "dialogs.sqlite3"
    user = str(uuid.uuid4())
    with app_client(path) as client:
        store: DialogStore = client.app.state.store  # type: ignore[attr-defined]
        dialog = start_dialog(client, user)
        with client.websocket_connect(ws_url(user, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "ready"))
            time.sleep(1.0)  # человек молчит дольше срока, выгрузка успевает пройти много раз
            assert client.portal.call(lambda: user in store._loaded)
            send_user_message(ws, "c-1", "я тут")
            read_frames(ws, lambda f: has(f, "assistant_end"))
        # сокет закрыт: фоновая запись, затем фоновая выгрузка
        assert wait_until(lambda: not client.portal.call(in_memory, store, user))
        messages = client.get(dialog_url(user, dialog["dialogId"]), headers=AUTH).json()["messages"]
        assert [(m["role"], m["text"]) for m in messages][0] == ("user", "я тут") and len(messages) == 2
    # остановка приложения: фоновая выгрузка снята без ошибок, а диалог на диске


def test_memory_metrics_are_counted_and_carry_no_texts(tmp_path: Path) -> None:
    path = tmp_path / "dialogs.sqlite3"
    user = str(uuid.uuid4())
    with app_client(path) as client:
        store: DialogStore = client.app.state.store  # type: ignore[attr-defined]
        dialog = start_dialog(client, user)
        say(client, user, dialog["dialogId"], "очень личное признание", "c-1")
        client.portal.call(store.flush)
        assert client.portal.call(store.evict_idle, time.monotonic()) == 0  # срок не вышел: только размеры памяти
        sizes = ("agent_dialog_users_in_memory", "agent_dialog_dialogs_in_memory", "agent_dialog_messages_in_memory")
        assert [sample(name) for name in sizes] == [1, 1, 2]

        evictions = sample("agent_dialog_evictions_total")
        assert client.portal.call(store.evict_idle, later()) == 1
        assert sample("agent_dialog_evictions_total") == evictions + 1
        assert [sample(name) for name in sizes] == [0, 0, 0]

        reloads, timed = sample("agent_dialog_loads_total", kind="reload"), sample("agent_dialog_load_seconds_count")
        assert client.get(dialog_url(user, dialog["dialogId"]), headers=AUTH).status_code == 200
        assert sample("agent_dialog_loads_total", kind="reload") == reloads + 1
        assert sample("agent_dialog_load_seconds_count") == timed + 1

        metrics = client.get("/metrics").text
        assert "очень личное" not in metrics and user not in metrics and dialog["dialogId"] not in metrics
        labels = set(re.findall(r"^agent_dialog_(?:evictions|loads)\w*\{(.*)\}", metrics, re.M))
        assert labels and labels <= {'reason="socket"', 'reason="dirty"', 'kind="first"', 'kind="reload"'}
        assert not re.search(r"^agent_dialog_(?:\w+_in_memory|evictions_total|load_seconds_(?:count|sum))\{", metrics, re.M)


# ─── Стык с памятью (разговор «Без памяти», кэш сводки, удаление и загрузка) ───────────────────────────────────────────


class SpyMemory:
    """Что хранилище говорит памяти о загрузке и выгрузке человека."""

    def __init__(self) -> None:
        self.loaded: list[str] = []
        self.unloaded: list[str] = []

    def brief(self, dialog: Any, count: bool = True) -> str:
        return ""

    def enabled(self, user_id: str) -> bool:
        return False

    async def user_loaded(self, user_id: str) -> None:
        self.loaded.append(user_id)

    def user_unloaded(self, user_id: str) -> None:
        self.unloaded.append(user_id)

    def dialog_ended(self, dialog: Any) -> None:
        return None


async def test_memory_is_told_when_a_person_is_unloaded_and_loaded_again(tmp_path: Path) -> None:
    store, _ = await make_store(tmp_path / "d.sqlite3")
    spy = SpyMemory()
    store.memory = spy  # type: ignore[assignment]
    user = str(uuid.uuid4())
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female")
    store.add_message(dialog, "user", "Привет")
    await store.flush()
    assert store.evict_idle(later()) == 1
    assert spy.unloaded == [user]  # кэш сводки человека сброшен вместе с выгрузкой
    await store.ensure_user(user)
    assert spy.loaded == [user, user]  # а при возвращении собирается заново
    await store.detach()


async def test_a_person_with_a_memory_off_dialog_stays_in_memory(tmp_path: Path) -> None:
    store, _ = await make_store(tmp_path / "d.sqlite3")
    user = str(uuid.uuid4())
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", memory_mode="off")
    store.add_message(dialog, "user", "Без памяти")
    await store.flush()
    before = sample("agent_dialog_evictions_skipped_total", reason="memory_off")
    assert store.evict_idle(later()) == 0  # срок удаления такого разговора живёт только в памяти (socket_closed_at)
    assert sample("agent_dialog_evictions_skipped_total", reason="memory_off") == before + 1
    assert in_memory(store, user)
    await store.detach()


async def test_deleting_a_dialog_waits_for_a_load_of_the_same_person_in_flight(tmp_path: Path) -> None:
    store, _ = await make_store(tmp_path / "d.sqlite3")
    user = str(uuid.uuid4())
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female")
    store.add_message(dialog, "user", "Привет")
    await store.flush()
    assert store.evict_idle(later()) == 1
    async with store._load_lock:  # идёт загрузка этого человека: удаление не должно проскочить мимо неё
        deleting = asyncio.create_task(store.delete_dialog(user, dialog.id, False))
        await asyncio.sleep(0.05)
        assert not deleting.done()
    await deleting
    await store.ensure_user(user)
    assert store.get(user, dialog.id) is None  # удалённый диалог не вернулся в память
    await store.detach()
