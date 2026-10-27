"""Полный круг `PostgresDialogDatabase` против живого PostgreSQL.

Запуск: TEST_PG_DSN="postgresql://postgres:postgres@localhost:55432/postgres" pytest tests/integration
Без TEST_PG_DSN тесты пропускаются. Тесты работают со своими таблицами диалогов: перед и после прогона
схема удаляется (DROP TABLE), поэтому DSN должен указывать на тестовую базу, а не на боевую.
"""

import os
import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from app.services.dialog_db import DialogDatabase as PostgresDialogDatabase
from app.services.dialog_db import PurgeStats, encode_summary, iso_utc

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


# ─── физическая очистка мягко стёртого (PROTEUS-255) ──────────────────────────────────────────────────────────────


def _age_marks(db: PostgresDialogDatabase, hours: float) -> None:
    """Сделать все пометки `deleted_at` старше на `hours` часов, как будто они поставлены давно."""
    at = iso_utc(datetime.now(UTC) - timedelta(hours=hours))
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        conn.execute("UPDATE dialogs SET deleted_at = %s WHERE deleted_at IS NOT NULL", (at,))
        conn.execute("UPDATE voice_prefs SET deleted_at = %s WHERE deleted_at IS NOT NULL", (at,))


def _count(db: PostgresDialogDatabase, table: str, where: str = "TRUE") -> int:
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        return conn.execute(f"SELECT count(*) FROM {table} WHERE {where}").fetchone()[0]


def _cutoff(minutes_ago: float = 60) -> str:
    return iso_utc(datetime.now(UTC) - timedelta(minutes=minutes_ago))


def test_model_usage_survives_the_dialog_after_migration_from_the_cascading_schema(db: PostgresDialogDatabase) -> None:
    """База, созданная прежним DDL (dialog_id NOT NULL, внешний ключ с каскадом), при открытии теряет и то и другое:
    физическое удаление диалога больше не уносит расход."""
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        conn.execute("ALTER TABLE model_usage ALTER COLUMN dialog_id SET NOT NULL")
        conn.execute(
            "ALTER TABLE model_usage ADD CONSTRAINT model_usage_dialog_id_fkey FOREIGN KEY (dialog_id) "
            "REFERENCES dialogs (id) ON DELETE CASCADE"
        )
    db.apply([_write("d1", "u1")])
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM dialogs WHERE id = 'd1'")
    assert _count(db, "model_usage") == 0  # исходная посылка: старая схема каскадом убирала расход

    for _ in range(2):  # открытие идемпотентно
        migrated = PostgresDialogDatabase(db.dsn)
        migrated.open()
        migrated.close()
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        nullable = conn.execute(
            "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'model_usage' AND column_name = 'dialog_id'"
        ).fetchone()[0]
        foreign_keys = conn.execute(
            "SELECT count(*) FROM pg_constraint WHERE conrelid = 'model_usage'::regclass AND contype = 'f'"
        ).fetchone()[0]
    assert (nullable, foreign_keys) == ("YES", 0)
    db.apply([_write("d1", "u1")])
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM dialogs WHERE id = 'd1'")
    assert _count(db, "model_usage") == 1


def test_purge_removes_marked_rows_anonymizes_usage_and_leaves_others(db: PostgresDialogDatabase) -> None:
    db.apply([_write("d1", "u1"), _write("d2", "u2")])
    db.erase_user("u1")
    db.add_note_source("u1", "n1", "d1", "hash", "2026-10-24T10:00:00.000Z")  # запоздалая запись извлекателя заметок
    _age_marks(db, 3)
    assert db.marked_counts(_cutoff(120)) == (1, 1)

    stats = db.purge_dialogs(_cutoff(), 500)
    prefs = db.purge_voice_prefs(_cutoff(), 500)

    assert stats == PurgeStats(dialogs=1, messages=1, client_ids=1, memory_sources=1, voice_prefs=0, usage_anonymized=1)
    assert prefs == 1 and db.marked_counts(_cutoff(120)) == (0, 0)
    assert db.counts() == (1, 1)
    assert [d.id for d in db.load_user("u2")[0]] == ["d2"] and db.load_user("u2")[1] == "male"
    assert (_count(db, "client_ids"), _count(db, "voice_prefs"), _count(db, "memory_sources")) == (1, 1, 0)
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        rows = conn.execute(
            "SELECT dialog_id, message_id, created_at, model, task, direction, modality, unit, amount FROM model_usage "
            "ORDER BY dialog_id NULLS FIRST"
        ).fetchall()
    assert rows == [
        (None, None, "2026-10-24T10:00:02+00:00", "chat", "reply", "out", "text", "tokens", 42.0),
        ("d2", "m1", "2026-10-24T10:00:02+00:00", "chat", "reply", "out", "text", "tokens", 42.0),
    ]
    assert db.purge_dialogs(_cutoff(), 500) == PurgeStats() and db.purge_voice_prefs(_cutoff(), 500) == 0  # повтор ничего не делает


def test_purge_ignores_fresh_marks_and_unmarked_rows(db: PostgresDialogDatabase) -> None:
    db.apply([_write("d1", "u1"), _write("d2", "u2")])
    db.erase_user("u1")  # пометка только что
    assert db.purge_dialogs(_cutoff(), 500) == PurgeStats() and db.purge_voice_prefs(_cutoff(), 500) == 0
    assert db.counts() == (2, 2) and _count(db, "voice_prefs") == 2
    db.delete_dialog("u2", "d2", forget_derived=False)
    _age_marks(db, 0.5)  # полчаса: ещё не час
    assert db.purge_dialogs(_cutoff(), 500) == PurgeStats()
    assert db.marked_counts(_cutoff(120)) == (0, 0)
    assert db.marked_counts(_cutoff(10)) == (2, 1)


