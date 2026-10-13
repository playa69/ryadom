"""Стирание человека вместе с памятью (I8, MEM-13.2): одна транзакция, ни строки после 204, страж «все таблицы с user_id»,
стирание при любом MEMORY_MODE, 503 без диска, повтор без ошибки, следы в WAL."""

import asyncio
import sqlite3
from pathlib import Path

import pytest

from app.memory import store as S
from app.memory.models import Job
from app.services.dialog_db import DialogDatabase
from tests.conftest import AUTH
from tests.memory_support import FOUR, FakeModel, answer, close_env, enable, make_client, make_env, op, run_job, talk, user

MARKER = "Уникальный маркер личного факта"


def user_tables(path: Path) -> list[str]:
    with sqlite3.connect(path) as raw:
        names = [row[0] for row in raw.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        return [name for name in names if any(col[1] == "user_id" for col in raw.execute(f"PRAGMA table_info({name})"))]


def count(path: Path, table: str, user_id: str) -> int:
    with sqlite3.connect(path) as raw:
        return raw.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id = ?", (user_id,)).fetchone()[0]


async def fill(tmp_path: Path) -> tuple[Path, str, str]:
    """Двое людей, у каждого строка в каждой таблице с user_id: диалоги, голос, настройки, факты, источники, надгробия,
    события, задания."""
    path = tmp_path / "e.sqlite3"
    model = FakeModel(*[answer(op(category="interest", text=MARKER, evidence=[0]))] * 2)
    store, _, service = await make_env(path, model)
    people = []
    for _ in range(2):
        u = user()
        await store.ensure_user(u)
        await enable(service, u)
        store.set_voice(store.start(u, "female")[0], "female")
        dialog = store.open_dialog(u)
        assert dialog is not None
        talk(store, dialog, MARKER, *FOUR[1:])
        await run_job(service, dialog)
        fact = await service.add_fact(u, "works", "Помогают вечерние прогулки", None)
        await service.delete_fact(u, fact["id"])  # надгробие
        assert service.db is not None
        await asyncio.to_thread(
            service.db.run,
            lambda conn, u=u: S.save_job(conn, Job(f"other-{u}", u, "queued", None, 0, "t", None, "t", None)),
        )
        people.append(u)
    await close_env(store, service)
    return path, people[0], people[1]


async def test_guard_every_table_with_user_id_is_erased(tmp_path: Path) -> None:
    """Страж: новая таблица с user_id, которую забыли стирать, ломает этот тест."""
    path, victim, bystander = await fill(tmp_path)
    tables = user_tables(path)
    assert {"dialogs", "voice_prefs", "memory_settings", "memory_facts", "memory_jobs"} <= set(tables)
    for table in tables:
        assert count(path, table, victim) > 0, f"{table}: тест не проверяет то, чего нет"
    db = DialogDatabase(str(path))
    db.open()
    db.erase_user(victim)
    db.erase_user(victim)  # идемпотентно
    db.close()
    for table in tables:
        assert count(path, table, victim) == 0, table
        assert count(path, table, bystander) > 0, table  # чужое не тронуто


@pytest.mark.parametrize("mode", ["off", "shadow", "on"])
async def test_erase_through_the_api_in_any_mode(tmp_path: Path, mode: str) -> None:
    path, victim, _ = await fill(tmp_path)
    with make_client(path, FakeModel(), MEMORY_MODE=mode) as client:
        assert client.delete(f"/v1/users/{victim}", headers=AUTH).status_code == 204
        assert client.delete(f"/v1/users/{victim}", headers=AUTH).status_code == 204
        assert client.get(f"/v1/users/{victim}/memory", headers=AUTH).json()["facts"] == []
    for table in user_tables(path):
        assert count(path, table, victim) == 0, table


def test_erase_answers_503_when_the_disk_is_configured_but_broken(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("не каталог", encoding="utf-8")
    with make_client(blocker / "e.sqlite3", FakeModel()) as client:
        u = user()
        assert client.delete(f"/v1/users/{u}", headers=AUTH).status_code == 503
        assert client.delete(f"/v1/users/{u}/memory", headers=AUTH).status_code == 503  # «забыто» неправда без диска
        assert client.get("/health/ready").json()["memory"] == "unavailable"


async def test_erased_fact_text_does_not_stay_in_the_wal(tmp_path: Path) -> None:
    path, victim, _ = await fill(tmp_path)
    db = DialogDatabase(str(path))
    db.open()
    wal = Path(str(path) + "-wal")
    marker = MARKER.encode()
    db.erase_user(victim)
    # второй человек тоже с маркером: стираем и его, тогда маркера в файлах не остаётся совсем (secure_delete + TRUNCATE)
    for row in db.run(lambda conn: conn.execute("SELECT DISTINCT user_id FROM memory_facts").fetchall()):
        db.erase_user(row[0])
    db.close()
    assert marker not in path.read_bytes()
    assert not wal.exists() or marker not in wal.read_bytes()


async def test_forget_all_leaves_no_fact_text_on_disk(tmp_path: Path) -> None:
    path = tmp_path / "f.sqlite3"
    store, _, service = await make_env(path, FakeModel())
    u = user()
    await store.ensure_user(u)
    await enable(service, u)
    await service.add_fact(u, "interest", MARKER, None)
    await service.forget_all(u)
    await close_env(store, service)
    wal = Path(str(path) + "-wal")
    assert MARKER.encode() not in path.read_bytes()
    assert not wal.exists() or MARKER.encode() not in wal.read_bytes()


async def test_erase_drops_the_cached_brief(tmp_path: Path) -> None:
    store, _, service = await make_env(tmp_path / "c.sqlite3", FakeModel())
    u = user()
    await store.ensure_user(u)
    await enable(service, u)
    await service.add_fact(u, "works", "Помогают вечерние прогулки", None)
    await service.drain()
    assert service.cache.text(u)
    await store.erase_user_durable(u)
    assert service.cache.get(u) is None and not service.enabled(u)
    await close_env(store, service)
