"""Диалоги на диске (DIALOG_DB_PATH): после перезапуска и выката агента они возвращаются.

Три уровня: сама база (`DialogDatabase`), хранилище с базой (`DialogStore`) и приложение целиком: «редеплой» — это новое
приложение на том же файле (в k8s файл лежит на PVC и переживает под).
"""

import json
import logging
import sqlite3
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app.main import create_app
from app.services.dialog_db import SCHEMA_VERSION, DialogDatabase, DialogDbError, DialogWrite
from app.services.dialog_store import DialogStore
from tests.conftest import AUTH, read_frames, send_user_message, start_dialog, ws_url


def errors(op: str) -> float:
    return REGISTRY.get_sample_value("agent_dialog_db_errors_total", {"op": op}) or 0.0


# ─── База ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_database_creates_the_schema_and_survives_reopening(tmp_path: Path) -> None:
    path = str(tmp_path / "data" / "dialogs.sqlite3")  # каталога ещё нет: база создаёт его сама
    db = DialogDatabase(path)
    db.open()
    assert db.counts() == (0, 0)
    db.close()

    again = DialogDatabase(path)
    again.open()  # повторное открытие не пересоздаёт схему и не падает
    assert again.counts() == (0, 0)
    again.close()
    with sqlite3.connect(path) as raw:
        assert raw.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION


def test_database_refuses_a_file_written_by_a_newer_agent(tmp_path: Path) -> None:
    path = tmp_path / "newer.sqlite3"
    with sqlite3.connect(path) as raw:
        raw.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
    with pytest.raises(DialogDbError, match="новее"):
        DialogDatabase(str(path)).open()


