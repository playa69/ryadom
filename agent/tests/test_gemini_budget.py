"""Бюджет входных токенов Gemini Live в минуту (GEMINI_TPM_*, app/services/gemini_budget.py).

Окно, резервы, уровни, пауза после отказа Google по квоте (1011) и автокалибровка проверяются на подставных часах, без
ожидания. Остальное — на поддельной модели (`FakeConnector` из tests/test_live.py, с режимом квоты), без сети и без
настоящего Gemini: допуск нового сокета, деградация хода, ленивое открытие, учёт открытий.
"""

import json
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY, generate_latest
from pydantic import ValidationError

from app.api.dialog_live import _FallbackTts
from app.clients.gemini_live import (
    VERBATIM_INSTRUCTIONS,
    GeminiLiveTts,
    LiveEvent,
    is_explicit_quota_error,
    is_quota_error,
)
from app.clients.speech import CachedTts, TtsError
from app.core.config import APP_CONFIG, GeminiSettings
from app.main import SPOKEN_PHRASES, create_app
from app.services.gemini_budget import (
    CascadeFallback,
    TokenBudget,
    estimate_open,
    estimate_turn,
    text_tokens,
)
from app.services.replies import REPLIES, split_sentences
from tests.conftest import (
    AUTH,
    FakeChat,
    FakeRecognizer,
    FakeTts,
    audio_in_frame,
    has,
    read_frames,
    send_user_message,
    start_dialog,
    ws_url,
)
from tests.test_live import FakeConnector, FakeLink, reply_done, speak_turn
from tests.test_live_context import make_session, refreshed, say, start_speaking, wait_until

FIRST, SECOND, THIRD = "Первая реплика", "Вторая реплика", "Третья реплика"


# ─── Помощники ────────────────────────────────────────────────────────────────────────────────────────────────────


class Clock:
    """Подставные часы бюджета: время идёт, только когда тест его двигает."""

    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds

    async def sleep(self, seconds: float) -> None:
        self.now += seconds


def settings(**env: Any) -> GeminiSettings:
    """Настройки бюджета: лимит 1000 токенов, пороги по умолчанию; `env` — значения под именами переменных окружения."""
    return GeminiSettings.model_validate({"GEMINI_TPM_LIMIT": 1000, **env})


def make_budget(clock: Clock | None = None, **env: Any) -> TokenBudget:
    clock = clock or Clock()
    return TokenBudget(settings(**env), clock=clock, sleep=clock.sleep, metrics=False)


class Link:
    """Сессия для учёта: ключ в словаре бюджета должен быть объектом, на который можно сослаться (не голый `object()`)."""


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


@pytest.fixture
def tune(monkeypatch: pytest.MonkeyPatch) -> Callable[..., None]:
    """Настройки Gemini для приложения, созданного после вызова: контекст текстом, как в проде, и всё, что передал тест."""
    for name, value in (("text_context", True), ("session_resumption", True), ("history_messages", 40)):
        monkeypatch.setattr(APP_CONFIG.gemini, name, value)

    def apply(**values: Any) -> None:
        for name, value in values.items():
            monkeypatch.setattr(APP_CONFIG.gemini, name, value)

    return apply


def make_client(connector: FakeConnector, tts: Any = None, fallback: CascadeFallback | None = None) -> TestClient:
    parts = (fallback.chat, fallback.recognizer, fallback.tts) if fallback is not None else (None, None, None)
    return TestClient(
        create_app(lambda: tts, lambda: (None, None), live_factory=lambda: connector, fallback_factory=lambda: parts)
    )


@contextmanager
def connect(client: TestClient, user_id: str, dialog_id: str) -> Iterator[Any]:
    """Сокет диалога. TestClient отменяет приложение сразу после выхода из сокета, и уборка сессии иногда рвётся посередине
    (CancelledError в теле теста): закрываем сами и ждём конца сессии, как в tests/test_live_context.py."""
    with client.websocket_connect(ws_url(user_id, dialog_id), headers=AUTH) as ws:
        try:
            yield ws
        finally:
            ws.close(1000)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and client.app.state.store.get(user_id, dialog_id).has_live_socket:
                time.sleep(0.005)


@contextmanager
def talk(
    connector: FakeConnector, user_id: str, tts: Any = None, fallback: CascadeFallback | None = None
) -> Iterator[tuple[TestClient, Any, TokenBudget]]:
    """Диалог с поддельной моделью и бюджетом приложения: клиент, открытый сокет и бюджет."""
    with make_client(connector, tts or FakeTts(), fallback) as client:
        dialog_id = start_dialog(client, user_id)["dialogId"]
        with connect(client, user_id, dialog_id) as ws:
            yield client, ws, client.app.state.budget


def assistant_text(frames: list[Any]) -> str:
    return next(f[1]["text"] for f in reversed(frames) if f[0] == "json" and f[1]["type"] == "assistant_end")


def cascade(**kwargs: Any) -> CascadeFallback:
    return CascadeFallback(
        kwargs.get("chat", FakeChat(reply="Я рядом, расскажи ещё.")),
        kwargs.get("recognizer", FakeRecognizer()),
        kwargs.get("tts", FakeTts()),
    )


def open_cost(link: FakeLink) -> int:
    """Во сколько квоты оценено открытие этой сессии: промпт и загруженная история."""
    return estimate_open([link.instructions, *(text for _, text in link.history or ())])


# ─── Настройки и оценки ───────────────────────────────────────────────────────────────────────────────────────────


def test_defaults_are_off_and_only_measure() -> None:
    cfg = GeminiSettings.model_validate({})
    assert cfg.tpm_limit == 0 and cfg.tpm_enforce is False and cfg.lazy_open is False
    assert (cfg.tpm_trim_at, cfg.tpm_admit_at, cfg.tpm_hard_at) == (0.6, 0.7, 0.9)
    assert (cfg.history_messages_tight, cfg.tpm_wait_ms, cfg.quota_cooldown_seconds) == (16, 1500, 5)
    assert cfg.tpm_open_factor == 1.0


