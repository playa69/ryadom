"""Физическая очистка мягко стёртого (PROTEUS-255): через час после пометки данные стёртых людей и разговоров уходят из базы,
расход моделей обезличивается, свежие пометки и чужие данные не трогаются, повторный проход ничего не делает.

База — двойник `tests/fake_db.py` (настоящий PostgreSQL покрыт `tests/integration/test_dialog_db_pg.py`). «Прошёл час» —
это параметр `now` прохода: часы тестов не крутятся.
"""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app import main as app_main
from app.services import dialog_purge
from app.services.dialog_db import DialogWrite, PurgeStats, iso_utc
from app.services.dialog_purge import purge_loop, purge_pass
from app.services.dialog_store import DialogStore
from app.services.usage import Usage
from tests.conftest import make_app
from tests.fake_db import FakeDialogDatabase as DialogDatabase

HOUR_AND_A_BIT = timedelta(minutes=61)


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def deleted(table: str) -> float:
    return sample("agent_dialog_purge_deleted_rows_total", table=table)


def write(dialog_id: str, user_id: str) -> DialogWrite:
    """Диалог с двумя сообщениями, идентификатором клиента, выбором голоса и двумя строками расхода (на сообщение и на диалог)."""
    return DialogWrite(
        dialog_id=dialog_id,
        row=(dialog_id, user_id, "2026-10-12T10:00:00.000Z", None, None, "Привет", "female", 2, "on", 0),
        messages=[
            ("m1", dialog_id, 0, "user", "реплика", "2026-10-12T10:00:01.000Z", 3.2),
            ("m2", dialog_id, 1, "assistant", "ответ", "2026-10-12T10:00:02.000Z", None),
        ],
        client_ids=[(dialog_id, "c-1", "m1")],
        pref=(user_id, "female"),
        usage=[
            (dialog_id, "m2", "2026-10-12T10:00:03.000Z", "gemini", "live", "input", "audio", "tokens", 1000.0),
            (dialog_id, None, "2026-10-12T10:00:04.000Z", "gemini", "phrase", "output", "audio", "tokens", 80.0),
        ],
    )


@pytest.fixture()
def db(tmp_path: Path) -> DialogDatabase:
    database = DialogDatabase(str(tmp_path / "d.db"))
    database.open()
    return database


def later() -> datetime:
    return datetime.now(UTC) + HOUR_AND_A_BIT


async def test_nothing_is_purged_before_the_hour_is_up(db: DialogDatabase) -> None:
    db.apply([write("d1", "u1"), write("d2", "u2")])
    db.erase_user("u1")
    stats = await purge_pass(db, datetime.now(UTC) + timedelta(minutes=59))
    assert stats.total == 0
    assert db.counts() == (2, 4)  # мягко: строки с пометкой лежат, пока не прошёл час


async def test_erased_person_is_gone_after_an_hour_and_usage_is_anonymized(db: DialogDatabase) -> None:
    db.apply([write("d1", "u1"), write("d2", "u2")])
    db.erase_user("u1")
    db.add_note_source("u1", "n1", "d1", "hash", "2026-10-12T10:00:05.000Z")  # запоздалая запись извлекателя заметок
    before = {name: deleted(name) for name in ("dialogs", "messages", "client_ids", "memory_sources", "voice_prefs")}
    anonymized = sample("agent_dialog_purge_usage_anonymized_total")

    stats = await purge_pass(db, later())

    assert (stats.dialogs, stats.messages, stats.client_ids, stats.memory_sources, stats.voice_prefs, stats.usage_anonymized) == (
        1, 2, 1, 1, 1, 2,
    )
    state = db._state()
    assert set(state.dialogs) == {"d2"} and {key[0] for key in state.messages} == {"d2"}
    assert {key[0] for key in state.client_ids} == {"d2"} and state.prefs == {"u2": "female"}
    assert state.sources == [] and state.deleted_dialogs == {} and state.deleted_prefs == {}
    assert db.counts() == (1, 2)
    assert db.load_user("u2")[1] == "female" and len(db.load_user("u2")[0]) == 1  # чужой не тронут
    # Расход не пропал: у строк стёртого нет ни диалога, ни сообщения, остальное на месте.
    assert sorted(state.usage, key=lambda row: (row[0] is not None, row[2])) == [
        (None, None, "2026-10-12T10:00:03.000Z", "gemini", "live", "input", "audio", "tokens", 1000.0),
        (None, None, "2026-10-12T10:00:04.000Z", "gemini", "phrase", "output", "audio", "tokens", 80.0),
        ("d2", "m2", "2026-10-12T10:00:03.000Z", "gemini", "live", "input", "audio", "tokens", 1000.0),
        ("d2", None, "2026-10-12T10:00:04.000Z", "gemini", "phrase", "output", "audio", "tokens", 80.0),
    ]
    assert {name: deleted(name) - before[name] for name in before} == {
        "dialogs": 1, "messages": 2, "client_ids": 1, "memory_sources": 1, "voice_prefs": 1,
    }
    assert sample("agent_dialog_purge_usage_anonymized_total") - anonymized == 2