def test_database_that_cannot_be_opened_raises_a_clear_error(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("не каталог", encoding="utf-8")
    with pytest.raises(DialogDbError):
        DialogDatabase(str(blocker / "dialogs.sqlite3")).open()  # родитель — обычный файл


def test_database_roundtrip_and_erase(tmp_path: Path) -> None:
    db = DialogDatabase(str(tmp_path / "d.sqlite3"))
    db.open()
    user, other = str(uuid.uuid4()), str(uuid.uuid4())
    for owner, dialog_id in ((user, "d1"), (other, "d2")):
        db.apply(
            [
                DialogWrite(
                    dialog_id=dialog_id,
                    row=(dialog_id, owner, "2026-10-12T10:00:00.000Z", None, None, "Привет", "female", 2),
                    messages=[
                        ("m1", dialog_id, 0, "user", "Мне тревожно", "2026-10-12T10:00:01.000Z", 3.2),
                        ("m2", dialog_id, 1, "assistant", "Я рядом.", "2026-10-12T10:00:02.000Z", None),
                    ],
                    client_ids=[(dialog_id, "c-1", "m1")],
                    pref=(owner, "female"),
                    usage=[
                        (dialog_id, "m2", "2026-10-12T10:00:03.000Z", "gemini", "live", "input", "audio", "tokens", 1000.0),
                        (dialog_id, None, "2026-10-12T10:00:03.000Z", "gemini", "phrase", "output", "audio", "tokens", 80.0),
                    ],
                )
            ]
        )
    dialogs, pref = db.load_user(user)
    assert pref == "female" and len(dialogs) == 1
    loaded = dialogs[0]
    assert (loaded.id, loaded.voice, loaded.reply_index, loaded.greeting) == ("d1", "female", 2, "Привет")
    assert [m[2] for m in loaded.messages] == ["Мне тревожно", "Я рядом."]  # порядок сохранён
    assert [m[4] for m in loaded.messages] == [3.2, None]  # секунды речи
    assert loaded.client_ids == {"c-1": "m1"}

    db.erase_user(user)
    db.erase_user(user)  # идемпотентно
    assert db.load_user(user) == ([], None)
    assert len(db.load_user(other)[0]) == 1  # чужой не тронут
    assert db.counts() == (1, 2)
    db.close()
    with sqlite3.connect(tmp_path / "d.sqlite3") as conn:  # расход стёртого ушёл каскадом вместе с диалогом
        assert conn.execute("SELECT dialog_id, COUNT(*) FROM model_usage GROUP BY dialog_id").fetchall() == [("d2", 2)]


# Схема файла, записанного агентом 0.4.0 (версия 1 до учёта расхода): так выглядит файл на PVC в проде.
SCHEMA_0_4_0 = """
CREATE TABLE dialogs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, summary TEXT,
    greeting TEXT, voice TEXT NOT NULL, reply_index INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages (id TEXT NOT NULL, dialog_id TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
    position INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (dialog_id, id));
CREATE TABLE client_ids (dialog_id TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE, client_id TEXT NOT NULL,
    message_id TEXT NOT NULL, PRIMARY KEY (dialog_id, client_id));
CREATE TABLE voice_prefs (user_id TEXT PRIMARY KEY, voice TEXT NOT NULL);
INSERT INTO dialogs VALUES ('d1', 'u1', '2026-10-12T10:00:00.000Z', NULL, NULL, NULL, 'male', 0);
INSERT INTO messages VALUES ('m1', 'd1', 0, 'user', 'Старое сообщение', '2026-10-12T10:00:01.000Z');
PRAGMA user_version = 1;
"""


def test_file_of_the_previous_agent_gets_the_usage_table_and_keeps_its_version(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite3"
    with sqlite3.connect(path) as raw:
        raw.executescript(SCHEMA_0_4_0)
    db = DialogDatabase(str(path))
    db.open()
    assert db.load_user("u1")[0][0].messages == [("m1", "user", "Старое сообщение", "2026-10-12T10:00:01.000Z", None)]
    db.apply(
        [
            DialogWrite(
                dialog_id="d1",
                row=("d1", "u1", "2026-10-12T10:00:00.000Z", None, None, None, "male", 0),
                usage=[("d1", "m1", "2026-10-12T10:00:02.000Z", "whisper", "stt", "input", "audio", "seconds", 2.5)],
            )
        ]
    )
    db.close()
    again = DialogDatabase(str(path))
    again.open()  # повторное обновление ничего не ломает
    again.close()
    with sqlite3.connect(path) as raw:
        # Версия та же: агент 0.4.0 (откат образа) по-прежнему открывает этот файл.
        assert raw.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 1
        assert raw.execute("SELECT message_id, amount FROM model_usage").fetchall() == [("m1", 2.5)]


# ─── Хранилище с базой ────────────────────────────────────────────────────────────────────────────────────────────


async def make_store(path: Path) -> tuple[DialogStore, DialogDatabase]:
    store, db = DialogStore(), DialogDatabase(str(path))
    await store.attach(db, flush_interval=0.01)
    return store, db


async def test_dialogs_survive_a_restart(tmp_path: Path) -> None:
    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    store, _ = await make_store(path)
    await store.ensure_user(user)
    first, _, _ = store.start(user, "female")
    q = store.add_message(first, "user", "Мне сегодня тревожно")
    store.add_message(first, "assistant", "Я рядом. Что случилось?")
    first.client_ids["c-1"] = q.id
    first.reply_index = 3
    summary = store.end(first, "Тревога", 4)
    second, resumed, _ = store.start(user)  # новый открытый диалог
    assert not resumed
    await store.detach()  # остановка пода: всё дописывается

    after, _ = await make_store(path)
    await after.ensure_user(user)
    ids = [d.id for d in after.list(user, 10, None)[0]]
    assert ids == [second.id, first.id]  # журнал от новых к старым
    restored = after.get(user, first.id)
    assert restored is not None
    assert restored.ended_at == first.ended_at and restored.summary == summary
    assert [(m.id, m.role, m.text, m.created_at) for m in restored.messages] == [
        (m.id, m.role, m.text, m.created_at) for m in first.messages
    ]
    assert restored.client_ids == {"c-1": q.id} and restored.reply_index == 3 and restored.voice == "female"
    assert not restored.has_live_socket and not restored.greeting_pending  # временное на диск не попадает
    reopened, resumed, _ = after.start(user)
    assert resumed and reopened.id == second.id  # открытый диалог возвращается
    assert after._voice_prefs[user] == "female"  # выбор голоса тоже
    await after.detach()


async def test_answer_that_grows_in_place_is_saved_while_the_socket_lives(tmp_path: Path) -> None:
    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    store, _ = await make_store(path)
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.socket_opened(dialog)
    message = store.add_message(dialog, "assistant", "Я")
    assert await store.flush()
    message.text = "Я рядом. Расскажи, что случилось."  # ответ дописывается на месте, store.add_message не зовут
    assert await store.flush()  # диалог с живым сокетом сверяется с диском на каждой записи

    db = DialogDatabase(str(path))
    db.open()
    saved = db.load_user(user)[0][0].messages
    assert [m[2] for m in saved] == ["Я рядом. Расскажи, что случилось."]
    db.close()
    store.socket_closed(dialog)
    await store.detach()


async def test_failed_write_is_retried_and_nothing_is_lost(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    class Flaky(DialogDatabase):
        fail = 2  # пачка падает, и повтор по одному диалогу тоже: запись откладывается до следующей попытки

        def apply(self, writes: list[DialogWrite]) -> None:
            if self.fail:
                self.fail -= 1
                raise sqlite3.OperationalError("disk I/O error")
            super().apply(writes)

    user = str(uuid.uuid4())
    store, db = DialogStore(), Flaky(str(tmp_path / "d.sqlite3"))
    await store.attach(db, flush_interval=60)  # фоновой записи не ждём: вызываем вручную
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "привет")
    before = errors("write")
    with caplog.at_level(logging.ERROR):
        assert await store.flush() is False
    assert errors("write") == before + 2  # сбой пачки и сбой повтора по одному диалогу
    assert await store.flush() is True  # изменения не потеряны: повтор записал их
    assert [m[2] for m in db.load_user(user)[0][0].messages] == ["привет"]
    await store.detach()


async def test_erase_removes_memory_and_disk_and_late_writes_do_not_bring_the_person_back(tmp_path: Path) -> None:
    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    store, db = await make_store(path)
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female")
    store.socket_opened(dialog)
    store.add_message(dialog, "user", "личное")
    assert await store.flush()

    await store.erase_user_durable(user)
    store.add_message(dialog, "user", "поздняя реплика живого сокета")  # сессия ещё не знает, что человека стёрли
    assert await store.flush()
    assert store.get(user, dialog.id) is None
    assert db.load_user(user) == ([], None)  # ни диалога, ни выбора голоса
    assert db.counts() == (0, 0)
    await store.erase_user_durable(user)  # повтор допустим
    await store.detach()


async def test_user_that_was_never_stored_can_be_erased(tmp_path: Path) -> None:
    store, db = await make_store(tmp_path / "d.sqlite3")
    await store.erase_user_durable(str(uuid.uuid4()))
    assert db.counts() == (0, 0)
    await store.detach()


async def test_ensure_user_does_not_overwrite_what_is_in_memory(tmp_path: Path) -> None:
    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    store, _ = await make_store(path)
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "привет")
    await store.detach()

    again, _ = await make_store(path)
    await again.ensure_user(user)
    live = again.get(user, dialog.id)
    assert live is not None
    live.messages[0].text = "изменено в памяти"
    await again.ensure_user(user)  # повторная загрузка ничего не делает
    assert again.get(user, dialog.id) is live and live.messages[0].text == "изменено в памяти"
    await again.detach()


async def test_load_failure_is_an_error_and_not_an_empty_history(tmp_path: Path) -> None:
    class Broken(DialogDatabase):
        def load_user(self, user_id: str) -> Any:
            raise sqlite3.OperationalError("database is locked")

    store, db = DialogStore(), Broken(str(tmp_path / "d.sqlite3"))
    await store.attach(db, flush_interval=60)
    before = errors("load")
    with pytest.raises(sqlite3.OperationalError):
        await store.ensure_user(str(uuid.uuid4()))
    assert errors("load") == before + 1
    await store.detach()


async def test_store_without_a_database_behaves_as_before() -> None:
    store = DialogStore()
    user = str(uuid.uuid4())
    await store.ensure_user(user)  # ничего не делает
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "привет")
    assert not store.persistent and await store.flush()
    await store.erase_user_durable(user)
    assert store.get(user, dialog.id) is None
    await store.detach()


