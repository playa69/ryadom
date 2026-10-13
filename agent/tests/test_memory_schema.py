"""Схема v2 и миграция v1 → v2 (спецификация памяти, MEM-5): данные целы, прерванная миграция оставляет v1, v3 отвергается."""

import sqlite3
import uuid
from pathlib import Path

import pytest

from app.services import dialog_db
from app.services.dialog_db import SCHEMA_V1, SCHEMA_VERSION, DialogDatabase, DialogDbError, DialogWrite

MEMORY_TABLES = {"memory_settings", "memory_facts", "memory_fact_sources", "memory_tombstones", "memory_events", "memory_jobs"}


def make_v1(path: Path) -> str:
    """Файл, каким его оставил агент со схемой 1: диалог с сообщениями, идентификатор клиента, выбор голоса."""
    user = str(uuid.uuid4())
    with sqlite3.connect(path) as raw:
        for statement in SCHEMA_V1:
            raw.execute(statement)
        raw.execute(
            "INSERT INTO dialogs (id, user_id, started_at, ended_at, summary, greeting, voice, reply_index) "
            "VALUES ('d1', ?, '2026-10-01T10:00:00.000Z', '2026-10-01T10:30:00.000Z', '{\"title\": \"Работа\"}', 'Привет', "
            "'female', 3)",
            (user,),
        )
        raw.executemany(
            "INSERT INTO messages (id, dialog_id, position, role, text, created_at) VALUES (?, 'd1', ?, ?, ?, ?)",
            [
                ("m1", 0, "user", "Мне тревожно перед собеседованием", "2026-10-01T10:00:01.000Z"),
                ("m2", 1, "assistant", "Я рядом.", "2026-10-01T10:00:02.000Z"),
            ],
        )
        raw.execute("INSERT INTO client_ids (dialog_id, client_id, message_id) VALUES ('d1', 'c-1', 'm1')")
        raw.execute("INSERT INTO voice_prefs (user_id, voice) VALUES (?, 'female')", (user,))
        raw.execute("PRAGMA user_version = 1")
    return user


