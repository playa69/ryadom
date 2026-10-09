"""Фабрика чекпоинтера истории диалогов в Postgres."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


@asynccontextmanager
async def create_checkpointer(
    dsn: str, *, min_size: int = 5, max_size: int = 50
) -> AsyncIterator[AsyncPostgresSaver]:
    """Создаёт и инициализирует чекпоинтер LangGraph поверх пула соединений.

    Пул снимает ограничение одиночного соединения: параллельные ходы разных
    диалогов не упираются в «connection is busy», а min_size соединений
    держится открытыми постоянно. Выход из ``async with`` на shutdown
    закрывает пул штатно.

    Args:
        dsn: DSN вида postgresql://user:pass@host:port/db.
        min_size: Сколько соединений пул держит открытыми всегда.
        max_size: Верхний предел соединений пула.

    Yields:
        Готовый AsyncPostgresSaver с созданными таблицами чекпоинтов.
    """
    pool = AsyncConnectionPool(
        conninfo=dsn,
        min_size=min_size,
        max_size=max_size,
        open=False,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
    )
    await pool.open()
    try:
        saver = AsyncPostgresSaver(pool)
        await saver.setup()
        yield saver
    finally:
        await pool.close()