# ─── Приложение целиком: «редеплой» ───────────────────────────────────────────────────────────────────────────────


def app_client(path: Path) -> TestClient:
    return TestClient(create_app(lambda: None, lambda: (None, None), database_factory=lambda: DialogDatabase(str(path))))


def say(client: TestClient, user: str, dialog_id: str, text: str, msg_id: str, until: str = "assistant_end") -> list[Any]:
    """Одна реплика по новому сокету; ждёт кадр `until` (для повтора с тем же id это `ack`: второго ответа не будет)."""
    with client.websocket_connect(ws_url(user, dialog_id), headers=AUTH) as ws:
        read_frames(ws, lambda f: any(k == "json" and b["type"] == "ready" for k, b in f))
        send_user_message(ws, msg_id, text)
        return read_frames(ws, lambda f: any(k == "json" and b["type"] == until for k, b in f))


def test_dialogs_and_history_come_back_after_a_redeploy(tmp_path: Path) -> None:
    path = tmp_path / "pvc" / "dialogs.sqlite3"
    user = str(uuid.uuid4())
    with app_client(path) as old:
        assert old.get("/health/ready").json()["dialogs"] == "sqlite"
        dialog = start_dialog(old, user)
        say(old, user, dialog["dialogId"], "Мне сегодня тревожно", "c-1")
        before = old.get(f"/v1/users/{user}/dialogs/{dialog['dialogId']}", headers=AUTH).json()
        assert [m["role"] for m in before["messages"]] == ["user", "assistant"]
        finished = start_dialog(old, user)  # тот же открытый
        assert finished["resumed"] is True
    # приложение остановлено (под выкачен заново), память пропала, файл остался

    with app_client(path) as new:
        listed = new.get(f"/v1/users/{user}/dialogs", headers=AUTH).json()["items"]
        assert [i["dialogId"] for i in listed] == [dialog["dialogId"]]
        after = new.get(f"/v1/users/{user}/dialogs/{dialog['dialogId']}", headers=AUTH).json()
        assert after["messages"] == before["messages"]  # те же сообщения, те же id и время
        resumed = start_dialog(new, user)
        assert resumed["dialogId"] == dialog["dialogId"] and resumed["resumed"] is True
        # сокет к прежнему диалогу открывается, переписка продолжается, повтор реплики с тем же id не плодит сообщений
        frames = say(new, user, dialog["dialogId"], "Мне сегодня тревожно", "c-1", until="ack")
        assert any(k == "json" and b["type"] == "ack" for k, b in frames)
        history = new.get(f"/v1/users/{user}/dialogs/{dialog['dialogId']}", headers=AUTH).json()["messages"]
        assert history[:2] == before["messages"] and len(history) == 2  # идемпотентность пережила перезапуск


