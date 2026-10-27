"""Полный круг `PostgresDialogDatabase` против живого PostgreSQL.

Запуск: TEST_PG_DSN="postgresql://postgres:postgres@localhost:55432/postgres" pytest tests/integration
Без TEST_PG_DSN тесты пропускаются. Тесты работают со своими таблицами диалогов: перед и после прогона
схема удаляется (DROP TABLE), поэтому DSN должен указывать на тестовую базу, а не на боевую.
"""

import os
from collections.abc import Iterator

import psycopg
import pytest

from app.services.dialog_db import DialogDatabase as PostgresDialogDatabase
from app.services.dialog_db import encode_summary

TABLES = (
    "model_usage",
    "client_ids",
    "messages",
    "voice_prefs",
    "dialog_settings",
    "memory_settings",
    "memory_notes",
    "memory_outbox",
    "memory_sources",
    "memory_deletions",
    "dialogs",
)


def _write(dialog_id: str, user_id: str, text: str = "привет") -> "object":
    from app.services.dialog_db import DialogWrite

    return DialogWrite(
        dialog_id=dialog_id,
        row=(dialog_id, user_id, "2026-10-24T10:00:00+00:00", None, encode_summary({"a": 1}), None, "male", 0, "on", 0),
        messages=[("m1", dialog_id, 0, "user", text, "2026-10-24T10:00:01+00:00", 1.5)],
        client_ids=[(dialog_id, "c1", "m1")],
        pref=(user_id, "male"),
        usage=[(dialog_id, "m1", "2026-10-24T10:00:02+00:00", "chat", "reply", "out", "text", "tokens", 42.0)],
    )


@pytest.fixture()
def db() -> Iterator[PostgresDialogDatabase]:
    dsn = os.environ.get("TEST_PG_DSN")
    if not dsn:
        pytest.skip("TEST_PG_DSN не задан (живой PostgreSQL)")
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    database = PostgresDialogDatabase(dsn)
    database.open()
    yield database
    database.close()
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")


def test_schema_created_on_open(db: PostgresDialogDatabase) -> None:
    assert db.counts() == (0, 0)


def test_apply_and_load_user_roundtrip(db: PostgresDialogDatabase) -> None:
    db.apply([_write("d1", "u1")])
    db.apply([_write("d2", "u1", "как дела?"), _write("d3", "u2")])
    assert db.counts() == (3, 3)

    dialogs, pref = db.load_user("u1")
    assert pref == "male"
    assert [d.id for d in dialogs] == ["d1", "d2"]
    assert dialogs[0].summary == {"a": 1}
    assert dialogs[0].messages == [("m1", "user", "привет", "2026-10-24T10:00:01+00:00", 1.5)]
    assert dialogs[0].client_ids == {"c1": "m1"}


def test_apply_upsert_keeps_crisis_seen_and_extracted_at(db: PostgresDialogDatabase) -> None:
    db.apply([_write("d1", "u1")])
    seen = _write("d1", "u1")
    seen.row = (*seen.row[:9], 1)  # crisis_seen=1
    db.apply([seen])
    db.apply([_write("d1", "u1")])  # повторная запись не должна сбросить crisis_seen
    dialogs, _ = db.load_user("u1")
    assert dialogs[0].crisis_seen is True


def test_apply_is_idempotent(db: PostgresDialogDatabase) -> None:
    db.apply([_write("d1", "u1")])
    db.apply([_write("d1", "u1")])  # повтор пачки: client_ids INSERT ... ON CONFLICT DO NOTHING
    assert db.counts() == (1, 1)


def test_delete_dialog_is_soft_and_hidden_from_reads(db: PostgresDialogDatabase) -> None:
    db.apply([_write("d1", "u1"), _write("d2", "u1")])
    db.delete_dialog("u1", "d1", forget_derived=True)
    dialogs, pref = db.load_user("u1")
    assert [d.id for d in dialogs] == ["d2"]
    assert pref == "male"
    assert db.counts() == (2, 2)  # мягко: строки с пометкой ждут физической очистки
    db.apply([_write("d1", "u1")])  # отложенная запись удалённый разговор не воскрешает
    assert [d.id for d in db.load_user("u1")[0]] == ["d2"]


def test_erase_user_is_soft_and_keeps_others(db: PostgresDialogDatabase) -> None:
    db.apply([_write("d1", "u1"), _write("d2", "u2")])
    db.outbox_add("u1", "index_dialog", {"dialog_id": "d1"}, "2026-10-24T10:00:00.000Z", "2026-10-24T10:00:00.000Z")
    db.erase_user("u1")
    assert db.load_user("u1") == ([], None)
    dialogs, _ = db.load_user("u2")
    assert [d.id for d in dialogs] == ["d2"]
    assert db.counts() == (2, 2)  # мягко
    assert db.outbox_pending() == 0  # очередь человека стёрта вместе с ним
    db.erase_user("u1")  # идемпотентно


def test_closed_connection_is_replaced_without_reopen(db: PostgresDialogDatabase) -> None:
    """Разорванное PostgreSQL соединение заменяется новым при следующей операции."""
    db.apply([_write("d1", "u1")])
    with db._connection() as conn:
        old_pid = conn.execute("SELECT pg_backend_pid()").fetchone()[0]
    with psycopg.connect(db.dsn, autocommit=True) as terminator:
        assert terminator.execute("SELECT pg_terminate_backend(%s)", (old_pid,)).fetchone()[0] is True

    assert db.counts() == (1, 1)
    assert db.load_user("u1")[0][0].id == "d1"
    with db._connection() as conn:
        new_pid = conn.execute("SELECT pg_backend_pid()").fetchone()[0]
    assert new_pid != old_pid


