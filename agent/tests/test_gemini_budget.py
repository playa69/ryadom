"""Учёт входных токенов Gemini Live в минуту (GEMINI_TPM_*, app/services/gemini_budget.py).

Окно, резервы и пауза после отказа Google по квоте (1011) проверяются на подставных часах, без ожидания. Остальное — на
поддельной модели (`FakeConnector` из tests/fake_live.py, с режимом квоты), без сети и без настоящего Gemini: учёт открытий,
пауза, смена сессии. Окно только измеряется: полное окно поведения разговоров не меняет.
"""

import json
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY, generate_latest

from app.clients.gemini_live import (
    VERBATIM_INSTRUCTIONS,
    GeminiLiveTts,
    LiveError,
    LiveEvent,
    LiveHistory,
    is_quota_error,
)
from app.clients.speech import CachedTts, TtsError
from app.core.config import APP_CONFIG, GeminiSettings
from app.main import SPOKEN_PHRASES
from app.services.gemini_budget import TokenBudget, estimate_open, estimate_turn, text_tokens
from app.services.replies import split_sentences
from tests.conftest import AUTH, FakeTts, audio_in_frame, has, make_app, read_frames, send_user_message, start_dialog, ws_url
from tests.fake_live import FakeConnector, FakeLink, reply_done
from tests.test_live_context import refreshed, say, wait_until

FIRST, SECOND, THIRD = "Первая реплика", "Вторая реплика", "Третья реплика"
# Так Google закрывает соединение при своей внутренней ошибке: тот же код 1011, что у отказа по квоте, но без слова «quota».
INTERNAL_1011 = "received 1011 (internal error) Internal error encountered."


# ─── Помощники ────────────────────────────────────────────────────────────────────────────────────────────────────


class Clock:
    """Подставные часы бюджета: время идёт, только когда тест его двигает."""

    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def settings(**env: Any) -> GeminiSettings:
    """Настройки учёта: лимит 1000 токенов; `env` — значения под именами переменных окружения."""
    return GeminiSettings.model_validate({"GEMINI_TPM_LIMIT": 1000, **env})


def make_budget(clock: Clock | None = None, **env: Any) -> TokenBudget:
    clock = clock or Clock()
    return TokenBudget(settings(**env), clock=clock, metrics=False)


class Link:
    """Сессия для учёта: ключ в словаре бюджета должен быть объектом, на который можно сослаться (не голый `object()`)."""


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


@pytest.fixture
def tune(monkeypatch: pytest.MonkeyPatch) -> Callable[..., None]:
    """Настройки Gemini для приложения, созданного после вызова, и всё, что передал тест. `cooldown_wait` — сколько ход ждёт
    конца паузы после 1011 (в бою 1,5 с; тесту столько ждать незачем)."""
    for name, value in (("history_messages", 40), ("rotate_every", 1)):
        monkeypatch.setattr(APP_CONFIG.gemini, name, value)

    def apply(cooldown_wait: float | None = None, **values: Any) -> None:
        for name, value in values.items():
            monkeypatch.setattr(APP_CONFIG.gemini, name, value)
        if cooldown_wait is not None:
            monkeypatch.setattr("app.api.dialog_session.COOLDOWN_WAIT_SECONDS", cooldown_wait)

    return apply


def make_client(connector: FakeConnector, tts: Any = None) -> TestClient:
    return TestClient(make_app(connector, tts))


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
def talk(connector: FakeConnector, user_id: str, tts: Any = None) -> Iterator[tuple[TestClient, Any, TokenBudget]]:
    """Диалог с поддельной моделью и учётом токенов приложения: клиент, открытый сокет и бюджет."""
    with make_client(connector, tts or FakeTts()) as client:
        dialog_id = start_dialog(client, user_id)["dialogId"]
        with connect(client, user_id, dialog_id) as ws:
            yield client, ws, client.app.state.budget


def assistant_text(frames: list[Any]) -> str:
    return next(f[1]["text"] for f in reversed(frames) if f[0] == "json" and f[1]["type"] == "assistant_end")


