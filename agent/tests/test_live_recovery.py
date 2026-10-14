"""Реплика без ответа модели в gemini_live: шаблонов нет, агент ждёт, не продолжит ли человек, и просит модель ответить ещё раз
в свежей сессии (REQ-GEN-05). Поддельная модель, без сети."""

import time
from typing import Any

import pytest
from prometheus_client import REGISTRY

from app.clients.gemini_live import LiveError, LiveEvent, LiveHistory
from app.core.config import APP_CONFIG
from app.services.replies import REPLIES
from tests.conftest import FakeTts, has, read_frames, send_user_message, start_dialog
from tests.test_gemini_budget import connect
from tests.test_live import FakeConnector, FakeLink, speak_turn
from tests.test_live_feedback import history_of, make_client

HEARD = "мне сегодня тяжело"
REPLY = "Похоже, день выдался тяжёлым. Что сильнее всего выбило из колеи?"


@pytest.fixture(autouse=True)
def pinned_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Как в проде: контекст текстом, сессия на несколько ходов; пауза перед повторной просьбой короткая, чтобы тест не ждал."""
    for name, value in (
        ("text_context", True),
        ("session_resumption", True),
        ("history_messages", 40),
        ("rotate_every", 4),
        ("silence_nudge_ms", 50),
    ):
        monkeypatch.setattr(APP_CONFIG.gemini, name, value)


def counter(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


class QuietLink(FakeLink):
    """Модель, которая молчит: расшифровка реплики приходит, ответа нет (ни звука, ни текста), ход закрыт. Что именно молчит,
    задают поля класса: голос (`silent_voice` первых реплик), набранное (`silent_text`), повторная просьба (`silent_nudge`);
    `drop_voice` — вместо ответа на реплику соединение обрывается."""

    silent_voice = 1
    silent_text = False
    silent_nudge = False
    drop_voice = False

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.voice_turns = 0

    def _silence(self, heard: str | None) -> None:
        if heard:
            self._queue.put_nowait(LiveEvent("input_text", text=heard))
        self._queue.put_nowait(LiveEvent("generation_complete"))
        self._queue.put_nowait(LiveEvent("turn_complete"))

    async def activity_end(self) -> None:
        self.commands.append(("end",))
        self.voice_turns += 1
        if self.drop_voice:
            self._queue.put_nowait(LiveEvent("input_text", text=self._heard))
            self._queue.put_nowait(LiveEvent("closed", text="соединение закрыто Google"))
        elif self.voice_turns <= self.silent_voice:
            self._silence(self._heard)
        else:
            self._respond(self._heard)

    async def send_text(self, text: str) -> None:
        self.commands.append(("text", text))
        self._silence(None) if self.silent_text else self._respond(None)

    async def nudge(self) -> None:
        self.commands.append(("nudge",))
        self._silence(None) if self.silent_nudge else self._respond(None)


class QuietConnector(FakeConnector):
    """Первое соединение — `first` (молчит или рвётся), следующие — `rest`; `fail_from` — с какого открытия (с 1) не открывается."""

    def __init__(self, first: type[QuietLink], rest: type[FakeLink] = FakeLink) -> None:
        super().__init__(reply=REPLY, heard=HEARD)
        self.first, self.rest = first, rest

    async def open(  # type: ignore[override]
        self, voice: str, instructions: str, resume_handle: str | None = None, history: LiveHistory | None = None
    ) -> FakeLink:
        self.open_calls.append((voice, resume_handle))
        self.history_calls.append(history)
        if self.fail_from is not None and len(self.open_calls) >= self.fail_from:
            raise LiveError("Gemini Live не открылся в тесте")
        cls = self.first if not self.links else self.rest
        link = cls(voice, self.reply, self.heard, instructions, resume_handle, history)
        self.links.append(link)
        return link


def ended(frames: list[Any]) -> bool:
    return has(frames, "assistant_end")


def all_commands(connector: FakeConnector) -> list[tuple[Any, ...]]:
    return [command for link in connector.links for command in link.commands]


def run(connector: FakeConnector, user_id: str, act: Any, stop: Any = ended) -> tuple[list[Any], list[dict[str, Any]]]:
    tts = FakeTts()
    with make_client(connector, tts) as client:
        dialog = start_dialog(client, user_id)
        # `connect` сам закрывает сокет и ждёт конца сессии: иначе TestClient отменяет приложение посреди уборки (таймеры
        # повторной просьбы, фоновое открытие сессии), и тело теста изредка падает с CancelledError.
        with connect(client, user_id, dialog["dialogId"]) as ws:
            act(ws)
            frames = read_frames(ws, stop)
        messages = history_of(client, user_id, dialog["dialogId"])
    return frames, messages


def test_silent_model_is_asked_again_in_a_fresh_session_instead_of_a_template(user_id: str) -> None:
    """В проде ~8% ходов модель молчала, и агент подставлял шаблон невпопад. Теперь: пауза, свежая сессия, где последней лежит
    реплика человека, и просьба ответить на неё — ответ по сути, без шаблона."""
    connector = QuietConnector(QuietLink)
    silent, answered = counter("agent_live_unanswered_turns_total", reason="silent"), counter("agent_live_recoveries_total", outcome="answered")
    frames, messages = run(connector, user_id, speak_turn)
    assert len(connector.links) == 2  # свежая сессия
    assert connector.history_calls[-1] == [("user", HEARD)]  # в ней реплика без ответа — последней
    assert ("nudge",) in connector.links[1].commands
    assert [(m["role"], m["text"]) for m in messages] == [("user", HEARD), ("assistant", REPLY)]
    assert not any(m["text"] in REPLIES for m in messages)
    assert has(frames, "transcript", text=HEARD, final=True)
    assert not has(frames, "error")
    assert counter("agent_live_unanswered_turns_total", reason="silent") == silent + 1
    assert counter("agent_live_recoveries_total", outcome="answered") == answered + 1


def test_no_second_request_when_the_person_goes_on_talking(user_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Модель промолчала, потому что человек сделал паузу посреди мысли, и он продолжил сам: переспрашивать модель не нужно,
    она отвечает на продолжение, видя обе реплики."""
    monkeypatch.setattr(APP_CONFIG.gemini, "silence_nudge_ms", 3000)
    connector = QuietConnector(QuietLink)
    continued = counter("agent_live_recoveries_total", outcome="continued")

    def two_turns(ws: Any) -> None:
        speak_turn(ws)
        read_frames(ws, lambda fs: has(fs, "transcript", text=HEARD, final=True))
        speak_turn(ws)

    frames, messages = run(connector, user_id, two_turns)
    assert ("nudge",) not in all_commands(connector)
    # Свежая сессия открыта сразу, пока агент ждал: продолжение ушло в неё, и первая реплика лежит в её истории.
    assert len(connector.links) == 2 and connector.history_calls[-1] == [("user", HEARD)]
    assert ("end",) in connector.links[1].commands
    assert [m["role"] for m in messages] == ["user", "user", "assistant"] and messages[-1]["text"] == REPLY
    assert counter("agent_live_recoveries_total", outcome="continued") == continued + 1