async def test_second_pass_changes_nothing_and_counts_nothing(db: DialogDatabase) -> None:
    db.apply([write("d1", "u1")])
    db.erase_user("u1")
    assert (await purge_pass(db, later())).dialogs == 1
    snapshot = (list(db._state().usage), db.counts())
    counted = deleted("dialogs"), deleted("messages"), sample("agent_dialog_purge_usage_anonymized_total")

    again = await purge_pass(db, later())

    assert again.total == 0
    assert (list(db._state().usage), db.counts()) == snapshot
    assert (deleted("dialogs"), deleted("messages"), sample("agent_dialog_purge_usage_anonymized_total")) == counted


async def test_deleted_dialog_goes_and_its_siblings_stay(db: DialogDatabase) -> None:
    db.apply([write("d1", "u1"), write("d2", "u1")])
    db.delete_dialog("u1", "d1", forget_derived=False)
    stats = await purge_pass(db, later())
    assert (stats.dialogs, stats.messages, stats.voice_prefs) == (1, 2, 0)  # выбор голоса живого человека остаётся
    assert [d.id for d in db.load_user("u1")[0]] == ["d2"] and db.load_user("u1")[1] == "female"


async def test_fresh_marks_stay_while_old_ones_go(db: DialogDatabase) -> None:
    db.apply([write("old", "u1"), write("fresh", "u2")])
    db.erase_user("u1")
    db._state().deleted_dialogs["old"] = iso_utc(datetime.now(UTC) - timedelta(hours=3))
    db._state().deleted_prefs["u1"] = iso_utc(datetime.now(UTC) - timedelta(hours=3))
    db.erase_user("u2")  # свежая пометка
    stats = await purge_pass(db, datetime.now(UTC) + timedelta(minutes=30))
    assert (stats.dialogs, stats.voice_prefs) == (1, 1)
    assert set(db._state().dialogs) == {"fresh"} and "u2" in db._state().deleted_prefs


async def test_purged_person_can_choose_a_voice_again(db: DialogDatabase) -> None:
    """Пока пометка жива, запись голоса стёртого игнорируется; после очистки та же строка заводится заново."""
    db.apply([write("d1", "u1")])
    db.erase_user("u1")
    db.apply([DialogWrite(dialog_id="d1", row=write("d1", "u1").row, pref=("u1", "male"))])
    assert db._state().prefs == {"u1": "female"} and "u1" in db._state().deleted_prefs
    await purge_pass(db, later())
    db.apply([DialogWrite(dialog_id="d9", row=write("d9", "u1").row, pref=("u1", "male"))])
    assert db.load_user("u1")[1] == "male"


async def test_batches_are_small_and_each_pass_finishes_the_backlog(db: DialogDatabase, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dialog_purge, "PURGE_BATCH", 2)
    monkeypatch.setattr(dialog_purge, "PURGE_BATCH_PAUSE_SECONDS", 0)
    sizes: list[int] = []
    original = db.purge_dialogs

    def spy(cutoff: str, limit: int) -> PurgeStats:
        stats = original(cutoff, limit)
        assert limit == 2
        sizes.append(stats.dialogs)
        return stats

    monkeypatch.setattr(db, "purge_dialogs", spy)
    db.apply([write(f"d{i}", f"u{i}") for i in range(5)])
    for i in range(5):
        db.erase_user(f"u{i}")
    stats = await purge_pass(db, later())
    assert sizes == [2, 2, 1] and stats.dialogs == 5 and stats.voice_prefs == 5 and stats.usage_anonymized == 10
    assert db.counts() == (0, 0)


async def test_failing_step_is_counted_and_does_not_block_the_rest(db: DialogDatabase, monkeypatch: pytest.MonkeyPatch) -> None:
    """Сломались диалоги: выбор голоса всё равно очищается, ошибка видна в счётчике, а gauge показывает, что лежит дольше двух часов."""
    db.apply([write("d1", "u1")])
    db.erase_user("u1")
    old = iso_utc(datetime.now(UTC) - timedelta(hours=3))
    db._state().deleted_dialogs["d1"] = old
    db._state().deleted_prefs["u1"] = old

    def broken(cutoff: str, limit: int) -> PurgeStats:
        raise RuntimeError("база недоступна")

    monkeypatch.setattr(db, "purge_dialogs", broken)
    errors = sample("agent_dialog_db_errors_total", op="purge")

    stats = await purge_pass(db, datetime.now(UTC))

    assert stats.voice_prefs == 1 and stats.dialogs == 0
    assert sample("agent_dialog_db_errors_total", op="purge") - errors == 1
    assert sample("agent_dialog_purge_overdue_rows", table="dialogs") == 1
    assert sample("agent_dialog_purge_overdue_rows", table="voice_prefs") == 0

    monkeypatch.undo()
    await purge_pass(db, datetime.now(UTC))  # база вернулась
    assert sample("agent_dialog_purge_overdue_rows", table="dialogs") == 0 and db.counts() == (0, 0)