def test_thresholds_must_go_in_order() -> None:
    with pytest.raises(ValidationError):
        GeminiSettings.model_validate({"GEMINI_TPM_TRIM_AT": 0.8, "GEMINI_TPM_ADMIT_AT": 0.7})
    with pytest.raises(ValidationError):
        GeminiSettings.model_validate({"GEMINI_TPM_HARD_AT": 0.5})


def test_token_estimates() -> None:
    assert text_tokens("a" * 40) == 10 and text_tokens("абв") == 2  # байты UTF-8 / 4, вверх: кириллица — 2 байта на знак
    assert estimate_open(["a" * 400, "b" * 400], 1.0) == 200
    assert estimate_open(["a" * 400], 1.5) == 150
    assert estimate_open(["a" * 400], 0) == 0  # открытия не считаем
    assert estimate_turn() == 156  # постоянная надбавка Google на ход
    assert estimate_turn("a" * 40) == 156 + 10
    assert estimate_turn(audio_seconds=2) == 156 + 64
    assert estimate_turn("a" * 40, carried=200) == 156 + 10 + 200


@pytest.mark.parametrize(
    ("text", "quota", "explicit"),
    [
        pytest.param("Gemini Live не открылся: ConnectionClosedError: received 1011 (internal error) You exceeded your current quota", True, True),
        pytest.param("ConnectionClosedError: received 1011 (internal error) Internal error encountered.", True, False),
        pytest.param("429 RESOURCE_EXHAUSTED", True, True),
        pytest.param("соединение закрыто", False, False),
        pytest.param("Gemini Live не открылся в тесте", False, False),
        pytest.param("received 1000 (OK)", False, False),
        pytest.param("ошибка 10110", False, False),
    ],
)
def test_quota_error_recognition(text: str, quota: bool, explicit: bool) -> None:
    assert is_quota_error(text) is quota
    assert is_explicit_quota_error(text) is explicit


# ─── Окно токенов ─────────────────────────────────────────────────────────────────────────────────────────────────


def test_window_slides_over_sixty_seconds() -> None:
    clock = Clock()
    budget = make_budget(clock)
    budget.charge(100)
    clock.advance(30)
    budget.charge(200)
    assert budget.window_tokens() == 300
    clock.advance(29.9)
    assert budget.window_tokens() == 300  # с первого списания 59,9 с
    clock.advance(0.1)
    assert budget.window_tokens() == 200  # ровно 60 с: первое выпало
    clock.advance(30)
    assert budget.window_tokens() == 0


def test_reserve_settle_and_cancel() -> None:
    clock = Clock()
    budget = make_budget(clock)
    rid = budget.reserve(150)
    assert (budget.window_tokens(), budget.reserved_tokens(), budget.used()) == (0, 150, 150)
    budget.settle(rid, 400)  # пришёл usage: резерв заменён фактом
    assert (budget.window_tokens(), budget.reserved_tokens()) == (400, 0)
    other = budget.reserve(200)
    budget.cancel(other)  # ход не состоялся
    assert budget.used() == 400
    lost = budget.reserve(300)  # usage так и не пришёл
    assert budget.reserved(lost) == 300
    clock.advance(61)
    assert budget.reserved_tokens() == 0 and budget.reserved(lost) == 0  # через 60 с резерв отслужил своё


def test_levels_follow_the_share_of_the_limit() -> None:
    clock = Clock()
    budget = make_budget(clock, GEMINI_TPM_ENFORCE=True)
    seen = []
    for tokens in (599, 1, 99, 200, 1):  # нарастающим итогом: 599, 600, 699, 899, 900
        budget.charge(tokens)
        seen.append(budget.level())
    assert seen == ["ok", "trim", "trim", "admit_off", "hard"]
    budget.charge(0)
    clock.advance(61)
    assert budget.level() == "ok"  # окно сползло
    rid = budget.reserve(750)  # резервы идущих ходов тоже в уровне
    assert budget.level() == "admit_off"
    budget.cancel(rid)
    assert budget.level() == "ok"


def test_disabled_budget_does_nothing() -> None:
    clock = Clock()
    budget = make_budget(clock, GEMINI_TPM_LIMIT=0, GEMINI_TPM_ENFORCE=True)
    assert budget.reserve(500) is None
    budget.charge(10_000)
    assert budget.window_tokens() == 0 and budget.level() == "ok" and budget.fits(10**9) and budget.admits_live()
    assert not budget.trims_history() and budget.open_estimate(["x" * 4000]) == 0
    budget.on_quota_error("open")  # метрика считается, пауза не начинается
    assert not budget.cooling() and budget.level() == "ok"


async def test_disabled_budget_acquire_does_not_wait() -> None:
    clock = Clock()
    budget = make_budget(clock, GEMINI_TPM_LIMIT=0, GEMINI_TPM_ENFORCE=True)
    assert await budget.acquire(10**9, 5) is None
    assert clock.now == 1000.0


def test_measure_only_does_not_degrade() -> None:
    clock = Clock()
    budget = make_budget(clock)  # GEMINI_TPM_ENFORCE=false
    budget.charge(950)
    assert budget.level() == "hard"  # меряет и пишет в журнал...
    assert budget.admits_live() and not budget.trims_history()  # ...а решений не принимает


def test_open_is_counted_once_and_a_turn_adds_the_increment() -> None:
    """Открытие — факт в окне при открытии сессии; ход сверх открытия не удваивает его: факт поднимает учёт, только если
    контекст вырос больше, чем уже посчитано."""
    budget = make_budget(Clock(), GEMINI_TPM_LIMIT=1_000_000)
    link = Link()
    budget.opened(link, budget.opening(37_000))  # открытие с историей в 40 сообщений ≈ 37 тыс. в счёте Google
    assert budget.window_tokens() == 37_000 and budget.counted(link) == 37_000
    turn = budget.reserve(500)
    assert budget.settle_turn(link, turn, 24_213) == 500  # usage хода (24 213) меньше уже учтённого контекста
    assert budget.window_tokens() == 37_500 and budget.counted(link) == 37_500
    turn = budget.reserve(500)
    assert budget.settle_turn(link, turn, 60_000) == 22_500  # контекст вырос сверх учтённого: добавляется только разница
    assert budget.window_tokens() == 60_000 and budget.counted(link) == 60_000


