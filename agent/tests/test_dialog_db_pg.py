"""Хранилище диалогов — только PostgreSQL: `DIALOG_DATABASE_URL` читается из окружения (app/core/config.py)."""

import pytest

from app.core.config import DialogSettings


def test_database_url_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DIALOG_DATABASE_URL", "postgresql://agent@db/agent")
    assert DialogSettings().database_url == "postgresql://agent@db/agent"


def test_database_url_defaults_to_none() -> None:
    assert DialogSettings().database_url is None


def test_pool_settings_read_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Параметры пула читаются из типизированных env-настроек."""
    monkeypatch.setenv("DIALOG_DB_POOL_MIN_SIZE", "2")
    monkeypatch.setenv("DIALOG_DB_POOL_MAX_SIZE", "6")
    monkeypatch.setenv("DIALOG_DB_POOL_MAX_IDLE_SECONDS", "120")
    monkeypatch.setenv("DIALOG_DB_POOL_MAX_LIFETIME_SECONDS", "900")
    settings = DialogSettings()
    assert (settings.db_pool_min_size, settings.db_pool_max_size) == (2, 6)
    assert (settings.db_pool_max_idle_seconds, settings.db_pool_max_lifetime_seconds) == (
        120,
        900,
    )


def test_pool_min_size_cannot_exceed_max_size(monkeypatch: pytest.MonkeyPatch) -> None:
    """Некорректные границы пула останавливают загрузку конфигурации."""
    monkeypatch.setenv("DIALOG_DB_POOL_MIN_SIZE", "5")
    monkeypatch.setenv("DIALOG_DB_POOL_MAX_SIZE", "2")
    with pytest.raises(ValueError, match="DIALOG_DB_POOL_MIN_SIZE"):
        DialogSettings()