class RefusingConnector(FakeConnector):
    """Поддельный Gemini, у которого открытия с номерами из `refusals` (с 1) отказывают заданным текстом."""

    def __init__(self, refusals: dict[int, str], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.refusals = refusals

    async def open(
        self, voice: str, instructions: str, history: LiveHistory | None = None
    ) -> FakeLink:
        text = self.refusals.get(len(self.open_calls) + 1)
        if text is None:
            return await super().open(voice, instructions, history)
        self.open_calls.append(voice)
        self.history_calls.append(history)
        raise LiveError(f"Gemini Live не открылся: ConnectionClosedError: {text}")


def open_cost(link: FakeLink) -> int:
    """Во сколько квоты оценено открытие этой сессии: промпт и загруженная история."""
    return estimate_open([link.instructions, *(text for _, text in link.history or ())])


# ─── Настройки и оценки ───────────────────────────────────────────────────────────────────────────────────────────


def test_defaults_are_off_and_only_measure() -> None:
    cfg = GeminiSettings.model_validate({})
    assert cfg.tpm_limit == 0 and cfg.quota_cooldown_seconds == 5 and cfg.tpm_open_factor == 1.0
    # Режимов допуска и деградации нет: окно только измеряется, а поведение внутренних режимов зафиксировано в коде.
    for removed in ("tpm_enforce", "tpm_trim_at", "tpm_admit_at", "tpm_hard_at", "history_messages_tight", "tpm_wait_ms", "lazy_open"):
        assert not hasattr(cfg, removed), removed
    for removed in ("text_context", "session_resumption", "compression"):
        assert not hasattr(cfg, removed), removed


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
    ("text", "quota"),
    [
        pytest.param("Gemini Live не открылся: ConnectionClosedError: received 1011 (internal error) You exceeded your current quota", True),
        # Голый 1011 — внутренняя ошибка Google, а не квота: паузы после него нет.
        pytest.param(f"ConnectionClosedError: {INTERNAL_1011}", False),
        pytest.param("429 RESOURCE_EXHAUSTED", True),
        pytest.param("HTTP 429 Too Many Requests", True),
        pytest.param("ошибка 4290", False),
        pytest.param("соединение закрыто", False),
        pytest.param("Gemini Live не открылся в тесте", False),
        pytest.param("received 1000 (OK)", False),
        pytest.param("ошибка 10110", False),
    ],
)
def test_quota_error_recognition(text: str, quota: bool) -> None:
    assert is_quota_error(text) is quota


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
    assert (budget.window_tokens(), budget.reserved_tokens()) == (0, 150)
    budget.settle(rid, 400)  # пришёл usage: резерв заменён фактом
    assert (budget.window_tokens(), budget.reserved_tokens()) == (400, 0)
    other = budget.reserve(200)
    budget.cancel(other)  # ход не состоялся
    assert (budget.window_tokens(), budget.reserved_tokens()) == (400, 0)
    lost = budget.reserve(300)  # usage так и не пришёл
    assert budget.reserved(lost) == 300
    clock.advance(61)
    assert budget.reserved_tokens() == 0 and budget.reserved(lost) == 0  # через 60 с резерв отслужил своё


def test_disabled_budget_does_nothing() -> None:
    clock = Clock()
    budget = make_budget(clock, GEMINI_TPM_LIMIT=0)
    assert budget.reserve(500) is None
    budget.charge(10_000)
    assert budget.window_tokens() == 0 and budget.open_estimate(["x" * 4000]) == 0
    budget.on_quota_error("open")  # метрика считается, пауза не начинается
    assert not budget.cooling()


def test_a_full_window_changes_nothing() -> None:
    """Окно у лимита и выше его ничего не отсекает: считается и показывается в метриках, решений по нему нет."""
    budget = make_budget(Clock())
    budget.charge(5000)  # впятеро выше лимита
    assert budget.window_tokens() == 5000 and budget.limit() == 1000
    assert budget.reserve(100) is not None and not budget.cooling()


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
        assert budget.cooling()
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


def test_quota_error_does_not_lower_the_limit() -> None:
    """Автокалибровки лимита нет: он нужен только для сравнения с графиком AI Studio и остаётся настроенным."""
    clock = Clock()
    budget = make_budget(clock)
    clock.advance(120)
    budget.charge(800)
    budget.on_quota_error("open")
    assert budget.limit() == 1000


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


async def test_tts_internal_error_1011_does_not_start_the_cooldown() -> None:
    connector = RefusingConnector({1: INTERNAL_1011}, turn_complete=True)
    budget = make_budget(Clock())
    tts = GeminiLiveTts(connector, budget=budget)
    errors = sample("agent_gemini_quota_errors_total", where="tts")
    with pytest.raises(TtsError):
        await tts.synthesize("Привет", "male")
    assert not budget.cooling()
    assert await tts.synthesize("Привет", "male")  # следующая фраза идёт сразу, без паузы
    await tts.drained()
    assert len(connector.open_calls) == 2
    assert sample("agent_gemini_quota_errors_total", where="tts") == errors