def test_ddl_is_idempotent(db: PostgresDialogDatabase) -> None:
    db.apply([_write("d1", "u1")])
    other = PostgresDialogDatabase(db.dsn)
    other.open()  # повторный CREATE TABLE IF NOT EXISTS на той же схеме
    other.close()
    assert db.counts() == (1, 1)


def test_memory_settings_roundtrip_and_erase(db: PostgresDialogDatabase) -> None:
    """Настройки памяти: нет строки — None; запись заменяет; схема создаётся повторно без ошибок; стирание человека их убирает."""
    assert db.get_memory_settings("u1") is None
    db.put_memory_settings("u1", True, "2026-10-21", "2026-10-24T10:00:00+00:00", "2026-10-24T10:00:00+00:00")
    assert db.get_memory_settings("u1") == (True, "2026-10-21", "2026-10-24T10:00:00+00:00")
    db.put_memory_settings("u1", False, "2026-10-21", "2026-10-24T10:00:00+00:00", "2026-10-25T10:00:00+00:00")
    assert db.get_memory_settings("u1") == (False, "2026-10-21", "2026-10-24T10:00:00+00:00")
    db.open()  # повторное открытие: идемпотентный DDL
    assert db.get_memory_settings("u1") is not None
    db.erase_user("u1")
    assert db.get_memory_settings("u1") is None


def test_notes_crud_search_index_and_cascade_of_erase(db: PostgresDialogDatabase) -> None:
    """Заметки: запись, список по давности и видам, правка, удаление; полнотекстовый индекс на месте; стирание человека убирает их."""
    import uuid

    def note(user: str, kind: str, text: str, at: str, sensitive: bool = False) -> tuple:
        return (str(uuid.uuid4()), user, kind, text, sensitive, None, None, at, at)

    first = note("u1", "situation", "Работает в продажах", "2026-10-24T10:00:00+00:00")
    second = note("u1", "wellbeing", "Последние недели плохо спит", "2026-10-25T10:00:00+00:00", sensitive=True)
    other = note("u2", "name", "Зовут Алекс", "2026-10-25T10:00:00+00:00")
    for item in (first, second, other):
        db.add_note(item)
    assert db.count_notes("u1") == 2
    assert [row[2] for row in db.list_notes("u1")] == ["Последние недели плохо спит", "Работает в продажах"]

    assert db.update_note("u1", first[0], "Работает в продажах уже год", "2026-10-26T10:00:00+00:00")
    assert not db.update_note("u2", first[0], "чужая", "2026-10-26T10:00:00+00:00")  # чужая заметка не правится
    assert db.delete_notes("u1", only_sensitive=True) == 1  # выключили «чувствительное»
    assert db.delete_note("u1", first[0]) and not db.delete_note("u1", first[0])
    db.add_note(note("u1", "style", "Говорит на ты", "2026-10-26T10:00:00+00:00"))
    db.erase_user("u1")
    assert db.count_notes("u1") == 0 and db.count_notes("u2") == 1
    db.open()  # повторное открытие: DDL идемпотентен и для новых таблиц


def test_soft_deleted_dialogs_are_neither_indexed_nor_expired(db: PostgresDialogDatabase) -> None:
    """Индекс прошлых разговоров и срок хранения не видят мягко удалённый разговор."""
    ended = _write("d1", "u1")
    ended.row = (*ended.row[:3], "2026-10-24T10:30:00+00:00", *ended.row[4:])
    db.apply([ended, _write("d2", "u1")])
    assert db.dialog_for_index("d1") is not None and db.indexable_dialog_ids("u1") == ["d1"]
    assert {row[1] for row in db.expired_dialogs("2027-01-01T00:00:00.000Z")} == {"d1", "d2"}
    db.delete_dialog("u1", "d1", forget_derived=False)
    assert db.dialog_for_index("d1") is None and db.indexable_dialog_ids("u1") == []
    assert {row[1] for row in db.expired_dialogs("2027-01-01T00:00:00.000Z")} == {"d2"}


def test_memory_deletion_marks_of_0_8_8_move_to_the_outbox_once(db: PostgresDialogDatabase) -> None:
    """Метки `memory_deletions` агента 0.8.8 при открытии базы уходят в очередь (`delete_dataset`), а память этих людей
    записывается выключенной, не трогая уже сохранённое решение. Повторное открытие ничего не добавляет."""
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        conn.execute("CREATE TABLE memory_deletions (user_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)")
        conn.execute(
            "INSERT INTO memory_deletions VALUES ('forgot', '2026-10-25T10:00:00.000Z'), ('kept', '2026-10-26T10:00:00.000Z')"
        )
    db.put_memory_settings("kept", True, "2026-10-21", "2026-10-26T11:00:00.000Z", "2026-10-26T11:00:00.000Z")
    for _ in range(2):
        again = PostgresDialogDatabase(db.dsn)
        again.open()
        again.close()
    due = db.outbox_due("2100-01-01T00:00:00.000Z")
    assert sorted((row[1], row[2]) for row in due) == [("forgot", "delete_dataset"), ("kept", "delete_dataset")]
    assert db.get_memory_settings("forgot") == (False, None, None)
    assert db.get_memory_settings("kept") == (True, "2026-10-21", "2026-10-26T11:00:00.000Z")
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        assert conn.execute("SELECT count(*) FROM memory_deletions").fetchone()[0] == 0