def test_without_counting_opens_a_turn_pays_the_whole_prompt() -> None:
    budget = make_budget(Clock(), GEMINI_TPM_LIMIT=1_000_000, GEMINI_TPM_OPEN_FACTOR=0)
    assert not budget.counts_open
    link = Link()
    assert budget.opening(budget.open_estimate(["x" * 4000])) is None  # открытие не резервируется
    budget.opened(link, None)
    assert budget.window_tokens() == 0
    turn = budget.reserve(156)
    assert budget.settle_turn(link, turn, 24_213) == 24_213  # по факту целиком, как первоначальная модель «окно по prompt_all»
    assert budget.window_tokens() == 24_213


# ─── Пауза после отказа Google по квоте ───────────────────────────────────────────────────────────────────────────


def test_cooldown_grows_and_does_not_extend_during_the_pause() -> None:
    clock = Clock()
    budget = make_budget(clock)
    expected = [5, 10, 20, 40, 60, 60]  # растёт вдвое до предела в минуту
    for seconds in expected:
        budget.on_quota_error("open")
        assert budget.cooling() and budget.level() == "cooldown"
        assert budget.cooldown_left() == pytest.approx(seconds)
        clock.advance(1)
        budget.on_quota_error("session")  # отказ другому разговору в ту же секунду пауза не продлевает
        assert budget.cooldown_left() == pytest.approx(seconds - 1)
        clock.advance(seconds - 1)
        assert not budget.cooling()


def test_cooldown_resets_after_good_turns() -> None:
    clock = Clock()
    budget = make_budget(clock)
    link = Link()
    budget.opened(link, None)
    budget.on_quota_error("open")
    clock.advance(5)
    budget.on_quota_error("open")
    assert budget.cooldown_left() == pytest.approx(10)
    clock.advance(10)
    for _ in range(3):  # Google снова отвечает
        budget.settle_turn(link, budget.reserve(200), 300)
    budget.on_quota_error("open")
    assert budget.cooldown_left() == pytest.approx(5)  # опять с начальной


def test_cooldown_can_be_turned_off() -> None:
    budget = make_budget(Clock(), GEMINI_QUOTA_COOLDOWN_SECONDS=0)
    budget.on_quota_error("open")
    assert not budget.cooling()


def test_quota_error_calibrates_the_limit_for_ten_minutes() -> None:
    clock = Clock()
    budget = make_budget(clock)  # лимит 1000
    clock.advance(120)  # после старта прошла минута: окно настоящее
    budget.charge(800)
    budget.on_quota_error("open")  # Google отказал при 800 в нашем окне: у него больше
    assert budget.limit() == 720  # 0,9 от окна
    clock.advance(10)  # пауза кончилась, а окно (800) при лимите 720 уже за порогом hard
    assert not budget.cooling() and budget.level() == "hard"
    clock.advance(589)
    assert budget.limit() == 720  # десять минут с ошибки
    clock.advance(2)
    assert budget.limit() == 1000


def test_calibration_ignores_the_first_minute_the_pause_does_not_and_the_floor_holds() -> None:
    clock = Clock()
    budget = make_budget(clock)
    budget.charge(800)
    clock.advance(30)  # пода только что запущен: у Google окно полное, у нас нет
    budget.on_quota_error("open")
    assert budget.limit() == 1000 and budget.cooling()
    clock.advance(200)
    budget.charge(100)
    budget.on_quota_error("open", calibrate=False)  # голый 1011 без слова «quota»
    assert budget.limit() == 1000
    clock.advance(100)
    budget.charge(100)
    budget.on_quota_error("open")  # у нас почти пусто: не обрушиваем лимит ниже четверти настроенного
    assert budget.limit() == 250
    clock.advance(700)
    budget.charge(2000)
    budget.on_quota_error("open")  # окно выше лимита: лимит не растёт
    assert budget.limit() == 1000


async def test_acquire_waits_and_then_gives_up() -> None:
    clock = Clock()
    budget = make_budget(clock, GEMINI_TPM_ENFORCE=True)
    budget.charge(950)
    waited = sample("agent_gemini_budget_wait_seconds_count")
    assert await budget.acquire(100, 1.5) is None
    assert clock.now - 1000.0 >= 1.5  # ждал весь срок
    assert budget.reserved_tokens() == 0
    assert sample("agent_gemini_budget_wait_seconds_count") == waited + 1


async def test_acquire_gets_a_place_when_the_window_frees() -> None:
    clock = Clock()
    budget = make_budget(clock, GEMINI_TPM_ENFORCE=True)
    block = budget.reserve(950)

    async def sleep(seconds: float) -> None:
        clock.advance(seconds)
        if clock.now >= 1000.4:
            budget.cancel(block)  # идущий ход закончился

    budget._sleep = sleep
    rid = await budget.acquire(100, 1.5)
    assert rid is not None and budget.reserved(rid) == 100
    assert 0.4 <= clock.now - 1000.0 < 1.0


async def test_acquire_waits_out_the_cooldown() -> None:
    clock = Clock()
    budget = make_budget(clock, GEMINI_TPM_ENFORCE=True, GEMINI_QUOTA_COOLDOWN_SECONDS=1)
    budget.on_quota_error("session")
    assert await budget.acquire(100, 0.5) is None  # пауза дольше ожидания
    assert await budget.acquire(100, 1.5) is not None  # пауза кончилась в пределах ожидания


async def test_measure_only_acquire_reserves_at_once() -> None:
    clock = Clock()
    budget = make_budget(clock)
    budget.charge(990)
    assert await budget.acquire(100, 1.5) is not None
    assert clock.now == 1000.0