def test_new_dialog_after_a_redeploy_ends_the_restored_open_one(tmp_path: Path) -> None:
    path = tmp_path / "dialogs.sqlite3"
    user = str(uuid.uuid4())
    with app_client(path) as old:
        first = start_dialog(old, user)
        say(old, user, first["dialogId"], "Привет", "c-1")
    with app_client(path) as new:
        second = new.post(f"/v1/users/{user}/dialogs", json={"new": True}, headers=AUTH).json()
        assert second["dialogId"] != first["dialogId"] and second["resumed"] is False
    with app_client(path) as latest:  # и завершение первого пережило ещё один перезапуск
        items = {i["dialogId"]: i for i in latest.get(f"/v1/users/{user}/dialogs", headers=AUTH).json()["items"]}
        assert items[first["dialogId"]]["endedAt"] is not None and items[second["dialogId"]]["endedAt"] is None


def test_erasing_a_user_removes_the_history_from_disk(tmp_path: Path) -> None:
    path = tmp_path / "dialogs.sqlite3"
    user = str(uuid.uuid4())
    with app_client(path) as old:
        dialog = start_dialog(old, user)
        say(old, user, dialog["dialogId"], "личное", "c-1")
        assert old.delete(f"/v1/users/{user}", headers=AUTH).status_code == 204
    with app_client(path) as new:
        assert new.get(f"/v1/users/{user}/dialogs", headers=AUTH).json()["items"] == []
    raw = sqlite3.connect(path)
    assert raw.execute("SELECT COUNT(*) FROM dialogs").fetchone()[0] == 0
    assert raw.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
    raw.close()


