"""Хранилище диалогов — только PostgreSQL: `DIALOG_DATABASE_URL` читается из окружения (app/core/config.py)."""

import pytest

from app.core.config import DialogSettings


def test_database_url_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DIALOG_DATABASE_URL", "postgresql://agent@db/agent")
    assert DialogSettings().database_url == "postgresql://agent@db/agent"


def test_database_url_defaults_to_none() -> None:
    assert DialogSettings().database_url is None