def test_purge_takes_at_most_limit_dialogs_oldest_first(db: PostgresDialogDatabase) -> None:
    db.apply([_write(f"d{i}", f"u{i}") for i in range(5)])
    for i in range(5):
        db.erase_user(f"u{i}")
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        for i in range(5):  # d0 самый старый
            at = iso_utc(datetime.now(UTC) - timedelta(hours=10 - i))
            conn.execute("UPDATE dialogs SET deleted_at = %s WHERE id = %s", (at, f"d{i}"))
            conn.execute("UPDATE voice_prefs SET deleted_at = %s WHERE user_id = %s", (at, f"u{i}"))
    first = db.purge_dialogs(_cutoff(), 2)
    with psycopg.connect(db.dsn, autocommit=True) as conn:
        left = {row[0] for row in conn.execute("SELECT id FROM dialogs").fetchall()}
    assert first.dialogs == 2 and left == {"d2", "d3", "d4"}  # ушли два самых старых
    assert [db.purge_dialogs(_cutoff(), 2).dialogs for _ in range(3)] == [2, 1, 0]
    assert [db.purge_voice_prefs(_cutoff(), 2) for _ in range(4)] == [2, 2, 1, 0]
    assert db.counts() == (0, 0) and _count(db, "model_usage") == 5 and _count(db, "model_usage", "dialog_id IS NOT NULL") == 0


def test_two_executors_split_the_backlog_without_double_counting_and_do_not_block_the_writer(db: PostgresDialogDatabase) -> None:
    """Две реплики очищают одно и то же: пачки не пересекаются (SKIP LOCKED), каждая строка считается один раз, а писатель живых
    людей в это время не упирается в очистку."""
    total = 400
    at = iso_utc(datetime.now(UTC) - timedelta(hours=3))
    day = "2026-10-24T10:00:00+00:00"
    with psycopg.connect(db.dsn, autocommit=True) as conn:  # готовое стёртое одним набором запросов, а не через писателя
        conn.execute(
            "INSERT INTO dialogs (id, user_id, started_at, voice, deleted_at) "
            "SELECT 'd' || g, 'u' || g, %s, 'male', %s FROM generate_series(1, %s) g",
            (day, at, total),
        )
        conn.execute(
            "INSERT INTO messages (id, dialog_id, position, role, text, created_at) "
            "SELECT 'm' || p, 'd' || g, p, 'user', 'x', %s FROM generate_series(1, %s) g, generate_series(1, 2) p",
            (day, total),
        )
        conn.execute("INSERT INTO client_ids SELECT 'd' || g, 'c1', 'm1' FROM generate_series(1, %s) g", (total,))
        conn.execute(
            "INSERT INTO model_usage (dialog_id, message_id, created_at, model, task, direction, modality, unit, amount) "
            "SELECT 'd' || g, 'm1', %s, 'chat', 'reply', 'out', 'text', 'tokens', 42 FROM generate_series(1, %s) g",
            (day, total),
        )
    other = PostgresDialogDatabase(db.dsn)
    other.open()
    cutoff = _cutoff()
    results: list[PurgeStats] = []
    failures: list[BaseException] = []
    purging = threading.Barrier(3)
    finished = threading.Event()
    written: list[str] = []

    def purge(executor: PostgresDialogDatabase) -> None:
        try:
            purging.wait(10)
            while True:
                stats = executor.purge_dialogs(cutoff, 7)
                results.append(stats)
                if stats.dialogs == 0:
                    return
        except BaseException as error:  # noqa: BLE001
            failures.append(error)

    def write_alive() -> None:
        try:
            purging.wait(10)
            while not finished.is_set() or not written:  # пишет всё время, пока идёт очистка
                dialog_id = f"live{len(written)}"
                db.apply([_write(dialog_id, "alive")])
                written.append(dialog_id)
        except BaseException as error:  # noqa: BLE001
            failures.append(error)

    purgers = [threading.Thread(target=purge, args=(executor,)) for executor in (db, other)]
    writer = threading.Thread(target=write_alive)
    for thread in (*purgers, writer):
        thread.start()
    for thread in purgers:
        thread.join(60)
    finished.set()
    writer.join(60)
    other.close()

    assert not failures and not any(thread.is_alive() for thread in (*purgers, writer))
    assert sum(stats.dialogs for stats in results) == total
    assert sum(stats.messages for stats in results) == 2 * total and sum(stats.client_ids for stats in results) == total
    assert sum(stats.usage_anonymized for stats in results) == total
    assert _count(db, "dialogs", "deleted_at IS NOT NULL") == 0 and _count(db, "dialogs") == len(written)  # живые на месте
    assert _count(db, "model_usage", "dialog_id IS NULL") == total


def test_purged_person_can_choose_a_voice_again(db: PostgresDialogDatabase) -> None:
    """Пока пометка жива, запись голоса стёртого игнорируется; после очистки строка заводится заново."""
    db.apply([_write("d1", "u1")])
    db.erase_user("u1")
    again = _write("d2", "u1")
    again.pref = ("u1", "female")
    db.apply([again])
    assert db.load_user("u1")[1] is None  # пометка держит
    _age_marks(db, 3)
    db.purge_dialogs(_cutoff(), 500)
    db.purge_voice_prefs(_cutoff(), 500)
    db.apply([again])
    assert db.load_user("u1")[1] == "female"
