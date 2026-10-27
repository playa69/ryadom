"""Режим gemini_live: контекст сессии переносится текстом (GEMINI_TEXT_CONTEXT), а не копится аудио.

Gemini оплачивает весь контекст сессии на каждый ход, поэтому после ответа (turn_complete) агент в фоне открывает свежую
сессию и кладёт в неё прошлые реплики текстом, а старую закрывает. Тесты идут против поддельной модели (tests/test_live.py),
без сети и настоящего Gemini.
"""

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app.api.dialog_live import LiveDialogSession, LiveTurn
from app.clients.gemini_live import GeminiLiveConnector, LiveError, LiveEvent, _translate, live_config
from app.core.config import APP_CONFIG, GeminiSettings
from app.services.dialog_store import DialogStore
from tests.conftest import AUTH, FakeTts, audio_in_frame, has, read_frames, send_user_message, start_dialog, ws_url
from tests.test_live import FakeConnector, FakeLink, make_live_client, reply_done, speak_turn

FIRST, SECOND = "Первая реплика", "Вторая реплика"


@pytest.fixture(autouse=True)
def pinned_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Настройки live не зависят от .env разработчика: по умолчанию контекст переносится текстом."""
    for name, value in (("text_context", True), ("session_resumption", True), ("history_messages", 40), ("rotate_every", 1)):
        monkeypatch.setattr(APP_CONFIG.gemini, name, value)


@pytest.fixture
def without_text_context(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.gemini, "text_context", False)


# ─── Помощники ────────────────────────────────────────────────────────────────────────────────────────────────────


def wait_until(condition: Callable[[], bool], what: str, timeout: float = 3.0) -> None:
    """Ждёт из потока теста, пока приложение (в своём потоке) дойдёт до нужного состояния."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError(f"не дождались: {what}")


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def refreshed(result: str) -> float:
    return sample("agent_gemini_context_refresh_total", result=result)


def tokens(direction: str, modality: str) -> float:
    return sample(
        "agent_model_usage_total", model="fake-live-model", task="live", direction=direction, modality=modality, unit="tokens"
    )


@contextmanager
def talk(connector: FakeConnector, user_id: str) -> Iterator[tuple[TestClient, Any, str]]:
    """Диалог с поддельной моделью: клиент, открытый сокет и id диалога."""
    with make_live_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        dialog_id = dialog["dialogId"]
        with client.websocket_connect(ws_url(user_id, dialog_id), headers=AUTH) as ws:
            try:
                yield client, ws, dialog_id
            finally:
                # TestClient отменяет приложение сразу после выхода из сокета, и уборка сессии иногда рвётся посередине
                # (CancelledError в теле теста). Закрываем сами и ждём конца сессии: тогда отменять уже нечего.
                ws.close(1000)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and client.app.state.store.get(user_id, dialog_id).has_live_socket:
                    time.sleep(0.005)


def two_messages(connector: FakeConnector, user_id: str) -> list[Any]:
    """Две набранные реплики подряд; кадры обоих ответов."""
    with talk(connector, user_id) as (_, ws, _):
        first = say(ws, "c-1", FIRST)
        second = say(ws, "c-2", SECOND)
    return first + second


def say(ws: Any, client_id: str, text: str) -> list[Any]:
    """Набранная реплика и кадры ответа до конца его озвучки."""
    send_user_message(ws, client_id, text)
    return read_frames(ws, reply_done)


def start_speaking(ws: Any, link: FakeLink) -> None:
    """Человек заговорил (реплика ещё не закончена) и первые кадры дошли до модели."""
    ws.send_text(json.dumps({"type": "audio_start"}))
    for i in range(4):
        ws.send_bytes(audio_in_frame(i, loud=True))
    wait_until(lambda: ("start",) in link.commands, "начало речи дошло до модели")


def make_session(connector: FakeConnector, *messages: tuple[str, str]) -> LiveDialogSession:
    """Сессия без сокета: для проверки внутренних шагов (`_history`, `_ensure_link`, `_read`). Роли: "u" и "a"."""
    store = DialogStore()
    dialog, _, _ = store.start(str(uuid.uuid4()))
    for role, text in messages:
        store.add_message(dialog, "user" if role == "u" else "assistant", text)
    return LiveDialogSession(None, store, dialog, lambda: None, connector)  # type: ignore[arg-type]


def test_live_instructions_carry_the_russian_only_rule() -> None:
    """Агент говорит только по-русски и на просьбу переключиться отвечает, что поддерживает только русский."""
    session = make_session(FakeConnector())
    for instructions in (session._instructions(), session._instructions(resumed=True)):
        lower = instructions.lower()
        assert "говори только по-русски" in lower and "поддерживаешь только русский" in lower
        assert "на его языке" not in lower