# ─── Озвучка фраз ─────────────────────────────────────────────────────────────────────────────────────────────────


async def test_tts_fails_fast_during_the_cooldown_without_connecting() -> None:
    connector = FakeConnector()
    budget = make_budget(Clock())
    budget.on_quota_error("open")
    tts = GeminiLiveTts(connector, budget=budget)
    with pytest.raises(TtsError):
        await tts.synthesize("Привет", "male")
    assert connector.open_calls == []


async def test_tts_quota_error_starts_the_cooldown() -> None:
    connector = FakeConnector()
    connector.quota_from = 1
    budget = make_budget(Clock())
    tts = GeminiLiveTts(connector, budget=budget)
    errors, opened = sample("agent_gemini_quota_errors_total", where="tts"), sample("agent_gemini_opens_total", purpose="tts", result="quota")
    with pytest.raises(TtsError):
        await tts.synthesize("Привет", "male")
    assert budget.cooling()
    assert sample("agent_gemini_quota_errors_total", where="tts") == errors + 1
    assert sample("agent_gemini_opens_total", purpose="tts", result="quota") == opened + 1
    with pytest.raises(TtsError):
        await tts.synthesize("Привет", "male")
    assert len(connector.open_calls) == 1  # во время паузы к Google больше не ходим


async def test_tts_open_and_phrase_are_counted_in_the_window() -> None:
    connector = FakeConnector()
    budget = make_budget(Clock(), GEMINI_TPM_LIMIT=100_000)
    tts = GeminiLiveTts(connector, budget=budget)
    await tts.synthesize("Привет", "male")
    assert budget.window_tokens() == estimate_open([VERBATIM_INSTRUCTIONS]) + estimate_turn("Произнеси дословно, без добавлений: «Привет»")
    assert budget.reserved_tokens() == 0
    assert connector.links[0].closed


async def test_fallback_tts_prefers_the_remembered_phrase_then_the_spare_provider() -> None:
    voice, spare = FakeTts(), FakeTts()
    cached = CachedTts(voice, 8)
    await cached.synthesize("Я рядом.", "male")
    voice.calls.clear()
    tts = _FallbackTts(cached, spare)
    assert b"".join([piece async for piece in tts.stream("Я рядом.", "male")])
    assert voice.calls == [] and spare.calls == []  # из памяти, голосом Gemini, без новой сессии
    assert b"".join([piece async for piece in tts.stream("Другая фраза.", "male")])
    assert spare.calls == ["Другая фраза."] and voice.calls == []
    with pytest.raises(TtsError):  # нет ни памяти, ни запасного провайдера
        _ = [piece async for piece in _FallbackTts(cached, None).stream("Третья.", "male")]


def test_live_warm_up_includes_the_template_replies() -> None:
    """В режиме gemini_live прогреваются и шаблонные ответы: ход, отданный шаблону, звучит из памяти без новой сессии Gemini."""
    connector = FakeConnector()
    with TestClient(create_app(None, lambda: (None, None), live_factory=lambda: connector)) as client:
        tts = client.app.state.tts
        assert isinstance(tts, CachedTts)
        wanted = [(voice, part) for phrase in SPOKEN_PHRASES for part in split_sentences(phrase) for voice in ("male", "female")]
        wait_until(lambda: all(tts.remembered(part, voice) for voice, part in wanted), "все фразы озвучены", timeout=10)
    assert {part for phrase in REPLIES for part in split_sentences(phrase)} <= {part for _, part in wanted}


# ─── Режим «только мерить» ────────────────────────────────────────────────────────────────────────────────────────


def test_usage_of_the_turn_replenishes_the_window(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000)
    usage = {"prompt_all": 30_000, "prompt_text": 29_844, "prompt_audio": 156, "response_all": 100, "response_audio": 80}
    connector = FakeConnector(usage=usage)
    with talk(connector, user_id) as (_, ws, budget):
        wait_until(lambda: len(connector.links) == 1, "сессия открыта при подключении")
        assert budget.window_tokens() == open_cost(connector.links[0])  # открытие уже в окне, хотя ходов ещё не было
        say(ws, "c-1", FIRST)
        wait_until(lambda: budget.window_tokens() == 30_000, "usage хода заменил резерв фактом")
        assert budget.reserved_tokens() == 0
        assert sample("agent_gemini_tpm_window_tokens") == 30_000  # то же видит Prometheus


def test_a_small_usage_does_not_count_the_open_twice(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000)
    connector = FakeConnector(usage={"prompt_all": 500, "response_all": 100})
    with talk(connector, user_id) as (_, ws, budget):
        say(ws, "c-1", FIRST)
        link = connector.links[0]
        wait_until(lambda: budget.reserved_tokens() == 0, "usage получен")
        assert budget.window_tokens() == open_cost(link) + estimate_turn(FIRST)  # открытие + приращение хода, не 500 поверх


def test_opens_and_sessions_are_counted(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000)
    connector = FakeConnector(turn_complete=True)
    start, rotate = sample("agent_gemini_opens_total", purpose="start", result="ok"), sample("agent_gemini_opens_total", purpose="rotate", result="ok")
    open_now = sample("agent_gemini_sessions_open")
    with talk(connector, user_id) as (_, ws, _):
        wait_until(lambda: sample("agent_gemini_sessions_open") == open_now + 1, "одна открытая сессия")
        say(ws, "c-1", FIRST)
        wait_until(lambda: len(connector.links) == 2, "смена сессии после ответа")
        wait_until(lambda: connector.links[0].closed, "прежняя закрыта")
        assert sample("agent_gemini_sessions_open") == open_now + 1  # старая закрыта, новая открыта
    wait_until(lambda: sample("agent_gemini_sessions_open") == open_now, "сокет закрыт: сессий нет")
    assert sample("agent_gemini_opens_total", purpose="start", result="ok") == start + 1
    assert sample("agent_gemini_opens_total", purpose="rotate", result="ok") == rotate + 1