def test_agent_keeps_serving_in_memory_when_the_disk_is_not_available(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("не каталог", encoding="utf-8")
    before = errors("open")
    with caplog.at_level(logging.ERROR):
        with app_client(blocker / "dialogs.sqlite3") as client:
            assert client.get("/health/ready").json()["dialogs"] == "memory"
            dialog = start_dialog(client, str(uuid.uuid4()))
            assert dialog["dialogId"]  # агент работает, как раньше
    assert errors("open") == before + 1
    assert any("NOT available" in r.getMessage() for r in caplog.records)


def test_without_a_path_dialogs_are_in_memory_as_before() -> None:
    with TestClient(create_app(lambda: None, lambda: (None, None))) as client:
        assert client.get("/health/ready").json()["dialogs"] == "memory"


def test_health_and_metrics_do_not_leak_dialog_text(tmp_path: Path) -> None:
    path = tmp_path / "dialogs.sqlite3"
    user = str(uuid.uuid4())
    with app_client(path) as client:
        dialog = start_dialog(client, user)
        say(client, user, dialog["dialogId"], "очень личное признание", "c-1")
        metrics = client.get("/metrics").text
        assert "очень личное" not in metrics and json.dumps(client.get("/health/ready").json()).find("личное") == -1


# ─── Находки независимого ревью ───────────────────────────────────────────────────────────────────────────────────


async def test_unpaired_surrogate_in_a_message_does_not_stop_the_disk(tmp_path: Path) -> None:
    """Оборванная половина эмодзи (`\\ud83d` в JSON клиента) не кодируется в UTF-8: раньше она роняла запись всем людям."""
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    store, db = await make_store(tmp_path / "d.sqlite3")
    for user in (first, second):
        await store.ensure_user(user)
    bad, _, _ = store.start(first)
    store.add_message(bad, "user", "половина эмодзи \ud83d")
    bad.client_ids["id-\ud83d"] = "m-1"
    store.end(bad, "итог \ud83d", None)
    good, _, _ = store.start(second)
    store.add_message(good, "user", "обычная реплика")
    before = errors("write")
    assert await store.flush() is True and errors("write") == before  # ошибок записи нет, остальные люди пишутся
    restored = db.load_user(first)[0][0]
    assert restored.messages[0][2].startswith("половина эмодзи") and restored.summary is not None
    assert db.load_user(second)[0][0].messages[0][2] == "обычная реплика"
    await store.detach()


async def test_a_dialog_that_cannot_be_written_does_not_block_the_others(tmp_path: Path) -> None:
    class Picky(DialogDatabase):
        poisoned = ""

        def apply(self, writes: list[DialogWrite]) -> None:
            if any(w.dialog_id == self.poisoned for w in writes):
                raise sqlite3.OperationalError("disk I/O error")
            super().apply(writes)

    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    store, db = DialogStore(), Picky(str(tmp_path / "d.sqlite3"))
    await store.attach(db, flush_interval=60)
    bad, _, _ = store.start(first)
    good, _, _ = store.start(second)
    store.add_message(bad, "user", "не запишется")
    store.add_message(good, "user", "запишется")
    db.poisoned = bad.id
    assert await store.flush() is False  # плохой диалог вернулся в очередь
    assert [m[2] for m in db.load_user(second)[0][0].messages] == ["запишется"]  # хороший записан, хотя пачка упала
    assert db.load_user(first)[0] == []
    db.poisoned = ""
    assert await store.flush() is True  # и плохой запишется, когда диск оправится
    assert [m[2] for m in db.load_user(first)[0][0].messages] == ["не запишется"]
    await store.detach()


async def test_the_writer_survives_an_unexpected_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    user = str(uuid.uuid4())
    store, db = await make_store(tmp_path / "d.sqlite3")
    real, calls = store._collect, {"n": 0}

    def flaky(dialog: Any) -> Any:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("неожиданный сбой")
        return real(dialog)

    monkeypatch.setattr(store, "_collect", flaky)
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "привет")
    for _ in range(60):  # первая попытка падает, писатель ждёт секунду и пробует снова
        await asyncio.sleep(0.1)
        if db.load_user(user)[0]:
            break
    assert [m[2] for m in db.load_user(user)[0][0].messages] == ["привет"]
    await store.detach()