async def test_tts_open_and_phrase_are_counted_in_the_window() -> None:
    connector = FakeConnector()
    budget = make_budget(Clock(), GEMINI_TPM_LIMIT=100_000)
    tts = GeminiLiveTts(connector, budget=budget)
    await tts.synthesize("Привет", "male")
    await tts.drained()  # расход фразы дочитывается в фоне, после чего резерв закрывается
    assert budget.window_tokens() == estimate_open([VERBATIM_INSTRUCTIONS]) + estimate_turn("Произнеси дословно, без добавлений: «Привет»")
    assert budget.reserved_tokens() == 0
    assert connector.links[0].closed


def test_live_warm_up_has_the_fixed_phrases() -> None:
    """В режиме gemini_live прогреваются готовые фразы (приветствия, кризисный ответ, просьба повторить)."""
    # turn_complete после фразы, как у Google: прогрев ждёт закрытия сессии фразы, прежде чем открыть следующую.
    connector = FakeConnector(turn_complete=True)
    with TestClient(make_app(connector, real_tts=True)) as client:
        tts = client.app.state.tts
        assert isinstance(tts, CachedTts)
        wanted = [(voice, part) for phrase in SPOKEN_PHRASES for part in split_sentences(phrase) for voice in ("male", "female")]
        wait_until(lambda: all(tts.remembered(part, voice) for voice, part in wanted), "все фразы озвучены", timeout=10)


# ─── Режим «только мерить» ────────────────────────────────────────────────────────────────────────────────────────


def test_usage_of_the_turn_replenishes_the_window(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000)
    usage = {"input_text": 29_844, "input_audio": 156, "output_audio": 80, "output_text": 20}
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
    connector = FakeConnector(usage={"input_text": 344, "input_audio": 156, "output_audio": 100})
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
    tune(tpm_limit=400_000, quota_cooldown_seconds=0.6, cooldown_wait=0.1)
    connector = FakeConnector()
    connector.quota_from, connector.quota_count = 1, 1  # первое открытие — «1011 … exceeded your current quota»
    errors, refused = sample("agent_gemini_quota_errors_total", where="open"), sample("agent_gemini_opens_total", purpose="start", result="quota")
    with talk(connector, user_id) as (_, ws, budget):
        wait_until(budget.cooling, "пауза после 1011")
        frames = read_frames(ws, lambda f: has(f, "ready"))
        send_user_message(ws, "c-1", FIRST)
        frames += read_frames(ws, lambda f: has(f, "error"))
        # Повторная попытка тоже упирается в паузу: ошибка, как при любом недоступном Gemini, и без шаблона.
        assert has(frames, "error", code="VOICE_UNAVAILABLE") and not has(frames, "assistant_start")
        assert len(connector.open_calls) == 1  # во время паузы к Google не ходили
        time.sleep(0.7)  # пауза кончилась
        frames = say(ws, "c-2", SECOND)
        assert len(connector.open_calls) == 2 and ("text", SECOND) in connector.links[0].commands
        assert assistant_text(frames) == connector.reply
    assert sample("agent_gemini_quota_errors_total", where="open") == errors + 1
    assert sample("agent_gemini_opens_total", purpose="start", result="quota") == refused + 1


def test_quota_close_in_the_middle_of_a_turn_pauses_the_opens(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000, quota_cooldown_seconds=0.6, cooldown_wait=0.1)
    connector = FakeConnector()
    connector.quota_close_links = {1}  # Google закрывает первую сессию посреди первого хода
    errors = sample("agent_gemini_quota_errors_total", where="session")
    unavailable = sample("agent_live_recoveries_total", outcome="unavailable")
    with talk(connector, user_id) as (_, ws, budget):
        send_user_message(ws, "c-1", FIRST)
        frames = read_frames(ws, lambda f: has(f, "error"))  # повторная попытка упёрлась в паузу: ошибка, шаблона нет
        assert has(frames, "error", code="VOICE_UNAVAILABLE") and not has(frames, "assistant_start")
        assert budget.cooling()
        send_user_message(ws, "c-2", SECOND)  # пауза идёт: новое открытие не делается
        read_frames(ws, lambda f: has(f, "ack"))
        wait_until(
            lambda: sample("agent_live_recoveries_total", outcome="unavailable") >= unavailable + 2, "и вторая реплика упёрлась в паузу"
        )
        assert len(connector.open_calls) == 1
        time.sleep(0.7)
        frames = say(ws, "c-3", THIRD)
        assert len(connector.open_calls) == 2 and assistant_text(frames) == connector.reply
    assert sample("agent_gemini_quota_errors_total", where="session") == errors + 1