# ─── Смена сессии после ответа ────────────────────────────────────────────────────────────────────────────────────


def test_session_is_replaced_after_the_answer_and_the_next_phrase_goes_to_the_new_one(user_id: str) -> None:
    connector = FakeConnector(turn_complete=True)
    ok, seconds = refreshed("ok"), sample("agent_gemini_context_refresh_seconds_count")
    with talk(connector, user_id) as (_, ws, _):
        speak_turn(ws)
        read_frames(ws, reply_done)
        wait_until(lambda: len(connector.links) == 2, "новая сессия после ответа")
        first, new = connector.links
        assert connector.history_calls == [None, [("user", connector.heard), ("model", connector.reply)]]
        assert new.history == [("user", connector.heard), ("model", connector.reply)]
        assert first.closed and not new.closed  # старая закрыта, новая живёт
        assert connector.open_calls == [("male", None), ("male", None)]  # handle не используется
        assert connector.heard not in new.instructions  # история отдельными репликами, в промпте её нет
        wait_until(lambda: refreshed("ok") == ok + 1, "метрика ok")
        assert sample("agent_gemini_context_refresh_seconds_count") == seconds + 1

        frames = say(ws, "c-2", SECOND)
    assert not has(frames, "error")
    assert ("text", SECOND) in new.commands and ("text", SECOND) not in first.commands  # следующая реплика ушла на новую ссылку


def test_second_turn_history_has_both_pairs_in_order(user_id: str) -> None:
    connector = FakeConnector(turn_complete=True)
    with talk(connector, user_id) as (_, ws, _):
        say(ws, "c-1", FIRST)
        wait_until(lambda: len(connector.links) == 2, "первая смена сессии")
        say(ws, "c-2", SECOND)
        wait_until(lambda: len(connector.links) == 3, "вторая смена сессии")
        say(ws, "c-3", "Третья реплика")
        wait_until(lambda: len(connector.links) == 4, "третья смена сессии")
    reply = connector.reply
    assert connector.history_calls[1] == [("user", FIRST), ("model", reply)]
    assert connector.history_calls[2] == [("user", FIRST), ("model", reply), ("user", SECOND), ("model", reply)]
    assert connector.links[3].history == [
        ("user", FIRST),
        ("model", reply),
        ("user", SECOND),
        ("model", reply),
        ("user", "Третья реплика"),
        ("model", reply),
    ]
    assert [link.closed for link in connector.links[:3]] == [True, True, True]  # каждая прежняя сессия закрыта


