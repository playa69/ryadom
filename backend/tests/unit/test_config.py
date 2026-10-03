"""Юнит-тесты конфигурации (задача 1.2): fail-fast, SecretStr, validation_alias."""

import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import JWTSettings, PostgresSettings


def test_missing_required_pg_password_fails(monkeypatch):
    monkeypatch.delenv("PG_PASSWORD", raising=False)
    with pytest.raises(ValidationError) as exc_info:
        PostgresSettings()
    assert "PG_PASSWORD" in str(exc_info.value)


def test_missing_required_jwt_secret_fails(monkeypatch):
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    with pytest.raises(ValidationError) as exc_info:
        JWTSettings()
    assert "JWT_SECRET_KEY" in str(exc_info.value)


def test_secret_is_secretstr(monkeypatch):
    monkeypatch.setenv("PG_PASSWORD", "super-secret")
    settings = PostgresSettings()
    assert isinstance(settings.password, SecretStr)
    assert "super-secret" not in repr(settings.password)
    assert settings.password.get_secret_value() == "super-secret"


def test_database_uri_built_from_parts(monkeypatch):
    monkeypatch.setenv("PG_PASSWORD", "pw")
    monkeypatch.setenv("PG_HOST", "db.internal")
    monkeypatch.setenv("PG_PORT", "5433")
    monkeypatch.setenv("PG_DB", "backend")
    monkeypatch.setenv("PG_USER", "developer")
    settings = PostgresSettings()
    assert settings.sqlalchemy_database_uri == (
        "postgresql+asyncpg://developer:pw@db.internal:5433/backend"
    )
