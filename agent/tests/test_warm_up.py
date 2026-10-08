"""Прогрев озвучки при старте: фраза агента должна прозвучать из памяти, а не ждать провайдера."""

import time

from fastapi.testclient import TestClient

from app.clients.speech import CachedTts
from app.main import SPOKEN_PHRASES, create_app
from app.services.replies import split_sentences
from tests.conftest import FakeTts


def test_every_spoken_phrase_is_synthesized_at_startup_in_both_voices():
    fake = FakeTts()
    expected = {(voice, part) for voice in ("male", "female") for g in SPOKEN_PHRASES for part in split_sentences(g)}
    with TestClient(create_app(lambda: CachedTts(fake, max_items=64))):
        deadline = time.monotonic() + 3
        while len(fake.calls) < len(expected) and time.monotonic() < deadline:
            time.sleep(0.01)
    assert set(zip(fake.voices, fake.calls, strict=True)) == expected


def test_a_provider_without_the_phrase_cache_is_not_warmed_up():
    fake = FakeTts()
    with TestClient(create_app(lambda: fake)):
        time.sleep(0.1)
    assert fake.calls == []