class SilentEverywhere(QuietLink):
    silent_voice = 99
    silent_nudge = True


def test_when_the_model_stays_silent_again_there_is_no_template_and_no_loop(user_id: str) -> None:
    """Модель молчит и на повторную просьбу: шаблона нет и третьей попытки тоже (клиент покажет «думаю…» и вернётся в покой).
    Следующее сообщение человека получает ответ как обычно."""
    connector = QuietConnector(SilentEverywhere, SilentEverywhere)
    unanswered = counter("agent_live_recoveries_total", outcome="unanswered")

    def act(ws: Any) -> None:
        speak_turn(ws)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and counter("agent_live_recoveries_total", outcome="unanswered") == unanswered:
            time.sleep(0.02)
        send_user_message(ws, "c-1", "Ты тут?")  # набранное SilentEverywhere не глушит: на него ответ есть

    frames, messages = run(connector, user_id, act)
    assert counter("agent_live_recoveries_total", outcome="unanswered") == unanswered + 1
    assert sum(1 for command in all_commands(connector) if command == ("nudge",)) == 1
    assert [m["role"] for m in messages] == ["user", "user", "assistant"]
    assert not any(m["text"] in REPLIES for m in messages)
    assert [f[1]["type"] for f in frames if f[0] == "json"].count("assistant_end") == 1


class DroppingLink(QuietLink):
    drop_voice = True


def test_a_dropped_connection_is_recovered_without_an_error_for_the_person(user_id: str) -> None:
    """Соединение оборвалось посреди хода, но слова человека уже расшифрованы: агент открывает новую сессию и получает ответ.
    Ошибку «голос недоступен» человек не видит — ответ пришёл."""
    connector = QuietConnector(DroppingLink)
    failed = counter("agent_live_unanswered_turns_total", reason="failed")
    frames, messages = run(connector, user_id, speak_turn)
    assert not has(frames, "error")
    assert connector.history_calls[-1] == [("user", HEARD)] and ("nudge",) in connector.links[-1].commands
    assert [(m["role"], m["text"]) for m in messages] == [("user", HEARD), ("assistant", REPLY)]
    assert counter("agent_live_unanswered_turns_total", reason="failed") == failed + 1