def test_internal_error_1011_on_open_does_not_pause_the_opens(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000, quota_cooldown_seconds=5, cooldown_wait=0.1)
    connector = RefusingConnector({1: INTERNAL_1011})  # первое открытие — внутренняя ошибка Google, не квота
    errors = sample("agent_gemini_quota_errors_total", where="open")
    with talk(connector, user_id) as (_, ws, budget):
        wait_until(lambda: len(connector.open_calls) == 1, "первое открытие отказало")
        assert not budget.cooling()
        send_user_message(ws, "c-1", FIRST)
        frames = read_frames(ws, lambda f: reply_done(f) or has(f, "error"))
        assert not has(frames, "error") and assistant_text(frames) == connector.reply  # ход открыл сессию сразу
        assert len(connector.open_calls) == 2
    assert sample("agent_gemini_quota_errors_total", where="open") == errors


def test_internal_error_1011_in_the_middle_of_a_turn_is_answered_without_a_pause(
    user_id: str, tune: Callable[..., None], monkeypatch: pytest.MonkeyPatch
) -> None:
    tune(tpm_limit=400_000, quota_cooldown_seconds=5, cooldown_wait=0.1)
    monkeypatch.setattr("tests.fake_live.QUOTA_TEXT", INTERNAL_1011)  # сессию посреди хода закрывает внутренняя ошибка
    connector = FakeConnector()
    connector.quota_close_links = {1}
    errors = sample("agent_gemini_quota_errors_total", where="session")
    with talk(connector, user_id) as (_, ws, budget):
        send_user_message(ws, "c-1", FIRST)
        frames = read_frames(ws, lambda f: reply_done(f) or has(f, "error"))
        assert not budget.cooling()
        # Повторная просьба ответить ушла в свежую сессию сразу, а не после паузы.
        assert not has(frames, "error") and assistant_text(frames) == connector.reply
        assert len(connector.open_calls) == 2
    assert sample("agent_gemini_quota_errors_total", where="session") == errors


def test_rotation_waits_out_the_cooldown(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=400_000, quota_cooldown_seconds=0.5, cooldown_wait=0.1)
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


def test_a_full_window_keeps_the_behaviour_of_the_dialog(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=1000)
    connector = FakeConnector()
    with talk(connector, user_id) as (_, ws, budget):
        budget.charge(5000)  # окно вдвое выше лимита
        frames = say(ws, "c-1", FIRST)
        assert assistant_text(frames) == connector.reply  # ответ модели: ни шаблона, ни отказа
        assert ("text", FIRST) in connector.links[0].commands


# ─── Открытие сессии заранее ─────────────────────────────────────────────────────────────────────────────────────


def test_the_session_is_opened_ahead_and_after_every_answer(user_id: str, tune: Callable[..., None]) -> None:
    """Сессия готова к первой реплике (открывается при подключении сокета) и меняется после каждого ответа."""
    tune(tpm_limit=0)
    connector = FakeConnector(turn_complete=True)
    with talk(connector, user_id) as (client, ws, budget):
        assert not budget.enabled
        wait_until(lambda: len(connector.open_calls) == 1, "сессия готова к первой реплике")
        for i, text in enumerate((FIRST, SECOND, THIRD), start=1):
            say(ws, f"c-{i}", text)
            wait_until(lambda n=i: len(connector.open_calls) == n + 1, f"смена сессии после ответа {i}")
    assert len(connector.open_calls) == 4  # на разговор из трёх ходов — четыре открытия, последнее никому не нужно


def test_a_silent_recording_does_not_open_a_session_beyond_the_start(user_id: str, tune: Callable[..., None]) -> None:
    tune(tpm_limit=0)
    connector = FakeConnector()
    with talk(connector, user_id) as (_, ws, _):
        wait_until(lambda: len(connector.open_calls) == 1, "сессия готова к первой реплике")
        ws.send_text(json.dumps({"type": "audio_start"}))
        for i in range(5):
            ws.send_bytes(audio_in_frame(i, loud=False))
        ws.send_text(json.dumps({"type": "audio_end"}))
        frames = read_frames(ws, lambda f: has(f, "transcript"))
        assert has(frames, "transcript", text="", final=True)
        time.sleep(0.2)
    commands = [c for link in connector.links for c in link.commands]
    assert commands == []  # до модели ничего не дошло
    assert len(connector.open_calls) == 1  # а сессия, открытая заранее, одна


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
        "agent_gemini_opens_total",
        "agent_gemini_quota_errors_total",
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
    allowed = {"purpose", "result", "where", "reason", "direction", "modality", "le"}
    assert all(set(names) <= allowed for _, names in labels), labels
