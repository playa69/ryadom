"""Асинхронное подключение к PostgreSQL (SQLAlchemy engine + сессии)."""

from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import APP_CONFIG

engine = create_async_engine(
    APP_CONFIG.pg.sqlalchemy_database_uri,
    echo=APP_CONFIG.pg.debug,
    pool_pre_ping=True,
)

AsyncSessionFactory = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db_session() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionFactory() as session:
        yield session


async def ping_database() -> None:
    """Проверка доступности БД (SELECT 1). Бросает исключение при недоступности."""
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))


async def dispose_engine() -> None:
    await engine.dispose()