async def test_erase_does_not_say_done_when_the_disk_is_configured_but_not_attached() -> None:
    from app.services.dialog_db import DialogDbError

    store = DialogStore()
    store.require_disk()  # DIALOG_DB_PATH задан, но файл не открылся
    user = str(uuid.uuid4())
    dialog, _, _ = store.start(user)
    with pytest.raises(DialogDbError):
        await store.erase_user_durable(user)
    assert store.get(user, dialog.id) is None  # из памяти стёрто, а «стёрто на диске» не сказано


def test_delete_answers_503_when_the_disk_could_not_be_opened(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("не каталог", encoding="utf-8")
    with app_client(blocker / "dialogs.sqlite3") as client:
        response = client.delete(f"/v1/users/{uuid.uuid4()}", headers=AUTH)
    assert response.status_code == 503 and response.json()["error"]["code"] == "AGENT_INTERNAL"


async def test_erase_does_not_race_with_the_first_load(tmp_path: Path) -> None:
    import asyncio

    path = tmp_path / "d.sqlite3"
    user = str(uuid.uuid4())
    seed, _ = await make_store(path)
    await seed.ensure_user(user)
    dialog, _, _ = seed.start(user)
    seed.add_message(dialog, "user", "личное")
    await seed.detach()

    store, db = await make_store(path)
    loading = asyncio.create_task(store.ensure_user(user))
    await asyncio.sleep(0)  # загрузка уже читает диск
    await store.erase_user_durable(user)
    await loading
    assert store.get(user, dialog.id) is None  # прочитанное с диска не вернулось в память после стирания
    assert db.load_user(user) == ([], None)
    await store.detach()


async def test_erased_text_does_not_stay_in_the_wal_file(tmp_path: Path) -> None:
    path = tmp_path / "d.sqlite3"
    marker = "УНИКАЛЬНЫЙ-МАРКЕР-ЛИЧНОГО-ТЕКСТА".encode()
    user = str(uuid.uuid4())
    store, _ = await make_store(path)
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", marker.decode())
    assert await store.flush()
    wal = Path(str(path) + "-wal")
    assert marker in path.read_bytes() + (wal.read_bytes() if wal.exists() else b"")  # до стирания текст лежит на диске

    await store.erase_user_durable(user)
    assert marker not in path.read_bytes()
    assert not wal.exists() or marker not in wal.read_bytes()  # и в журнале WAL его больше нет
    await store.detach()
