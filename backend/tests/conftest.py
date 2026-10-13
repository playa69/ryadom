"""Фикстуры pytest: тестовая БД (PostgreSQL backend_test), fake Redis, HTTP-клиент.

Тестовая БД — реальный PostgreSQL (port-forward кластера). Параметры
подключения — env PG_*; пароль — из DEVELOPER_PG_PASSWORD (не коммитить!).
Redis — fakeredis (задача 6.1 санкционирует fake Redis в фикстурах).
"""

import os
import uuid
from collections.abc import AsyncIterator

# --- env до любых импортов app-* (конфиг — синглтон на импорте) ---
os.environ.setdefault("JWT_SECRET_KEY", "test-jwt-secret-key-for-pytest-only")
os.environ.setdefault("PG_HOST", "127.0.0.1")
os.environ.setdefault("PG_PORT", "15432")
os.environ.setdefault("PG_DB", "backend_test")
os.environ.setdefault("PG_USER", "developer")
if "DEVELOPER_PG_PASSWORD" in os.environ:
    os.environ.setdefault("PG_PASSWORD", os.environ["DEVELOPER_PG_PASSWORD"])
os.environ.setdefault("PG_IS_HARD_HEALTH", "false")
os.environ.setdefault("REDIS_ENABLED", "true")
os.environ.setdefault("REDIS_IS_HARD_HEALTH", "false")
os.environ.setdefault("LOG_PATH", "/tmp/ryadom-test-logs")
os.environ.setdefault("METRIC_PATH", "/tmp/ryadom-test-logs")
os.environ.setdefault("AUDIT_LOG_PATH", "/tmp/ryadom-test-logs")
os.environ.setdefault("LOCAL", "true")

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.deps import get_email_sender
from app.core.config import APP_CONFIG
from app.core.redis import set_redis_client
from app.main import app
from app.models import Base


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="session")
async def engine():
    engine = create_async_engine(
        APP_CONFIG.pg.sqlalchemy_database_uri, pool_pre_ping=True
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.fixture(scope="session")
def session_factory(engine):
    return async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(autouse=True)
async def clean_tables(engine):
    yield
    async with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(text(f'TRUNCATE TABLE "{table.name}" CASCADE'))


@pytest.fixture
async def db_session(session_factory) -> AsyncIterator[AsyncSession]:
    async with session_factory() as session:
        yield session


@pytest.fixture
async def fake_redis():
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    set_redis_client(client)
    yield client
    set_redis_client(None)
    await client.aclose()


class SpyEmailSender:
    """Фикстура-шпион отправки писем (протокол EmailSender)."""

    def __init__(self) -> None:
        self.link_codes: list[dict] = []
        self.password_resets: list[dict] = []
        self.password_changed: list[dict] = []

    async def send_email_link_code(self, *, email: str, code: str) -> None:
        self.link_codes.append({"email": email, "code": code})

    async def send_password_reset(
        self, *, email: str, reset_token: str, expires_at
    ) -> None:
        self.password_resets.append(
            {"email": email, "reset_token": reset_token, "expires_at": expires_at}
        )

    async def send_password_changed(self, *, email: str) -> None:
        self.password_changed.append({"email": email})


@pytest.fixture
def spy_email_sender() -> SpyEmailSender:
    return SpyEmailSender()


@pytest.fixture
async def client(spy_email_sender, fake_redis) -> AsyncIterator[AsyncClient]:
    app.dependency_overrides[get_email_sender] = lambda: spy_email_sender
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
    app.dependency_overrides.clear()


# --- helpers ---


def new_device_creds() -> dict[str, str]:
    return {
        "device_id": str(uuid.uuid4()),
        "device_key": f"key-{uuid.uuid4().hex[:16]}",
    }


async def register_device(client: AsyncClient, **overrides) -> dict:
    """Регистрирует устройство через API и возвращает тело ответа."""
    creds = new_device_creds()
    creds.update(overrides)
    response = await client.post("/api/v1/auth/device", json=creds)
    assert response.status_code == 200, response.text
    return response.json()
