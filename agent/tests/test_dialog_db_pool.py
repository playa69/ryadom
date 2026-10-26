"""Проверяет конфигурацию и жизненный цикл пула PostgreSQL без живой БД."""

from unittest.mock import MagicMock

import pytest

from app.services import dialog_db


def test_operations_use_checked_connections_from_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Каждая операция берёт соединение из пула с health-check, а close закрывает пул."""
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = (0,)
    pool = MagicMock()
    pool.connection.return_value.__enter__.return_value = conn
    pool_class = MagicMock(return_value=pool)
    pool_class.check_connection = MagicMock()
    monkeypatch.setattr(dialog_db, "ConnectionPool", pool_class)

    db = dialog_db.DialogDatabase("postgresql://agent@db/agent", min_size=2, max_size=5)
    db.open()
    assert db.counts() == (0, 0)
    db.close()

    kwargs = pool_class.call_args.kwargs
    assert kwargs["min_size"] == 2 and kwargs["max_size"] == 5
    assert kwargs["check"] is pool_class.check_connection
    kwargs["configure"](conn)
    assert conn.autocommit is True and conn.prepare_threshold is None
    assert pool.connection.call_count == 3
    pool.open.assert_called_once_with(wait=True)
    pool.close.assert_called_once_with()


def test_connection_cannot_be_borrowed_before_open() -> None:
    """До открытия пула операция сообщает об ошибке хранилища."""
    db = dialog_db.DialogDatabase("postgresql://agent@db/agent")
    with pytest.raises(dialog_db.DialogDbError, match="не открыта"):
        db.counts()
