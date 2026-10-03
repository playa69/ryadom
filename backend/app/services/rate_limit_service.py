"""Rate-limit бэкенды для AntiSpamService (1:1 UnionApp, design.md D3).

- RedisRateLimitBackend — sliding window на ZSET, cooldown через SET NX EX
- NoOpRateLimitBackend — всегда разрешает (fail-open для некритичных лимитов)
- InMemoryRateLimitBackend — для юнит-тестов
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Protocol

import redis.asyncio


class RateLimitBackend(Protocol):
    """Протокол бэкенда подсчёта rate-limit."""

    async def check_and_increment(
        self, key: str, window_seconds: int, max_attempts: int
    ) -> tuple[int, bool]:
        """Записывает попытку и возвращает (текущее_число, разрешено)."""
        ...

    async def get_last_attempt_timestamp(self, key: str) -> float | None:
        """Unix-timestamp последней попытки или None."""
        ...

    async def set_cooldown(self, key: str, cooldown_seconds: int) -> bool:
        """Ставит cooldown-блокировку. True, если установлена впервые."""
        ...

    async def check_cooldown(self, key: str) -> bool:
        """True, если cooldown активен."""
        ...

    async def get_cooldown_ttl(self, key: str) -> int:
        """Остаток cooldown в секундах, 0 если не активен."""
        ...


class RedisRateLimitBackend:
    """Sliding window на ZSET + cooldown через SET NX EX."""

    def __init__(self, redis: redis.asyncio.Redis) -> None:
        self._redis = redis

    async def check_and_increment(
        self, key: str, window_seconds: int, max_attempts: int
    ) -> tuple[int, bool]:
        now = time.time()
        pipe = self._redis.pipeline()
        pipe.zremrangebyscore(key, 0, now - window_seconds)
        pipe.zcard(key)
        pipe.zadd(key, {str(now): now})
        pipe.expire(key, window_seconds)
        _, count, _, _ = await pipe.execute()
        total = count + 1
        return total, total <= max_attempts

    async def get_last_attempt_timestamp(self, key: str) -> float | None:
        result = await self._redis.zrevrange(key, 0, 0, withscores=True)
        if result:
            return result[0][1]
        return None

    async def set_cooldown(self, key: str, cooldown_seconds: int) -> bool:
        result = await self._redis.set(key, "1", nx=True, ex=cooldown_seconds)
        return result is not None

    async def check_cooldown(self, key: str) -> bool:
        return await self._redis.exists(key) > 0

    async def get_cooldown_ttl(self, key: str) -> int:
        ttl = await self._redis.ttl(key)
        return max(0, ttl)


class NoOpRateLimitBackend:
    """No-op бэкенд, всегда разрешает (fail-open некритичных лимитов)."""

    async def check_and_increment(
        self, key: str, window_seconds: int, max_attempts: int
    ) -> tuple[int, bool]:
        return 1, True

    async def get_last_attempt_timestamp(self, key: str) -> float | None:
        return None

    async def set_cooldown(self, key: str, cooldown_seconds: int) -> bool:
        return True

    async def check_cooldown(self, key: str) -> bool:
        return False

    async def get_cooldown_ttl(self, key: str) -> int:
        return 0


@dataclass
class InMemoryRateLimitBackend:
    """In-memory rate limiter для юнит-тестов (семантика Redis-бэкенда)."""

    _windows: dict[str, list[float]] = field(default_factory=dict)
    _cooldowns: dict[str, float] = field(default_factory=dict)

    async def check_and_increment(
        self, key: str, window_seconds: int, max_attempts: int
    ) -> tuple[int, bool]:
        now = time.time()
        window = self._windows.setdefault(key, [])
        cutoff = now - window_seconds
        self._windows[key] = [t for t in window if t >= cutoff]
        self._windows[key].append(now)
        count = len(self._windows[key])
        return count, count <= max_attempts

    async def get_last_attempt_timestamp(self, key: str) -> float | None:
        window = self._windows.get(key, [])
        return max(window) if window else None

    async def set_cooldown(self, key: str, cooldown_seconds: int) -> bool:
        if key in self._cooldowns and self._cooldowns[key] > time.time():
            return False
        self._cooldowns[key] = time.time() + cooldown_seconds
        return True

    async def check_cooldown(self, key: str) -> bool:
        return key in self._cooldowns and self._cooldowns[key] > time.time()

    async def get_cooldown_ttl(self, key: str) -> int:
        if key not in self._cooldowns:
            return 0
        ttl = int(self._cooldowns[key] - time.time())
        return max(0, ttl)