def test_quota_refusal_on_open_pauses_the_opens(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000, quota_cooldown_seconds=0.6, tpm_wait_ms=100)
    connector = FakeConnector()
    connector.quota_from, connector.quota_count = 1, 1  # первое открытие — «1011 … exceeded your current quota»
    errors, refused = sample("agent_gemini_quota_errors_total", where="open"), sample("agent_gemini_opens_total", purpose="start", result="quota")
    with talk(connector, user_id) as (_, ws, budget):
        wait_until(budget.cooling, "пауза после 1011")
        assert sample("agent_gemini_budget_level") == 4  # cooldown
        frames = read_frames(ws, lambda f: has(f, "ready"))
        send_user_message(ws, "c-1", FIRST)
        frames += read_frames(ws, lambda f: has(f, "assistant_end"))
        assert has(frames, "error", code="VOICE_UNAVAILABLE")  # как при любом недоступном Gemini: ошибка и шаблон
        assert len(connector.open_calls) == 1  # во время паузы к Google не ходили
        time.sleep(0.7)  # пауза кончилась
        frames = say(ws, "c-2", SECOND)
        assert len(connector.open_calls) == 2 and ("text", SECOND) in connector.links[0].commands
        assert assistant_text(frames) == connector.reply
    assert sample("agent_gemini_quota_errors_total", where="open") == errors + 1
    assert sample("agent_gemini_opens_total", purpose="start", result="quota") == refused + 1


def test_quota_close_in_the_middle_of_a_turn_pauses_the_opens(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000, quota_cooldown_seconds=0.6, tpm_wait_ms=100)
    connector = FakeConnector()
    connector.quota_close_links = {1}  # Google закрывает первую сессию посреди первого хода
    errors = sample("agent_gemini_quota_errors_total", where="session")
    with talk(connector, user_id) as (_, ws, budget):
        send_user_message(ws, "c-1", FIRST)
        frames = read_frames(ws, lambda f: has(f, "assistant_end"))
        assert has(frames, "error", code="VOICE_UNAVAILABLE")
        assert budget.cooling()
        send_user_message(ws, "c-2", SECOND)  # пауза идёт: новое открытие не делается
        read_frames(ws, lambda f: has(f, "assistant_end"))
        assert len(connector.open_calls) == 1
        time.sleep(0.7)
        frames = say(ws, "c-3", THIRD)
        assert len(connector.open_calls) == 2 and assistant_text(frames) == connector.reply
    assert sample("agent_gemini_quota_errors_total", where="session") == errors + 1


def test_rotation_waits_out_the_cooldown(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000, quota_cooldown_seconds=0.5, tpm_wait_ms=100)
    connector = FakeConnector()  # turn_complete шлём сами
    deferred, ok = refreshed("deferred"), refreshed("ok")
    with talk(connector, user_id) as (_, ws, budget):
        say(ws, "c-1", FIRST)
        first = connector.links[0]
        budget.on_quota_error("session")  # другому разговору отказали: пауза у всех
        ws.portal.call(first.push, LiveEvent("turn_complete"))  # ответ дозвучал: пора менять сессию, но сейчас нельзя
        wait_until(lambda: refreshed("deferred") == deferred + 1, "смена отложена")
        assert len(connector.links) == 1 and not first.closed  # прежняя работает, новая не открывается
        time.sleep(0.6)
        say(ws, "c-2", SECOND)  # смена делается в начале следующего хода
        assert len(connector.links) == 2 and first.closed
        assert ("text", SECOND) in connector.links[1].commands
        assert connector.history_calls[1] == [("user", FIRST), ("model", connector.reply)]
    assert refreshed("ok") == ok  # фоновая смена не состоялась: открытие сделал сам ход


def test_a_failed_rotation_keeps_the_old_session(user_id: str, tune: Callable[..., None]) -> None:
    """Прежняя версия закрывала сессию до открытия новой: не открылась — следующий ход шёл в ещё одно обречённое открытие."""
    tune(tpm_limit=400_000, quota_cooldown_seconds=0.5)
    connector = FakeConnector(turn_complete=True)
    connector.quota_from, connector.quota_count = 2, 1  # смена сессии получает 1011
    failed = refreshed("failed")
    with talk(connector, user_id) as (_, ws, budget):
        say(ws, "c-1", FIRST)
        wait_until(lambda: len(connector.open_calls) == 2, "попытка смены")
        wait_until(budget.cooling, "пауза после отказа")
        first = connector.links[0]
        assert not first.closed  # прежняя сессия цела
        wait_until(lambda: refreshed("failed") == failed + 1, "смена записана неудачной")
        time.sleep(0.6)
        frames = say(ws, "c-2", SECOND)
        assert not has(frames, "error")  # человек ничего не заметил
        assert first.closed and ("text", SECOND) in connector.links[1].commands  # ход открыл сессию сам и ушёл на неё


def test_measure_only_keeps_the_behaviour_with_a_full_window(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=1000, tpm_enforce=False)
    connector = FakeConnector()
    live = sample("agent_gemini_admission_total", pipeline="live")
    degraded = sample("agent_gemini_turns_degraded_total", reason="hard")
    with talk(connector, user_id) as (_, ws, budget):
        budget.charge(5000)  # окно вдвое выше лимита
        assert budget.level() == "hard"
        frames = say(ws, "c-1", FIRST)
        assert assistant_text(frames) == connector.reply  # ответ модели, а не шаблон
        assert not budget.trims_history()
    assert sample("agent_gemini_admission_total", pipeline="live") == live + 1
    assert sample("agent_gemini_turns_degraded_total", reason="hard") == degraded


# ─── Допуск нового сокета ─────────────────────────────────────────────────────────────────────────────────────────