def tables(path: Path) -> set[str]:
    with sqlite3.connect(path) as raw:
        return {row[0] for row in raw.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def columns(path: Path, table: str) -> set[str]:
    with sqlite3.connect(path) as raw:
        return {row[1] for row in raw.execute(f"PRAGMA table_info({table})")}


def version(path: Path) -> int:
    with sqlite3.connect(path) as raw:
        return raw.execute("PRAGMA user_version").fetchone()[0]


def test_empty_file_is_created_at_v2(tmp_path: Path) -> None:
    path = tmp_path / "fresh.sqlite3"
    db = DialogDatabase(str(path))
    db.open()
    db.close()
    assert SCHEMA_VERSION == 2 and version(path) == 2
    assert MEMORY_TABLES <= tables(path)
    assert {"memory_mode", "crisis_seen", "memory_extracted_at"} <= columns(path, "dialogs")


def test_v1_file_migrates_and_keeps_every_dialog_and_message(tmp_path: Path) -> None:
    path = tmp_path / "v1.sqlite3"
    user = make_v1(path)
    db = DialogDatabase(str(path))
    db.open()
    dialogs, pref = db.load_user(user)
    db.close()
    assert version(path) == 2 and MEMORY_TABLES <= tables(path)
    assert pref == "female" and len(dialogs) == 1
    loaded = dialogs[0]
    assert (loaded.summary, loaded.greeting, loaded.voice, loaded.reply_index) == ({"title": "Работа"}, "Привет", "female", 3)
    assert [m[2] for m in loaded.messages] == ["Мне тревожно перед собеседованием", "Я рядом."]
    assert loaded.client_ids == {"c-1": "m1"}
    # Старые диалоги — с памятью по умолчанию, без кризиса и без извлечения.
    assert (loaded.memory_mode, loaded.crisis_seen, loaded.memory_extracted_at) == ("on", False, None)


def test_reopening_v2_changes_nothing(tmp_path: Path) -> None:
    path = tmp_path / "again.sqlite3"
    user = make_v1(path)
    for _ in range(2):
        db = DialogDatabase(str(path))
        db.open()
        db.close()
    db = DialogDatabase(str(path))
    db.open()
    assert len(db.load_user(user)[0]) == 1
    db.close()


def test_interrupted_migration_leaves_a_working_v1_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "broken.sqlite3"
    user = make_v1(path)
    good = dialog_db.MIGRATIONS[2]
    monkeypatch.setitem(dialog_db.MIGRATIONS, 2, (good[0], "THIS IS NOT SQL", *good[1:]))
    with pytest.raises(DialogDbError):
        DialogDatabase(str(path)).open()
    assert version(path) == 1
    assert "memory_mode" not in columns(path, "dialogs") and not (MEMORY_TABLES & tables(path))
    with sqlite3.connect(path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2  # данные на месте
    monkeypatch.setitem(dialog_db.MIGRATIONS, 2, good)
    db = DialogDatabase(str(path))
    db.open()  # следующий старт с исправной миграцией доводит файл до v2
    assert version(path) == 2 and len(db.load_user(user)[0]) == 1
    db.close()


def test_file_from_a_newer_agent_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "v3.sqlite3"
    with sqlite3.connect(path) as raw:
        raw.execute("PRAGMA user_version = 3")
    with pytest.raises(DialogDbError, match="новее"):
        DialogDatabase(str(path)).open()


def test_indexes_exist(tmp_path: Path) -> None:
    path = tmp_path / "idx.sqlite3"
    db = DialogDatabase(str(path))
    db.open()
    db.close()
    with sqlite3.connect(path) as raw:
        names = {row[0] for row in raw.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert {
        "memory_facts_user_status",
        "memory_facts_purge",
        "memory_fact_sources_dialog",
        "memory_events_user_at",
        "memory_events_dialog",
        "memory_jobs_due",
    } <= names


FACT = (
    "INSERT INTO memory_facts (id, user_id, category, text, importance, confidence, status, origin, norm_hash, created_at, "
    "updated_at) VALUES (?, 'u', ?, 'текст факта', ?, 0.9, ?, 'auto', 'h', 't', 't')"
)


@pytest.mark.parametrize(
    ("statement", "values"),
    [
        (FACT, ("f1", "trait", 3, "active")),  # категории «черты личности» нет (B5)
        (FACT, ("f2", "person", 6, "active")),  # важность 1..5
        (FACT, ("f3", "person", 3, "rejected")),  # отказ — удаление и надгробие, а не статус
        ("INSERT INTO memory_events (user_id, op, actor, at) VALUES ('u', 'purge', 'system', 't')", ()),
        ("INSERT INTO memory_jobs (dialog_id, user_id, status, run_after, created_at) VALUES ('d', 'u', 'later', 't', 't')", ()),
        ("INSERT INTO memory_settings (user_id, enabled, updated_at) VALUES ('u', 2, 't')", ()),
        (
            "INSERT INTO dialogs (id, user_id, started_at, voice, memory_mode) VALUES ('d', 'u', 't', 'male', 'maybe')",
            (),
        ),
    ],
)
def test_check_constraints(tmp_path: Path, statement: str, values: tuple[object, ...]) -> None:
    db = DialogDatabase(str(tmp_path / "check.sqlite3"))
    db.open()
    with pytest.raises(sqlite3.IntegrityError):
        db.run(lambda conn: conn.execute(statement, values))
    db.close()


def row(dialog_id: str, user: str, memory_mode: str = "on", crisis: int = 0) -> tuple[object, ...]:
    return (dialog_id, user, "2026-10-12T10:00:00.000Z", None, None, None, "male", 0, memory_mode, crisis)


def test_writer_keeps_memory_mode_crisis_and_the_workers_mark(tmp_path: Path) -> None:
    """memory_mode неизменяем, crisis_seen только растёт, memory_extracted_at пишет только воркер (MEM-5.3)."""
    db = DialogDatabase(str(tmp_path / "w.sqlite3"))
    db.open()
    db.apply([DialogWrite(dialog_id="d1", row=row("d1", "u", "off", 1))])
    db.run(lambda conn: conn.execute("UPDATE dialogs SET memory_extracted_at = 'X' WHERE id = 'd1'"))
    db.apply([DialogWrite(dialog_id="d1", row=row("d1", "u", "on", 0))])  # писатель диалогов снова пишет строку
    stored = db.load_user("u")[0][0]
    assert (stored.memory_mode, stored.crisis_seen, stored.memory_extracted_at) == ("off", True, "X")
    db.close()