async def test_two_executors_never_count_a_row_twice(db: DialogDatabase) -> None:
    """Агент в двух репликах: оба цикла идут по одним и тем же пометкам; каждая строка уходит и считается один раз."""
    db.apply([write(f"d{i}", f"u{i}") for i in range(6)])
    for i in range(6):
        db.erase_user(f"u{i}")
    now = later()
    counted = deleted("dialogs")
    first, second = await asyncio.gather(purge_pass(db, now), purge_pass(db, now))
    assert first.dialogs + second.dialogs == 6 and first.usage_anonymized + second.usage_anonymized == 12
    assert deleted("dialogs") - counted == 6
    assert db.counts() == (0, 0)


# ─── цикл ─────────────────────────────────────────────────────────────────────────────────────────────────────────


async def wait_until(condition: Callable[[], bool], seconds: float = 3.0) -> None:
    async with asyncio.timeout(seconds):
        while not condition():
            await asyncio.sleep(0.01)


async def test_loop_purges_on_its_own_and_survives_a_missing_database(db: DialogDatabase, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dialog_purge, "PURGE_FIRST_DELAY_SECONDS", 0)
    monkeypatch.setattr(dialog_purge, "PURGE_INTERVAL_SECONDS", 0.01)
    db.apply([write("d1", "u1")])
    db.erase_user("u1")
    db._state().deleted_dialogs["d1"] = iso_utc(datetime.now(UTC) - timedelta(hours=2))
    available: list[DialogDatabase | None] = [None]  # сначала базы нет: диалоги только в памяти
    task = asyncio.create_task(purge_loop(lambda: available[0]))
    await asyncio.sleep(0.05)
    assert db.counts() == (1, 2) and not task.done()
    available[0] = db
    await wait_until(lambda: db.counts() == (0, 0))
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled()


async def test_loop_keeps_going_after_a_failed_pass(db: DialogDatabase, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dialog_purge, "PURGE_FIRST_DELAY_SECONDS", 0)
    monkeypatch.setattr(dialog_purge, "PURGE_INTERVAL_SECONDS", 0.01)
    passes: list[int] = []

    async def flaky(database: DialogDatabase, now: datetime) -> PurgeStats:
        passes.append(1)
        if len(passes) == 1:
            raise RuntimeError("сбой прохода")
        return PurgeStats()

    monkeypatch.setattr(dialog_purge, "purge_pass", flaky)
    task = asyncio.create_task(purge_loop(lambda: db))
    await wait_until(lambda: len(passes) >= 3)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


# ─── через хранилище, как в бою ───────────────────────────────────────────────────────────────────────────────────


async def test_store_erase_then_purge_leaves_no_trace_but_the_usage_totals(tmp_path: Path) -> None:
    path = str(tmp_path / "d.db")
    store, db = DialogStore(), DialogDatabase(path)
    await store.attach(db, flush_interval=0.01)
    await store.ensure_user("u1")
    dialog, _, _ = store.start("u1", "female")
    question = store.add_message(dialog, "user", "реплика")
    answer = store.add_message(dialog, "assistant", "ответ")
    dialog.client_ids["c-1"] = question.id
    store.add_usage(dialog, answer.id, [Usage("gemini", "live", "output", "text", "tokens", 40.0)])
    await store.flush()
    assert db.counts() == (1, 2)

    await store.erase_user_durable("u1")
    store.add_message(dialog, "user", "поздняя реплика уходящего сокета")  # стёртое на диск не возвращается
    await store.flush()
    assert db.counts() == (1, 2)  # мягко: лежит с пометкой, чтения не видят
    await purge_pass(db, later())

    assert db.counts() == (0, 0) and db._state().client_ids == {} and db._state().prefs == {}
    assert [(row[0], row[1], row[3], row[8]) for row in db._state().usage] == [(None, None, "gemini", 40.0)]
    await store.flush()
    assert db.counts() == (0, 0)  # очищенное не воскресает от отложенной записи
    await store.detach()


def test_app_starts_the_loop_on_the_opened_database_and_stops_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Приложение запускает цикл очистки на открытой базе и останавливает его при выключении, до закрытия базы."""
    seen: dict[str, object] = {}

    async def spy(get_database: Callable[[], object]) -> None:
        seen["database"] = get_database()
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            seen["cancelled"] = True
            raise

    monkeypatch.setattr(app_main, "purge_loop", spy)
    path = str(tmp_path / "d.db")
    app = make_app(database_factory=lambda: DialogDatabase(path))
    with TestClient(app) as client:
        assert client.get("/health/ready").status_code == 200
        for _ in range(100):
            if "database" in seen:
                break
            client.get("/health")
        assert isinstance(seen["database"], DialogDatabase) and seen["database"].path == path
    assert seen.get("cancelled") is True