def test_exhausted_budget_sends_a_new_socket_to_the_cascade(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=100_000, tpm_enforce=True)
    fallback = cascade(chat=FakeChat(reply="Каскад отвечает вместо Gemini."))
    connector = FakeConnector()
    admitted = sample("agent_gemini_admission_total", pipeline="cascade")
    with make_client(connector, FakeTts(), fallback) as client:
        client.app.state.budget.charge(75_000)  # выше 0,7 от лимита
        dialog_id = start_dialog(client, user_id)["dialogId"]
        with connect(client, user_id, dialog_id) as ws:
            first = say(ws, "c-1", FIRST)
            speak_turn(ws)  # голос тоже разбирает каскад
            second = read_frames(ws, reply_done)
    assert assistant_text(first) == "Каскад отвечает вместо Gemini."
    assert has(second, "transcript", text=fallback.recognizer.text, final=True)
    assert connector.open_calls == [] and connector.links == []  # ни одного открытия Gemini
    assert sample("agent_gemini_admission_total", pipeline="cascade") == admitted + 1
    assert fallback.tts.calls  # озвучка каскада, не Gemini


def test_the_cooldown_sends_a_new_socket_to_the_cascade(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=100_000, tpm_enforce=True, quota_cooldown_seconds=5)
    fallback = cascade()
    connector = FakeConnector()
    with make_client(connector, FakeTts(), fallback) as client:
        client.app.state.budget.on_quota_error("open")
        dialog_id = start_dialog(client, user_id)["dialogId"]
        with connect(client, user_id, dialog_id) as ws:
            frames = say(ws, "c-1", FIRST)
    assert assistant_text(frames) == fallback.chat.reply and connector.open_calls == []


def test_a_new_socket_goes_to_gemini_while_the_budget_has_room(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=100_000, tpm_enforce=True)
    connector = FakeConnector()
    live = sample("agent_gemini_admission_total", pipeline="live")
    with talk(connector, user_id, fallback=cascade()) as (_, ws, budget):
        assert budget.level() == "ok"
        frames = say(ws, "c-1", FIRST)
    assert assistant_text(frames) == connector.reply and len(connector.open_calls) == 1
    assert sample("agent_gemini_admission_total", pipeline="live") == live + 1


def test_without_a_cascade_the_socket_stays_in_gemini(user_id: str, tune: Callable[..., None]) -> None:
    """Каскада нет (модели не настроены): разговор остаётся в Gemini, ходы без бюджета получат шаблон."""
    tune(tpm_limit=100_000, tpm_enforce=True, tpm_wait_ms=100)
    connector = FakeConnector()
    with make_client(connector, FakeTts(), None) as client:
        client.app.state.budget.charge(95_000)
        assert client.app.state.fallback is None
        dialog_id = start_dialog(client, user_id)["dialogId"]
        with connect(client, user_id, dialog_id) as ws:
            send_user_message(ws, "c-1", FIRST)
            frames = read_frames(ws, lambda f: has(f, "assistant_end"))  # озвучить шаблон без Gemini нечем: текст без голоса
    assert assistant_text(frames) in REPLIES and not any(c[0] == "text" for link in connector.links for c in link.commands)
    assert connector.open_calls == []


# ─── Деградация хода ──────────────────────────────────────────────────────────────────────────────────────────────


def test_typed_message_waits_then_gets_a_template_without_gemini(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=100_000, tpm_enforce=True, tpm_wait_ms=150)
    fallback = cascade()
    voice = FakeTts()
    connector = FakeConnector()
    degraded = sample("agent_gemini_turns_degraded_total", reason="hard")
    waited = sample("agent_gemini_budget_wait_seconds_count")
    with talk(connector, user_id, voice, fallback) as (_, ws, budget):
        wait_until(lambda: len(connector.links) == 1, "сессия открыта")
        budget.charge(95_000)
        assert budget.level() == "hard"
        began = time.monotonic()
        frames = say(ws, "c-1", FIRST)
        assert time.monotonic() - began >= 0.15  # ждал места в окне весь срок
        text = assistant_text(frames)
        assert text in REPLIES
        assert not any(c[0] == "text" for c in connector.links[0].commands)  # реплика до Gemini не дошла
        template = split_sentences(text)[0]
        assert template in fallback.tts.calls and template not in voice.calls  # озвучен не Gemini
    assert sample("agent_gemini_turns_degraded_total", reason="hard") == degraded + 1
    assert sample("agent_gemini_budget_wait_seconds_count") == waited + 1


def test_typed_message_waits_for_the_window_and_still_goes_to_gemini(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=100_000, tpm_enforce=True, tpm_wait_ms=1500)
    connector = FakeConnector()
    with talk(connector, user_id, fallback=cascade()) as (_, ws, budget):
        wait_until(lambda: len(connector.links) == 1, "сессия открыта")
        block = budget.reserve(95_000)  # идущий ход занял окно...
        threading.Timer(0.3, budget.cancel, args=(block,)).start()  # ...и освободил его через 0,3 с
        began = time.monotonic()
        frames = say(ws, "c-1", FIRST)
        assert 0.25 <= time.monotonic() - began < 1.4
    assert assistant_text(frames) == connector.reply and ("text", FIRST) in connector.links[0].commands


def test_a_turn_in_the_cooldown_gets_a_template(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=100_000, tpm_enforce=True, tpm_wait_ms=100, quota_cooldown_seconds=2)
    fallback = cascade()
    connector = FakeConnector()
    degraded = sample("agent_gemini_turns_degraded_total", reason="cooldown")
    with talk(connector, user_id, fallback=fallback) as (_, ws, budget):
        wait_until(lambda: len(connector.links) == 1, "сессия открыта")
        budget.on_quota_error("session")
        frames = say(ws, "c-1", FIRST)
        assert assistant_text(frames) in REPLIES
    assert sample("agent_gemini_turns_degraded_total", reason="cooldown") == degraded + 1
    assert len(connector.open_calls) == 1 and not any(c[0] == "text" for c in connector.links[0].commands)


