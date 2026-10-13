"""Асинхронный Redis-клиент с поддержкой Sentinel (паттерн UnionApp).

Sentinel-инстансы обнаруживаются через headless DNS-сервис ``redis``
в namespace, а не через захардкоженные имена подов.
"""

from __future__ import annotations

import socket

from loguru import logger
from redis.asyncio import Sentinel
from redis.asyncio.client import Redis

_redis_client: Redis | None = None


def get_redis_client() -> Redis | None:
    """Возвращает глобальный singleton Redis-клиента или None."""
    return _redis_client


def set_redis_client(client: Redis | None) -> None:
    """Устанавливает глобальный singleton Redis-клиента."""
    global _redis_client
    _redis_client = client


def _resolve_sentinel_hosts(
    sentinel_host: str, sentinel_port: int
) -> list[tuple[str, int]]:
    """Резолвит headless-сервис Sentinel в список IP подов."""
    try:
        infos = socket.getaddrinfo(
            sentinel_host, sentinel_port, socket.AF_INET, socket.SOCK_STREAM
        )
        hosts = list({(info[4][0], sentinel_port) for info in infos})
        logger.debug(f"Sentinel-хосты из {sentinel_host}: {hosts}")
        return hosts
    except socket.gaierror:
        logger.warning(
            f"Не удалось разрешить headless-сервис Sentinel {sentinel_host}; "
            "fallback на одиночный хост"
        )
        return [(sentinel_host, sentinel_port)]


async def create_redis_client(
    *,
    sentinel_host: str,
    sentinel_port: int,
    master_name: str,
    password: str | None = None,
) -> Redis:
    """Создаёт Sentinel-aware async Redis-клиент и проверяет соединение."""
    sentinel_hosts = _resolve_sentinel_hosts(sentinel_host, sentinel_port)
    # redis-py: kwargs Sentinel(...) уходят в master/replica-соединения,
    # на сами sentinel-инстансы auth передаётся только через sentinel_kwargs.
    # Bitnami redis+sentinel ставит requirepass и на sentinel-порт — без
    # sentinel_kwargs discover_master падает с NOAUTH AuthenticationError.
    sentinel = Sentinel(
        sentinel_hosts,
        password=password,
        sentinel_kwargs={
            "password": password,
            "socket_connect_timeout": 1.0,
            "socket_timeout": 1.0,
        },
        socket_connect_timeout=1.0,
        socket_timeout=1.0,
        decode_responses=True,
    )
    client: Redis = sentinel.master_for(master_name)
    await client.ping()
    logger.info(
        f"Redis подключён через Sentinel (hosts={sentinel_hosts}, master={master_name})"
    )
    return client


async def close_redis_client() -> None:
    """Закрывает глобальный Redis-клиент, если открыт."""
    global _redis_client
    if _redis_client is not None:
        await _redis_client.close()
        _redis_client = None
        logger.info("Redis-клиент закрыт")
