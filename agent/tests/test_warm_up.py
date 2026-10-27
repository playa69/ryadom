"""Прогрев озвучки при старте: фраза агента должна прозвучать из памяти, а не ждать провайдера."""

import asyncio
import time

from fastapi.testclient import TestClient

from app.clients.gemini_live import GeminiLiveTts, LiveError, LiveEvent, LiveHistory
from app.clients.speech import CachedTts, Voice
from app.core.config import GeminiSettings
from app.main import SPOKEN_PHRASES, WARM_UP_GEMINI_SESSIONS, create_app
from app.services.gemini_budget import TokenBudget
from app.services.replies import split_sentences
from tests.conftest import FakeTts
from tests.fake_live import FakeConnector, FakeLink

SENTENCES = [part for phrase in SPOKEN_PHRASES for part in split_sentences(phrase)]
WANTED = [(voice, part) for part in SENTENCES for voice in ("male", "female")]
# Внутренняя ошибка Google: тот же код 1011, что у отказа по квоте, но без слова «quota».
INTERNAL_1011 = "received 1011 (internal error) Internal error encountered."


class CountingConnector(FakeConnector):
    """Поддельный Gemini для прогрева: считает сессии, открытые одновременно (от начала открытия до закрытия соединения, то есть
    вместе с дочитыванием расхода фразы), и отказывает открытиям с номерами из `refuse` (с 1) внутренней ошибкой."""

    def __init__(self, refuse: set[int] | None = None) -> None:
        super().__init__()
        self.open_delay = 0.01
        self.refuse = refuse or set()
        self.now = 0
        self.peak = 0

    async def open(
        self, voice: str, instructions: str, history: LiveHistory | None = None
    ) -> FakeLink:
        self.now += 1
        self.peak = max(self.peak, self.now)
        try:
            if len(self.open_calls) + 1 in self.refuse:
                self.open_calls.append(voice)
                raise LiveError(f"Gemini Live не открылся: ConnectionClosedError: {INTERNAL_1011}")
            link = await super().open(voice, instructions, history)
        except BaseException:
            self.now -= 1
            raise
        send_text, aclose = link.send_text, link.aclose

        async def answer(text: str) -> None:
            await send_text(text)
            # Расход фразы Google присылает с turn_complete, позже звука: всё это время сессия открыта.
            asyncio.get_running_loop().call_later(0.2, link.push, LiveEvent("turn_complete"))

        async def close() -> None:
            self.now -= 1
            await aclose()

        link.send_text, link.aclose = answer, close  # type: ignore[method-assign]
        return link


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


def test_gemini_warm_up_keeps_at_most_three_sessions_open() -> None:
    """Фраза — сессия Gemini: 16 открытий разом Google встречал отказами. Прогрев держит открытыми не больше
    WARM_UP_GEMINI_SESSIONS, считая и сессии, которые ещё дочитывают расход."""
    connector = CountingConnector()
    with TestClient(create_app(None, lambda: (None, None), live_factory=lambda: connector)) as client:
        tts = client.app.state.tts
        deadline = time.monotonic() + 10
        while not all(tts.remembered(part, voice) for voice, part in WANTED) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert all(tts.remembered(part, voice) for voice, part in WANTED)
    assert len(connector.open_calls) == len(WANTED)
    assert 1 < connector.peak <= WARM_UP_GEMINI_SESSIONS


async def test_a_failed_phrase_does_not_stop_the_warm_up() -> None:
    """Одна фраза не озвучилась (внутренняя ошибка Google): остальные прогреваются, паузы как после квоты нет."""
    connector = CountingConnector(refuse={2})
    budget = TokenBudget(GeminiSettings.model_validate({"GEMINI_TPM_LIMIT": 400_000}), metrics=False)
    tts = CachedTts(GeminiLiveTts(connector, budget=budget), max_items=64)
    await tts.warm_up(SENTENCES, parallel=WARM_UP_GEMINI_SESSIONS)
    assert not budget.cooling()
    assert len(connector.open_calls) == len(WANTED)
    assert sum(tts.remembered(part, voice) is not None for voice, part in WANTED) == len(WANTED) - 1
    assert connector.now == 0  # все сессии фраз закрыты


async def test_an_unexpected_error_in_one_phrase_does_not_stop_the_warm_up() -> None:
    class Broken(FakeTts):
        async def synthesize(self, text: str, voice: Voice = "male") -> bytes:
            if text == SENTENCES[0] and voice == "male":
                raise RuntimeError("сбой в тесте")
            return await super().synthesize(text, voice)

    tts = CachedTts(Broken(), max_items=64)
    await tts.warm_up(SENTENCES)
    assert tts.remembered(SENTENCES[0], "male") is None
    assert all(tts.remembered(part, voice) for voice, part in WANTED[1:])