def test_voice_turn_without_budget_is_recognised_by_the_cascade(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=100_000, tpm_enforce=True, tpm_wait_ms=100)
    fallback = cascade(recognizer=FakeRecognizer(text="мне сегодня тяжело"))
    connector = FakeConnector()
    degraded = sample("agent_gemini_turns_degraded_total", reason="hard")
    with talk(connector, user_id, fallback=fallback) as (_, ws, budget):
        wait_until(lambda: len(connector.links) == 1, "сессия открыта")
        link = connector.links[0]
        start_speaking(ws, link)
        budget.charge(95_000)  # пока человек говорил, окно заполнили другие
        ws.send_text(json.dumps({"type": "audio_end"}))
        frames = read_frames(ws, reply_done)
        assert has(frames, "transcript", text="мне сегодня тяжело", final=True)  # реплику разобрал каскад
        assert assistant_text(frames) in REPLIES
        assert ("end",) not in link.commands  # конец реплики Gemini не получил
        assert len(fallback.recognizer.calls) == 1 and len(fallback.recognizer.calls[0]) >= 4 * 3200
        wait_until(lambda: link.closed, "сессия с недосказанной репликой закрыта")
    assert sample("agent_gemini_turns_degraded_total", reason="hard") == degraded + 1


def test_a_crisis_in_a_degraded_voice_turn_is_still_caught(user_id: str, tune: Callable[..., None]) -> None:
    from app.services.replies import CRISIS_REPLY

    tune(tpm_limit=100_000, tpm_enforce=True, tpm_wait_ms=100)
    fallback = cascade(recognizer=FakeRecognizer(text="я больше не хочу жить"))
    connector = FakeConnector()
    with talk(connector, user_id, fallback=fallback) as (_, ws, budget):
        wait_until(lambda: len(connector.links) == 1, "сессия открыта")
        start_speaking(ws, connector.links[0])
        budget.charge(95_000)
        ws.send_text(json.dumps({"type": "audio_end"}))
        frames = read_frames(ws, reply_done)
    assert has(frames, "safety") and assistant_text(frames) == CRISIS_REPLY


def test_a_voice_turn_that_cannot_open_a_session_goes_to_the_cascade(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=100_000, tpm_enforce=True, tpm_wait_ms=100, quota_cooldown_seconds=5, lazy_open=True)
    fallback = cascade(recognizer=FakeRecognizer(text="мне сегодня тяжело"))
    connector = FakeConnector()
    with talk(connector, user_id, fallback=fallback) as (_, ws, budget):
        budget.on_quota_error("open")  # пауза: новую сессию не открыть
        speak_turn(ws)
        frames = read_frames(ws, reply_done)
    assert has(frames, "transcript", text="мне сегодня тяжело", final=True) and assistant_text(frames) in REPLIES
    assert connector.open_calls == []


def test_history_is_shorter_while_the_window_is_high() -> None:
    clock = Clock()
    budget = make_budget(clock, GEMINI_TPM_ENFORCE=True)
    messages = [("u" if i % 2 == 0 else "a", f"м{i}") for i in range(30)]
    session = make_session(FakeConnector(), *messages)
    session._budget = budget
    session._cfg = GeminiSettings.model_validate({"GEMINI_HISTORY_MESSAGES": 40, "GEMINI_HISTORY_MESSAGES_TIGHT": 16})
    assert len(session._history()) == 30  # окно пусто: история целиком
    budget.charge(650)  # 0,65 от лимита: уровень trim
    history = session._history()
    assert len(history) == 16 and history[0] == ("user", "м14") and history[-1] == ("model", "м29")
    budget.charge(300)
    assert len(session._history()) == 16  # и на уровнях выше
    clock.advance(61)
    assert len(session._history()) == 30
    measure = make_budget(clock)  # без ENFORCE история не сокращается
    measure.charge(650)
    session._budget = measure
    assert len(session._history()) == 30


def test_a_new_session_gets_the_short_history_while_the_window_is_high(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=1_000_000, tpm_enforce=True, lazy_open=True, history_messages_tight=16)
    connector = FakeConnector()
    with make_client(connector, FakeTts(), cascade()) as client:
        dialog_id = start_dialog(client, user_id)["dialogId"]
        store = client.app.state.store
        for i in range(30):
            store.add_message(store.get(user_id, dialog_id), "user" if i % 2 == 0 else "assistant", f"м{i}")
        client.app.state.budget.charge(650_000)  # 0,65 от лимита: trim, но новые разговоры ещё идут в Gemini
        with connect(client, user_id, dialog_id) as ws:
            say(ws, "c-1", FIRST)
    history = connector.history_calls[0]
    assert history is not None and len(history) == 16 and history[-1] == ("model", "м29")


def test_history_open_cost_follows_the_shorter_history(tune: Callable[..., None]) -> None:
    clock = Clock()
    budget = make_budget(clock, GEMINI_TPM_ENFORCE=True, GEMINI_TPM_LIMIT=1_000_000)
    messages = [("u" if i % 2 == 0 else "a", "слово " * 200) for i in range(30)]
    session = make_session(FakeConnector(), *messages)
    session._budget = budget
    full = session._open_estimate()
    budget.charge(650_000)
    assert session._open_estimate() < full * 0.7  # меньше истории — дешевле открытие


# ─── Ленивое открытие ─────────────────────────────────────────────────────────────────────────────────────────────


def test_by_default_the_session_is_opened_ahead_and_after_every_answer(user_id: str, tune: Callable[..., None]) -> None:
    """GEMINI_TPM_LIMIT=0 и GEMINI_LAZY_OPEN=false: поведение прежнее."""
    tune(tpm_limit=0, lazy_open=False)
    connector = FakeConnector(turn_complete=True)
    with talk(connector, user_id) as (client, ws, budget):
        assert not budget.enabled
        wait_until(lambda: len(connector.open_calls) == 1, "сессия готова к первой реплике")
        for i, text in enumerate((FIRST, SECOND, THIRD), start=1):
            say(ws, f"c-{i}", text)
            wait_until(lambda n=i: len(connector.open_calls) == n + 1, f"смена сессии после ответа {i}")
    assert len(connector.open_calls) == 4  # на разговор из трёх ходов — четыре открытия, последнее никому не нужно