def test_a_dropped_connection_that_cannot_be_reopened_reports_voice_unavailable(user_id: str) -> None:
    connector = QuietConnector(DroppingLink)
    connector.fail_from = 2
    unavailable = counter("agent_live_recoveries_total", outcome="unavailable")
    frames, messages = run(connector, user_id, speak_turn, lambda fs: has(fs, "error"))
    assert has(frames, "error", code="VOICE_UNAVAILABLE")
    assert not has(frames, "assistant_start")
    assert [m["role"] for m in messages] == ["user"]  # реплика человека сохранена, шаблона нет
    assert counter("agent_live_recoveries_total", outcome="unavailable") == unavailable + 1


class SilentTyped(QuietLink):
    silent_voice = 0
    silent_text = True


def test_a_typed_message_without_an_answer_is_asked_again_at_once(user_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Набранному сообщению ждать продолжения незачем: повторная просьба сразу, в свежей сессии, где сообщение — последнее."""
    monkeypatch.setattr(APP_CONFIG.gemini, "silence_nudge_ms", 10000)  # пауза голоса здесь не действует
    connector = QuietConnector(SilentTyped)
    frames, messages = run(connector, user_id, lambda ws: send_user_message(ws, "c-1", "Мне тревожно"))
    assert connector.links[0].commands == [("text", "Мне тревожно")]  # в первую сессию оно ушло один раз, не в истории
    assert connector.history_calls[0] is None
    assert connector.history_calls[-1] == [("user", "Мне тревожно")] and ("nudge",) in connector.links[-1].commands
    assert [(m["role"], m["text"]) for m in messages] == [("user", "Мне тревожно"), ("assistant", REPLY)]



class InterruptedLink(QuietLink):
    """Первая реплика расшифрована, но ответить модель не успевает: её перебивает новая «реплика». `noise` — та оказалась
    шумом (расшифровки нет, ответ на неё агент выбрасывает), иначе — продолжением со своим ответом."""

    noise = True

    async def activity_end(self) -> None:
        self.commands.append(("end",))
        self.voice_turns += 1
        if self.voice_turns == 1:
            self._queue.put_nowait(LiveEvent("input_text", text=self._heard))  # ответа на неё не будет: её перебьют
        elif self.noise:
            self._queue.put_nowait(LiveEvent("output_text", text="Ответ на шум."))
            self._queue.put_nowait(LiveEvent("generation_complete"))
        else:
            self._respond("и ещё кое-что")


def test_an_answer_lost_to_a_noise_turn_is_asked_for_again(user_id: str) -> None:
    """Живой разговор на стенде: после длинной реплики микрофон поймал шум, новый ход перебил ответ модели, а сам оказался
    пустым — ответ на шум выброшен, и человек 15 с ждал в тишине. Как каскад отвечает на оборванную реплику, когда новая
    оказалась шумом, так и здесь: агент просит модель ответить на первую."""
    connector = QuietConnector(InterruptedLink)
    interrupted = counter("agent_live_unanswered_turns_total", reason="interrupted")

    def two_turns(ws: Any) -> None:
        speak_turn(ws)
        read_frames(ws, lambda fs: has(fs, "audio_end") or True)  # кадр-другой: первая реплика ушла
        speak_turn(ws)

    frames, messages = run(connector, user_id, two_turns)
    assert [(m["role"], m["text"]) for m in messages] == [("user", HEARD), ("assistant", REPLY)]
    assert "Ответ на шум." not in [m["text"] for m in messages]
    assert ("nudge",) in connector.links[-1].commands and connector.history_calls[-1] == [("user", HEARD)]
    assert counter("agent_live_unanswered_turns_total", reason="interrupted") == interrupted + 1


class ContinuedLink(InterruptedLink):
    noise = False


def test_a_real_continuation_answers_both_without_a_second_request(user_id: str) -> None:
    connector = QuietConnector(ContinuedLink)
    continued = counter("agent_live_recoveries_total", outcome="continued")

    def two_turns(ws: Any) -> None:
        speak_turn(ws)
        read_frames(ws, lambda fs: True)
        speak_turn(ws)

    frames, messages = run(connector, user_id, two_turns)
    assert [(m["role"], m["text"]) for m in messages] == [("user", HEARD), ("user", "и ещё кое-что"), ("assistant", REPLY)]
    assert ("nudge",) not in all_commands(connector) and len(connector.links) == 1
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and counter("agent_live_recoveries_total", outcome="continued") == continued:
        time.sleep(0.02)
    assert counter("agent_live_recoveries_total", outcome="continued") == continued + 1