def test_session_lives_for_several_turns_with_rotate_every(user_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """GEMINI_ROTATE_EVERY=3: открытие стоит квоты целиком, поэтому первые две реплики идут на одной сессии, смена после третьей."""
    monkeypatch.setattr(APP_CONFIG.gemini, "rotate_every", 3)
    connector = FakeConnector(turn_complete=True)
    ok = refreshed("ok")
    with talk(connector, user_id) as (_, ws, _):
        say(ws, "c-1", FIRST)
        say(ws, "c-2", SECOND)
        time.sleep(0.3)
        assert len(connector.links) == 1 and not connector.links[0].closed
        assert refreshed("ok") == ok
        say(ws, "c-3", "Третья реплика")
        wait_until(lambda: len(connector.links) == 2, "смена сессии после третьего ответа")
    first, new = connector.links
    assert [c for c in first.commands if c[0] == "text"] == [("text", FIRST), ("text", SECOND), ("text", "Третья реплика")]
    assert first.closed
    assert [role for role, _ in new.history] == ["user", "model"] * 3  # новая сессия получила все три пары текстом


@pytest.mark.parametrize(("audio_tokens", "replaced"), [(500, False), (2000, True)], ids=["little-audio", "audio-piled-up"])
def test_session_is_replaced_early_when_audio_piles_up(
    user_id: str, monkeypatch: pytest.MonkeyPatch, audio_tokens: int, replaced: bool
) -> None:
    """Аудио в контексте сессии (input_audio из usage) дошло до GEMINI_ROTATE_AUDIO_TOKENS: меняем, не дожидаясь числа ходов."""
    monkeypatch.setattr(APP_CONFIG.gemini, "rotate_every", 10)
    monkeypatch.setattr(APP_CONFIG.gemini, "rotate_audio_tokens", 1500)
    connector = FakeConnector(turn_complete=True, usage={"input_text": 1100, "input_audio": audio_tokens})
    with talk(connector, user_id) as (_, ws, _):
        say(ws, "c-1", FIRST)
        if replaced:
            wait_until(lambda: len(connector.links) == 2, "смена сессии: аудио накопилось")
        else:
            time.sleep(0.3)
            assert len(connector.links) == 1 and not connector.links[0].closed


def test_session_is_not_replaced_while_the_person_is_speaking(user_id: str) -> None:
    connector = FakeConnector()  # turn_complete шлём сами
    ok = refreshed("ok")
    with talk(connector, user_id) as (_, ws, _):
        say(ws, "c-1", FIRST)
        first = connector.links[0]
        start_speaking(ws, first)
        ws.portal.call(first.push, LiveEvent("turn_complete"))  # дозвучал прошлый ответ, а человек уже говорит
        time.sleep(0.3)
        assert len(connector.links) == 1 and not first.closed  # посреди его реплики сессию не меняем
        ws.send_text(json.dumps({"type": "audio_end"}))
        read_frames(ws, reply_done)
        assert len(connector.links) == 1
        ws.portal.call(first.push, LiveEvent("turn_complete"))  # теперь на его реплику ответили: можно менять
        wait_until(lambda: len(connector.links) == 2, "смена сессии после ответа на реплику")
    assert [c[0] for c in first.commands] == ["text", "start", "audio", "audio", "audio", "audio", "end"]  # реплика целиком на одной сессии
    assert connector.links[1].history == [
        ("user", FIRST),
        ("model", connector.reply),
        ("user", connector.heard),
        ("model", connector.reply),
    ]
    assert refreshed("ok") == ok + 1


async def test_replacement_is_skipped_while_a_turn_is_open() -> None:
    connector = FakeConnector()
    session = make_session(connector, ("u", FIRST), ("a", "Ответ"))
    link = await session._ensure_link()
    assert link is not None
    assert await session._ensure_link(rotate=True) is link  # на этой сессии ходов ещё не было: менять нечего
    session._link_used = True  # а теперь на ней вёлся ход
    session._voice_turn = LiveTurn(kind="voice")  # человек заговорил, ход ещё не разобран
    assert await session._ensure_link(rotate=True) is link
    session._voice_turn, session._turn = None, LiveTurn(kind="text")  # или ход уже идёт
    assert await session._ensure_link(rotate=True) is link
    assert len(connector.links) == 1 and not link.closed
    session._turn = None  # ходов нет: теперь меняем
    new = await session._ensure_link(rotate=True)
    assert new is not None and new is not link and link.closed
    assert new.history == [("user", FIRST), ("model", "Ответ")]
    assert await session._ensure_link(rotate=True) is new  # у новой сессии ходов нет: цепочки смен не бывает
    assert len(connector.links) == 2
    await session._drop_link()


# ─── История для новой сессии ─────────────────────────────────────────────────────────────────────────────────────

U1, A1, U2, A2, U3, A3, U4 = [("u", "u1"), ("a", "a1"), ("u", "u2"), ("a", "a2"), ("u", "u3"), ("a", "a3"), ("u", "u4")]


@pytest.mark.parametrize(
    ("messages", "limit", "pending", "expected"),
    [
        pytest.param([], 40, False, [], id="empty"),
        pytest.param([U1, A1], 40, False, [("user", "u1"), ("model", "a1")], id="pair"),
        # Реплика, на которую модель промолчала, остаётся: на неё и отвечает свежая сессия (раньше её срезало).
        pytest.param([U1, A1, U2], 40, False, [("user", "u1"), ("model", "a1"), ("user", "u2")], id="unanswered-phrase-kept"),
        # Набранное сообщение, которое сейчас уйдёт модели само, в историю не кладётся: иначе модель получила бы его дважды.
        pytest.param([U1, A1, U2], 40, True, [("user", "u1"), ("model", "a1")], id="pending-typed-message-left-out"),
        pytest.param(
            [U1, A1, U2, ("u", "u2b")], 40, False, [("user", "u1"), ("model", "a1"), ("user", "u2\nu2b")], id="unanswered-phrases-merged"
        ),
        pytest.param(
            [U1, A1, U2, ("u", "u2b")], 40, True, [("user", "u1"), ("model", "a1"), ("user", "u2")], id="only-the-pending-one-left-out"
        ),
        pytest.param([U1], 40, True, [], id="only-the-pending-phrase"),
        pytest.param([U1], 40, False, [("user", "u1")], id="only-an-unanswered-phrase"),
        pytest.param([("a", "привет"), ("a", "ещё"), U1, A1], 40, False, [("user", "u1"), ("model", "a1")], id="leading-model-replies-dropped"),
        pytest.param([("a", "привет")], 40, False, [], id="only-model-replies"),
        pytest.param(
            [U1, U2, A1, A2, U3, A3],
            40,
            False,
            [("user", "u1\nu2"), ("model", "a1\na2"), ("user", "u3"), ("model", "a3")],
            id="same-author-merged",
        ),
        pytest.param(
            [U1, A1, U2, A2, U3, A3, U4],
            4,
            True,
            [("user", "u2"), ("model", "a2"), ("user", "u3"), ("model", "a3")],
            id="limit-keeps-the-last",
        ),
        pytest.param([U1, A1, U2, A2, U3, A3], 3, False, [("user", "u3"), ("model", "a3")], id="limit-cut-at-model-reply"),
        pytest.param([U1, U2, A1], 2, False, [("user", "u2"), ("model", "a1")], id="limit-counts-messages-before-merge"),
        pytest.param([U1, A1, U2], 2, True, [("user", "u1"), ("model", "a1")], id="pending-phrase-is-not-counted"),
        pytest.param([U1, A1, U2, A2, U3, A3], 0, False, [("user", "u1"), ("model", "a1"), ("user", "u2"), ("model", "a2"), ("user", "u3"), ("model", "a3")], id="zero-means-whole-dialog"),
    ],
)
def test_history_for_a_new_session(
    monkeypatch: pytest.MonkeyPatch, messages: list[tuple[str, str]], limit: int, pending: bool, expected: list[tuple[str, str]]
) -> None:
    monkeypatch.setattr(APP_CONFIG.gemini, "history_messages", limit)
    session = make_session(FakeConnector(), *messages)
    if pending:
        session._pending_text_ids.add(session._dialog.messages[-1].id)
    assert session._history() == expected


def test_history_starts_with_the_person_and_alternates_whatever_the_dialog() -> None:
    session = make_session(FakeConnector(), ("a", "x"), U1, U2, A1, A2, A3, U3, A1, U4)
    history = session._history()
    assert history[0][0] == "user"
    assert [role for role, _ in history] == (["user", "model"] * len(history))[: len(history)]  # модель принимает только чередование


# ─── GEMINI_TEXT_CONTEXT=false: прежний путь ──────────────────────────────────────────────────────────────────────


@pytest.mark.usefixtures("without_text_context")
def test_without_text_context_the_session_is_kept_and_history_stays_in_the_prompt(user_id: str) -> None:
    connector = FakeConnector(turn_complete=True)
    ok, failed = refreshed("ok"), refreshed("failed")
    with talk(connector, user_id) as (_, ws, _):
        say(ws, "c-1", FIRST)
        time.sleep(0.3)
        assert len(connector.links) == 1 and not connector.links[0].closed  # turn_complete сессию не меняет
        ws.send_text(json.dumps({"type": "set_voice", "voice": "female"}))  # новое соединение посреди диалога
        say(ws, "c-2", SECOND)
    second = connector.links[1]
    assert connector.history_calls == [None, None]  # open вызывается без history
    assert second.history is None
    assert f"Человек: {FIRST}" in second.instructions and f"Ты: {connector.reply}" in second.instructions
    assert SECOND not in second.instructions
    assert (refreshed("ok"), refreshed("failed")) == (ok, failed)


@pytest.mark.usefixtures("without_text_context")
def test_without_text_context_the_session_is_resumed_by_handle(user_id: str) -> None:
    connector = FakeConnector(after_first_reply="go_away")
    two_messages(connector, user_id)
    assert connector.open_calls == [("male", None), ("male", "handle-1")]
    assert connector.history_calls == [None, None]


def test_instructions_carry_history_only_without_text_context(monkeypatch: pytest.MonkeyPatch) -> None:
    session = make_session(FakeConnector(), ("u", FIRST), ("a", "Ответ"))
    assert "Уже сказано" not in session._instructions()  # история уходит отдельными репликами
    monkeypatch.setattr(APP_CONFIG.gemini, "text_context", False)
    assert f"Человек: {FIRST}\nТы: Ответ" in session._instructions()
    assert "Уже сказано" not in session._instructions(resumed=True)  # возобновлённая сессия помнит сама


@pytest.mark.parametrize("signal", ["go_away", "drop"])
def test_reopening_after_go_away_or_drop_loads_the_text_history_without_handle(user_id: str, signal: str) -> None:
    connector = FakeConnector(after_first_reply=signal)
    frames = two_messages(connector, user_id)
    assert not has(frames, "error")  # человек ничего не заметил
    assert connector.open_calls == [("male", None), ("male", None)]  # handle у text_context не нужен
    second = connector.links[1]
    assert second.history == [("user", FIRST), ("model", connector.reply)]
    assert FIRST not in second.instructions


# ─── Сбои смены сессии ────────────────────────────────────────────────────────────────────────────────────────────


def test_failed_replacement_does_not_break_the_dialog(user_id: str) -> None:
    connector = FakeConnector(turn_complete=True)
    connector.fail_from = 2  # смена сессии после первого ответа не открывается
    ok, failed = refreshed("ok"), refreshed("failed")
    with talk(connector, user_id) as (_, ws, _):
        first_frames = say(ws, "c-1", FIRST)
        wait_until(lambda: refreshed("failed") == failed + 1, "метрика failed")
        assert len(connector.open_calls) == 2 and len(connector.links) == 1
        assert connector.links[0].closed  # старую сессию уже закрыли: не оставляем две
        connector.fail_from, connector.turn_complete = None, False  # Google снова отвечает
        frames = say(ws, "c-2", SECOND)
    assert not has(first_frames, "error") and not has(frames, "error")  # человек сбоя не видит
    assert len(connector.open_calls) == 3  # следующая реплика открыла сессию заново
    recovered = connector.links[1]
    assert recovered.history == [("user", FIRST), ("model", connector.reply)] and ("text", SECOND) in recovered.commands
    assert refreshed("ok") == ok and refreshed("failed") == failed + 1


def test_closing_the_socket_during_a_replacement_does_not_hang(user_id: str) -> None:
    class StuckConnector(FakeConnector):
        """Смена сессии (второе открытие) не заканчивается, пока её не отменят."""

        cancelled = False

        async def open(self, voice, instructions, resume_handle=None, history=None):  # noqa: ANN001, ANN201
            if not self.open_calls:
                return await super().open(voice, instructions, resume_handle, history)
            self.open_calls.append((voice, resume_handle))
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                self.cancelled = True
                raise

    connector = StuckConnector(turn_complete=True)
    with talk(connector, user_id) as (client, ws, dialog_id):
        say(ws, "c-1", FIRST)
        wait_until(lambda: len(connector.open_calls) == 2, "смена сессии началась")
        ws.close(1000)
        wait_until(lambda: not client.app.state.store.get(user_id, dialog_id).has_live_socket, "сессия закончилась")
    assert connector.cancelled  # смену отменили вместе с сеансом
    assert connector.links[0].closed


def test_replacement_is_not_triggered_by_a_session_that_has_not_answered_yet(user_id: str) -> None:
    class AckingConnector(FakeConnector):
        """Сервер подтверждает загрузку истории событием turn_complete, пока человек ещё ничего не сказал: смены сессий
        не должны цепляться одна за другую."""

        async def open(self, voice, instructions, resume_handle=None, history=None):  # noqa: ANN001, ANN201
            link = await super().open(voice, instructions, resume_handle, history)
            if history:
                link.push(LiveEvent("turn_complete"))
            return link

    connector = AckingConnector(turn_complete=True)
    connector.fail_from = 8  # страховка теста: цикл упрётся в отказ открытия
    with talk(connector, user_id) as (_, ws, _):
        say(ws, "c-1", FIRST)
        wait_until(lambda: len(connector.links) >= 2, "первая смена сессии")
        time.sleep(0.3)
    assert len(connector.links) == 2, f"смен сессии без единой реплики человека: {len(connector.links) - 1}"


# ─── Память в сессии ──────────────────────────────────────────────────────────────────────────────────────────────

BRIEF = "Человека зовут Аня, она работает учительницей."
FOUND = "По недавнему вопросу человека в памяти нашлось: экзамены в школе."


class Memory:
    """Память человека для сессии без сокета: сводка из кэша (`text`) и загрузка, которая идёт `delay` секунд."""

    def __init__(self, text: str = "", delay: float = 0.0, loaded: str | None = None, fail: bool = False) -> None:
        self.text = text
        self.delay = delay
        self.loaded = loaded  # сводка, которая окажется в кэше, когда загрузка дойдёт
        self.fail = fail
        self.ready = False
        self.calls = 0

    def brief(self, dialog: Any, count: bool = True) -> str:
        return self.text

    async def prepare(self, dialog: Any) -> None:
        self.calls += 1
        if self.ready:
            return  # уже в кэше: как у Cognee, сразу
        await asyncio.sleep(self.delay)
        if self.fail:
            raise RuntimeError("Cognee не ответил в тесте")
        if self.loaded is not None:
            self.text = self.loaded
        self.ready = True


def with_memory(memory: Memory, connector: FakeConnector, *messages: tuple[str, str]) -> LiveDialogSession:
    session = make_session(connector, *messages)
    session._store.memory = memory  # type: ignore[assignment]
    return session


async def test_slow_memory_does_not_hold_back_the_session(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    """Поиск в Cognee бывает дольше минуты: сессия открывается через MEMORY_WAIT_SECONDS со сводкой, что есть, загрузка
    доходит в фоне и при следующем открытии не начинается заново. Задержка первой сессии — одной строкой в журнале."""
    monkeypatch.setattr("app.api.dialog_live.MEMORY_WAIT_SECONDS", 0.1)
    caplog.set_level(logging.INFO, logger="agent.live")
    connector = FakeConnector()
    memory = Memory(delay=0.6, loaded=BRIEF)
    session = with_memory(memory, connector, ("u", FIRST), ("a", "Ответ"))
    began = time.monotonic()
    link = await session._ensure_link()
    assert link is not None and time.monotonic() - began < 0.4  # загрузку целиком не ждали
    assert BRIEF not in link.instructions
    session._link_used = True
    second = await session._ensure_link(rotate=True)
    assert second is not None and second is not link
    assert memory.calls == 1 and not memory.ready  # ждали ту же загрузку, и её не отменили
    deadline = time.monotonic() + 3
    while not memory.ready and time.monotonic() < deadline:
        await asyncio.sleep(0.02)
    assert memory.ready  # дошла в фоне
    session._link_used = True
    third = await session._ensure_link(rotate=True)
    assert third is not None and BRIEF in third.instructions  # плановая смена взяла догрузившуюся сводку
    first_open = [r.getMessage() for r in caplog.records if r.getMessage().startswith("gemini live first open")]
    assert len(first_open) == 1 and "purpose=start" in first_open[0] and "since_socket_ms=" in first_open[0]
    await session._drop_link()


async def test_a_memory_failure_does_not_stop_the_session() -> None:
    session = with_memory(Memory(fail=True), FakeConnector())
    link = await session._ensure_link()
    assert link is not None and not link.closed
    await session._drop_link()


async def test_a_new_or_grown_brief_waits_for_the_planned_rotation() -> None:
    """Сводка догрузилась после открытия, к ней добавилась находка поиска по реплике или её переписало извлечение: сессия не
    переоткрывается (каждое переоткрытие — пауза в разговоре и потеря звукового контекста), сводку берёт плановая смена."""
    connector = FakeConnector()
    memory = Memory()
    session = with_memory(memory, connector, ("u", FIRST), ("a", "Ответ"))
    link = await session._ensure_link()
    assert link is not None and BRIEF not in link.instructions
    memory.text = BRIEF  # загрузка дошла уже после открытия
    assert await session._ensure_link() is link
    session._link_used = True  # на сессии был ход: плановая смена (GEMINI_ROTATE_EVERY)
    rotated = await session._ensure_link(rotate=True)
    assert rotated is not None and rotated is not link and BRIEF in rotated.instructions
    memory.text = BRIEF + "\n\n" + FOUND  # фоновый поиск по реплике что-то нашёл
    assert await session._ensure_link() is rotated
    memory.text = "Человека зовут Аня."  # извлечение переписало сводку
    assert await session._ensure_link() is rotated
    assert len(connector.links) == 2
    session._link_used = True
    latest = await session._ensure_link(rotate=True)
    assert latest is not None and "Человека зовут Аня." in latest.instructions and FOUND not in latest.instructions
    await session._drop_link()


async def test_a_revoked_brief_reopens_the_session_without_it() -> None:
    """Человек выключил память, забыл всё или стёр аккаунт посреди разговора: следующий ход уже без сводки (MEM-13.3)."""
    connector = FakeConnector()
    memory = Memory(text=BRIEF)
    session = with_memory(memory, connector)
    link = await session._ensure_link()
    assert link is not None and BRIEF in link.instructions
    memory.text = ""
    new = await session._ensure_link()
    assert new is not None and new is not link and link.closed and BRIEF not in new.instructions
    assert await session._ensure_link() is new  # без сводки дальше не переоткрывается
    await session._drop_link()


# ─── usage ────────────────────────────────────────────────────────────────────────────────────────────────────────

USAGE = {"input_text": 300, "input_audio": 1000, "output_audio": 60}


def test_usage_event_is_counted_and_does_not_disturb_the_dialog(user_id: str) -> None:
    connector = FakeConnector(usage=USAGE)
    before = {key: tokens(*key.split("_")) for key in USAGE}
    with talk(connector, user_id) as (_, ws, _):
        frames = say(ws, "c-1", FIRST)
        wait_until(lambda: tokens("input", "audio") == before["input_audio"] + 1000, "токены посчитаны")
    assert not has(frames, "error")
    assert {key: tokens(*key.split("_")) - before[key] for key in USAGE} == USAGE


async def test_usage_event_reaches_the_turn_queue_but_is_counted_once() -> None:
    """Usage проходит очередь хода (для атрибуции к трассе Langfuse в `_handle`), а в Prometheus считается один раз — в `_read`."""
    session = make_session(FakeConnector())
    link = FakeLink("male", "", "", "промпт")
    before = tokens("input", "audio")
    for event in (
        LiveEvent("output_text", text="Привет"),
        LiveEvent("usage", usage={"input_audio": 7}),
        LiveEvent("usage"),  # без токенов: ничего не считаем и не падаем
        LiveEvent("closed"),
    ):
        link.push(event)
    await session._read(link)
    queued = []
    while not session._events.empty():
        queued.append(session._events.get_nowait())
    assert [(source is link, event.kind) for source, event in queued] == [
        (True, "output_text"),
        (True, "usage"),
        (True, "usage"),
        (True, "closed"),
    ]
    assert tokens("input", "audio") == before + 7


def test_usage_metadata_becomes_a_usage_event_before_turn_complete() -> None:
    from google.genai import types as t

    def details(**by_modality: int) -> list[Any]:
        return [t.ModalityTokenCount(modality=t.MediaModality[name.upper()], token_count=count) for name, count in by_modality.items()]

    message = t.LiveServerMessage(
        usage_metadata=t.UsageMetadata(
            prompt_token_count=1300,
            prompt_tokens_details=details(text=300, audio=1000),
            response_token_count=60,
            response_tokens_details=details(audio=60),
        ),
        server_content=t.LiveServerContent(turn_complete=True),
    )
    events = _translate(message)
    assert [event.kind for event in events] == ["usage", "turn_complete"]  # токены посчитаны раньше, чем сессию могут сменить
    assert events[0].usage == USAGE
    assert [e.kind for e in _translate(t.LiveServerMessage(server_content=t.LiveServerContent(turn_complete=True)))] == ["turn_complete"]
    assert _translate(t.LiveServerMessage(usage_metadata=t.UsageMetadata())) == []  # пустой usage события не даёт

    # Итог без полной разбивки: остаток — other (сумма по модальностям равна итогу); размышление — отдельный выход.
    partial = _translate(
        t.LiveServerMessage(
            usage_metadata=t.UsageMetadata(
                prompt_token_count=1350,
                prompt_tokens_details=details(text=300, audio=1000),
                response_token_count=60,
                thoughts_token_count=12,
            )
        )
    )
    assert partial[0].usage == {"input_text": 300, "input_audio": 1000, "input_other": 50, "output_other": 60, "output_thinking": 12}


# ─── Настройки сессии и загрузка истории ──────────────────────────────────────────────────────────────────────────


def test_live_config_with_text_context_has_no_resumption_and_loads_history() -> None:
    on = GeminiSettings.model_validate({"GEMINI_TEXT_CONTEXT": True, "GEMINI_SESSION_RESUMPTION": True})
    config = live_config(on, "Kore", "промпт", "h-1", history=True)
    assert config.session_resumption is None  # возобновлять по handle незачем, даже если он есть
    assert config.history_config is not None and config.history_config.initial_history_in_client_content is True
    assert live_config(on, "Kore", "промпт").history_config is None  # без истории (первая сессия, озвучка фраз) блока нет

    legacy = GeminiSettings.model_validate({"GEMINI_TEXT_CONTEXT": False, "GEMINI_SESSION_RESUMPTION": True})
    resumed = live_config(legacy, "Kore", "промпт", "h-1")
    assert resumed.session_resumption is not None and resumed.session_resumption.handle == "h-1"
    assert resumed.history_config is None


class StubSession:
    def __init__(self, fail: Exception | None = None, hang: bool = False) -> None:
        self.fail, self.hang = fail, hang
        self.sent: list[tuple[Any, bool]] = []

    async def send_client_content(self, *, turns: Any = None, turn_complete: bool = True) -> None:
        if self.hang:
            await asyncio.sleep(3600)
        if self.fail:
            raise self.fail
        self.sent.append((turns, turn_complete))


class StubConnection:
    def __init__(self, session: StubSession) -> None:
        self.session, self.closed = session, False

    async def __aenter__(self) -> StubSession:
        return self.session

    async def __aexit__(self, *exc: object) -> None:
        self.closed = True


class StubClient:
    """Клиент google-genai без сети: запоминает, с чем открывали соединение."""

    session = StubSession()
    connections: list[tuple[Any, StubConnection]] = []

    def __init__(self, **options: Any) -> None:
        self.aio = SimpleNamespace(live=SimpleNamespace(connect=self.connect))

    def connect(self, *, model: str, config: Any) -> StubConnection:
        connection = StubConnection(StubClient.session)
        StubClient.connections.append((config, connection))
        return connection


@pytest.fixture
def stub_connector(monkeypatch: pytest.MonkeyPatch) -> GeminiLiveConnector:
    StubClient.session, StubClient.connections = StubSession(), []
    monkeypatch.setattr("google.genai.Client", StubClient)
    return GeminiLiveConnector(GeminiSettings.model_validate({"GEMINI_API_KEY": "test-key", "GEMINI_TEXT_CONTEXT": True}))


async def test_connector_loads_the_history_as_client_content(stub_connector: GeminiLiveConnector) -> None:
    link = await stub_connector.open("male", "промпт", None, [("user", "Привет"), ("model", "Я рядом"), ("user", "Тяжело")])
    [(config, connection)] = StubClient.connections
    assert config.history_config.initial_history_in_client_content is True and config.session_resumption is None
    ((turns, turn_complete),) = StubClient.session.sent
    assert [(turn.role, turn.parts[0].text) for turn in turns] == [("user", "Привет"), ("model", "Я рядом"), ("user", "Тяжело")]
    assert turn_complete is True
    assert not link.closed and not connection.closed  # соединение осталось открытым для следующей реплики
    await link.aclose()
    assert connection.closed


@pytest.mark.parametrize(("voice", "name"), [("male", "Charon"), ("female", "Kore")])
async def test_connector_always_names_the_voice_to_google(stub_connector: GeminiLiveConnector, voice: str, name: str) -> None:
    """Каждая сессия идёт с явным голосом (speech_config), в том числе без истории и озвучка фразы; имя голоса видно в соединении."""
    for history in (None, [("user", "Привет"), ("model", "Я рядом")]):
        StubClient.connections.clear()
        link = await stub_connector.open(voice, "промпт", None, history)  # type: ignore[arg-type]
        config = StubClient.connections[0][0]
        assert config.speech_config.voice_config.prebuilt_voice_config.voice_name == name
        assert link.voice == voice and link.voice_name == name
        await link.aclose()


@pytest.mark.parametrize(("voice", "name"), [("Aoede", "Aoede"), ("Puck", "Puck")])
async def test_connector_takes_the_voice_the_person_picked_by_name(stub_connector: GeminiLiveConnector, voice: str, name: str) -> None:
    """Выбранное в профиле имя из списка идёт в Google как есть, а ключ голоса сессии — это имя (смена голоса откроет новую сессию)."""
    StubClient.connections.clear()
    link = await stub_connector.open(voice, "промпт")  # type: ignore[arg-type]
    assert StubClient.connections[0][0].speech_config.voice_config.prebuilt_voice_config.voice_name == name
    assert link.voice == voice and link.voice_name == name
    await link.aclose()


async def test_connector_refuses_an_unknown_voice_instead_of_picking_one(stub_connector: GeminiLiveConnector) -> None:
    with pytest.raises(KeyError):
        await stub_connector.open("child", "промпт")  # type: ignore[arg-type]
    assert StubClient.connections == []  # к Google не обращались


async def test_connector_without_history_sends_nothing(stub_connector: GeminiLiveConnector) -> None:
    link = await stub_connector.open("male", "промпт")
    assert StubClient.session.sent == []
    assert StubClient.connections[0][0].history_config is None
    await link.aclose()


async def test_connector_closes_the_connection_when_the_history_is_not_accepted(stub_connector: GeminiLiveConnector) -> None:
    StubClient.session = StubSession(fail=RuntimeError("отказ"))
    with pytest.raises(LiveError):
        await stub_connector.open("male", "промпт", None, [("user", "Привет"), ("model", "Я рядом")])
    assert StubClient.connections[0][1].closed  # наполовину открытую сессию не оставляем


async def test_connector_closes_the_connection_when_the_replacement_is_cancelled(stub_connector: GeminiLiveConnector) -> None:
    StubClient.session = StubSession(hang=True)
    task = asyncio.create_task(stub_connector.open("male", "промпт", None, [("user", "Привет"), ("model", "Я рядом")]))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert StubClient.connections[0][1].closed