def test_lazy_open_opens_once_per_turn(user_id: str, tune: Callable[..., None]) -> None:
    tune(lazy_open=True)  # лимит 0: ленивое открытие работает и без бюджета
    connector = FakeConnector(turn_complete=True)
    start, rotate = sample("agent_gemini_opens_total", purpose="start", result="ok"), sample("agent_gemini_opens_total", purpose="rotate", result="ok")
    with talk(connector, user_id) as (_, ws, _):
        frames = read_frames(ws, lambda f: has(f, "tts_end", messageId="greeting"))
        assert has(frames, "tts_start", messageId="greeting")  # приветствие озвучено, а сессия не понадобилась
        time.sleep(0.2)
        assert connector.open_calls == []  # сокет без реплик сессию не открывает
        for i, text in enumerate((FIRST, SECOND, THIRD), start=1):
            say(ws, f"c-{i}", text)
            time.sleep(0.1)
            assert len(connector.open_calls) == i  # открытий столько, сколько ходов: после ответа заранее не открываем
        time.sleep(0.3)
    assert len(connector.open_calls) == 3
    assert [("text", t) in link.commands for link, t in zip(connector.links, (FIRST, SECOND, THIRD), strict=True)] == [True] * 3
    assert [link.closed for link in connector.links[:2]] == [True, True]  # прежняя закрывается, когда новая открыта
    assert connector.history_calls[2] == [("user", FIRST), ("model", connector.reply), ("user", SECOND), ("model", connector.reply)]
    assert sample("agent_gemini_opens_total", purpose="start", result="ok") == start + 1
    assert sample("agent_gemini_opens_total", purpose="rotate", result="ok") == rotate + 2


def test_lazy_open_starts_with_the_first_word_and_hides_behind_the_speech(user_id: str, tune: Callable[..., None]) -> None:
    tune(lazy_open=True)
    connector = FakeConnector(turn_complete=True)
    connector.open_delay = 0.3
    with talk(connector, user_id) as (_, ws, _):
        ws.send_text(json.dumps({"type": "audio_start"}))
        wait_until(lambda: len(connector.open_calls) == 1, "открытие началось с audio_start, до первого кадра звука")
        for i in range(4):
            ws.send_bytes(audio_in_frame(i, loud=True))
        ws.send_text(json.dumps({"type": "audio_end"}))
        frames = read_frames(ws, reply_done)
        assert assistant_text(frames) == connector.reply
        # вторая реплика: сессия меняется, как только человек заговорил, а не сразу после прошлого ответа
        time.sleep(0.2)
        assert len(connector.open_calls) == 1
        ws.send_text(json.dumps({"type": "audio_start"}))
        wait_until(lambda: len(connector.open_calls) == 2, "смена сессии по audio_start")
        for i in range(4):
            ws.send_bytes(audio_in_frame(i, loud=True))
        ws.send_text(json.dumps({"type": "audio_end"}))
        read_frames(ws, reply_done)
    assert len(connector.open_calls) == 2
    assert connector.links[1].history == [("user", connector.heard), ("model", connector.reply)]


def test_a_silent_recording_does_not_open_a_session_lazily_beyond_the_start(user_id: str, tune: Callable[..., None]) -> None:
    tune(lazy_open=True)
    connector = FakeConnector()
    with talk(connector, user_id) as (_, ws, _):
        ws.send_text(json.dumps({"type": "audio_start"}))
        for i in range(5):
            ws.send_bytes(audio_in_frame(i, loud=False))
        ws.send_text(json.dumps({"type": "audio_end"}))
        frames = read_frames(ws, lambda f: has(f, "transcript"))
        assert has(frames, "transcript", text="", final=True)
        time.sleep(0.2)
    commands = [c for link in connector.links for c in link.commands]
    assert commands == []  # до модели ничего не дошло; сессия, открытая по audio_start, не использована, но одна
    assert len(connector.open_calls) <= 1


def test_lazy_open_with_a_cooldown_defers_until_the_next_turn(user_id: str, tune: Callable[..., None]) -> None:
    tune(lazy_open=True, tpm_limit=400_000, quota_cooldown_seconds=0.5, tpm_wait_ms=100)
    connector = FakeConnector()
    with talk(connector, user_id) as (_, ws, budget):
        say(ws, "c-1", FIRST)
        first = connector.links[0]
        budget.on_quota_error("session")
        ws.portal.call(first.push, LiveEvent("turn_complete"))
        time.sleep(0.2)
        assert len(connector.open_calls) == 1 and not first.closed  # пауза: ничего не открываем
        time.sleep(0.5)
        frames = say(ws, "c-2", SECOND)
    assert assistant_text(frames) == connector.reply and len(connector.open_calls) == 2


# ─── Метрики ──────────────────────────────────────────────────────────────────────────────────────────────────────


def test_metrics_exist_and_labels_carry_no_text(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000)
    connector = FakeConnector()
    with talk(connector, user_id) as (_, ws, _):
        say(ws, "c-1", "Секретный текст реплики")
    exposed = generate_latest(REGISTRY).decode()
    for name in (
        "agent_gemini_tpm_window_tokens",
        "agent_gemini_tpm_limit_tokens",
        "agent_gemini_budget_level",
        "agent_gemini_opens_total",
        "agent_gemini_quota_errors_total",
        "agent_gemini_admission_total",
        "agent_gemini_turns_degraded_total",
        "agent_gemini_budget_wait_seconds",
        "agent_gemini_sessions_open",
    ):
        assert name in exposed, name
    assert "Секретный текст" not in exposed and str(uuid.UUID(user_id)) not in exposed
    labels = {
        (family.name, tuple(sorted(s.labels)))
        for family in REGISTRY.collect()
        if family.name.startswith("agent_gemini_")
        for s in family.samples
        if s.labels
    }
    allowed = {"purpose", "result", "where", "pipeline", "reason", "direction", "modality", "le"}
    assert all(set(names) <= allowed for _, names in labels), labels
