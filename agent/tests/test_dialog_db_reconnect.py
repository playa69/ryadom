"""Хранилище диалогов переживает разрыв соединения с PostgreSQL: без этого один обрыв (сеть, сайдкар, смена
реплики) выводил агента из строя до перезапуска пода. Нужна настоящая база: `AGENT_TEST_DATABASE_URL`."""

import os

import psycopg
import pytest

from app.services.dialog_db import DialogDatabase, DialogDbError, DialogWrite

URL = os.environ.get("AGENT_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(URL is None, reason="AGENT_TEST_DATABASE_URL не задан")


@pytest.fixture
def db():
    store = DialogDatabase(URL)
    store.open()
    store.erase_user("reconnect-user")
    yield store
    store.erase_user("reconnect-user")
    store.close()


def _write() -> DialogWrite:
    return DialogWrite(
        dialog_id="rc-1",
        row=("rc-1", "reconnect-user", "2026-10-24T10:00:00Z", None, None, None, "male", 0, "on", 0),
        messages=[("m1", "rc-1", 0, "user", "привет", "2026-10-24T10:00:01Z", None)],
    )


def _kill_backend(store: DialogDatabase) -> None:
    """Сервер сам закрывает соединение агента: так выглядит разрыв."""
    with store._connection() as conn:
        pid = conn.info.backend_pid
    with psycopg.connect(URL, autocommit=True) as admin:
        admin.execute("SELECT pg_terminate_backend(%s)", (pid,))


def test_closed_connection_is_reopened(db: DialogDatabase) -> None:
    db.apply([_write()])
    with db._connection() as conn:
        conn.close()
    dialogs, _ = db.load_user("reconnect-user")
    assert [d.id for d in dialogs] == ["rc-1"]


def test_server_side_disconnect_is_survived_by_read_and_write(db: DialogDatabase) -> None:
    db.apply([_write()])
    _kill_backend(db)
    dialogs, _ = db.load_user("reconnect-user")
    assert [d.id for d in dialogs] == ["rc-1"]
    _kill_backend(db)
    db.apply([_write()])
    _kill_backend(db)
    db.delete_dialog("reconnect-user", "rc-1", forget_derived=False)
    assert db.load_user("reconnect-user")[0] == []


def test_unreachable_database_raises_instead_of_hanging() -> None:
    db = DialogDatabase("postgresql://nobody@127.0.0.1:1/none")
    with pytest.raises(DialogDbError):
        db.open()
