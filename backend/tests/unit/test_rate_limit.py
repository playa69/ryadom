"""Юнит-тесты rate-limit бэкендов (задача 4.2): sliding window и cooldown."""

import time

from app.services.rate_limit_service import (
    InMemoryRateLimitBackend,
    NoOpRateLimitBackend,
)


async def test_sliding_window_allows_within_limit():
    backend = InMemoryRateLimitBackend()
    for expected_count in (1, 2, 3):
        count, allowed = await backend.check_and_increment(
            "k1", window_seconds=60, max_attempts=3
        )
        assert count == expected_count
        assert allowed


async def test_sliding_window_blocks_over_limit():
    backend = InMemoryRateLimitBackend()
    for _ in range(3):
        await backend.check_and_increment("k1", window_seconds=60, max_attempts=3)
    count, allowed = await backend.check_and_increment(
        "k1", window_seconds=60, max_attempts=3
    )
    assert count == 4
    assert not allowed


async def test_sliding_window_expires_old_attempts():
    backend = InMemoryRateLimitBackend()
    backend._windows["k1"] = [time.time() - 120]  # попытка за пределами окна
    count, allowed = await backend.check_and_increment(
        "k1", window_seconds=60, max_attempts=1
    )
    assert count == 1
    assert allowed


async def test_last_attempt_timestamp():
    backend = InMemoryRateLimitBackend()
    assert await backend.get_last_attempt_timestamp("k1") is None
    await backend.check_and_increment("k1", 60, 5)
    assert await backend.get_last_attempt_timestamp("k1") is not None


async def test_cooldown_lifecycle():
    backend = InMemoryRateLimitBackend()
    assert not await backend.check_cooldown("c1")
    assert await backend.set_cooldown("c1", 60)
    # Повторная установка при активном cooldown — False
    assert not await backend.set_cooldown("c1", 60)
    assert await backend.check_cooldown("c1")
    ttl = await backend.get_cooldown_ttl("c1")
    assert 0 < ttl <= 60


async def test_cooldown_expired():
    backend = InMemoryRateLimitBackend()
    backend._cooldowns["c1"] = time.time() - 1
    assert not await backend.check_cooldown("c1")
    assert await backend.get_cooldown_ttl("c1") == 0
    assert await backend.set_cooldown("c1", 60)


async def test_noop_backend_always_allows():
    backend = NoOpRateLimitBackend()
    _count, allowed = await backend.check_and_increment("k", 1, 0)
    assert allowed
    assert not await backend.check_cooldown("k")
