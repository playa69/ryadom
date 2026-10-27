"""Сценарии из обратной связи тестировщицы (разговор в проде, 13.10): расшифровка чужого языка вместо «устала», ответ модели
текстом без звука, подсказка языка расшифровки, чужая письменность в ответе, род агента (REQ-GEN-03, REQ-GEN-07).
Поддельная модель, без сети; живая проверка тех же сценариев — scripts/feedback_check.py."""

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app.clients.gemini_live import GeminiLiveConnector, LiveError, LiveEvent, LiveHistory, live_config
from app.core.config import APP_CONFIG, GeminiSettings
from app.services.replies import NOISE_CHECK_CHARS, REPEAT_REQUEST
from tests.conftest import AUTH, FakeTts, has, make_app, read_frames, send_user_message, start_dialog, ws_url
from tests.fake_live import FakeConnector, FakeLink, re_split, reply_done, speak_turn


@pytest.fixture(autouse=True)
def pinned_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.gemini, "history_messages", 40)


def counter(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


class VoicelessLink(FakeLink):
    """Модель присылает расшифровку ответа, но ни одного куска звука (как 4–7% ходов в проде). `hang` — без конца хода."""

    hang = False

    def _respond(self, heard: str | None) -> None:
        if heard:
            self._queue.put_nowait(LiveEvent("input_text", text=heard))
        for piece in re_split(self._reply_text()):
            self._queue.put_nowait(LiveEvent("output_text", text=piece))
        if not self.hang:
            self._queue.put_nowait(LiveEvent("generation_complete"))


class HangingLink(VoicelessLink):
    hang = True


class LinkConnector(FakeConnector):
    link_class: type[FakeLink] = FakeLink

    async def open(  # type: ignore[override]
        self, voice: str, instructions: str, history: LiveHistory | None = None
    ) -> FakeLink:
        self.open_calls.append(voice)
        self.history_calls.append(history)
        link = self.link_class(voice, self.reply, self.heard, instructions, history)
        self.links.append(link)
        return link


def make_client(connector: FakeConnector, tts: FakeTts) -> TestClient:
    return TestClient(make_app(connector, tts))


def history_of(client: TestClient, user_id: str, dialog_id: str) -> list[dict[str, Any]]:
    return client.get(f"/v1/users/{user_id}/dialogs/{dialog_id}", headers=AUTH).json()["messages"]


def assistant_end(frames: list[Any]) -> dict[str, Any]:
    return next(f[1] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_end")


# ─── Ответ без звука ──────────────────────────────────────────────────────────────────────────────────────────────


def test_a_text_only_answer_is_voiced_by_the_agent(user_id: str) -> None:
    """У тестировщицы 5 ответов из ~30 пришли текстом без звука: человек читал, а не слушал. Агент озвучивает тот же текст."""
    connector = LinkConnector(reply="Похоже, это важное для тебя занятие. Что тебе в танцах нравится больше всего?")
    connector.link_class = VoicelessLink
    tts = FakeTts()
    before = counter("agent_live_voiceless_answers_total", outcome="voiced")
    with make_client(connector, tts) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Я хожу на танцы по вечерам")
            frames = read_frames(ws, reply_done)
        end = assistant_end(frames)
        messages = history_of(client, user_id, dialog["dialogId"])
    assert has(frames, "tts_start", messageId=end["messageId"])
    assert sum(1 for f in frames if f[0] == "bin" and f[1][0] == 0x02) >= 2  # звук действительно пошёл клиенту
    assert any("Что тебе в танцах нравится больше всего?" in call for call in tts.calls)  # озвучен именно текст ответа модели
    assert [m["role"] for m in messages] == ["user", "assistant"] and messages[1]["text"] == connector.reply  # шаблона нет
    assert counter("agent_live_voiceless_answers_total", outcome="voiced") == before + 1


def test_a_text_only_answer_is_not_voiced_over_the_person(user_id: str) -> None:
    """Человек заговорил, пока ответ без звука ещё шёл: поверх него агент не озвучивает, текст остаётся."""
    connector = LinkConnector(reply="Это очень интересно. Расскажи ещё.")
    connector.link_class = HangingLink  # ход без конца: его закроет новая реплика
    tts = FakeTts()
    before = counter("agent_live_voiceless_answers_total", outcome="skipped")
    with make_client(connector, tts) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)  # первая реплика: ответ идёт, но не заканчивается
            frames = read_frames(ws, lambda fs: has(fs, "assistant_delta"))
            speak_turn(ws)  # человек заговорил, не дожидаясь конца
            frames += read_frames(ws, lambda fs: has(fs, "assistant_end"))
    first = assistant_end(frames)
    assert first["text"] == connector.reply  # текст дошёл до человека
    assert not has(frames, "tts_start", messageId=first["messageId"])
    assert connector.reply not in " ".join(tts.calls)
    assert counter("agent_live_voiceless_answers_total", outcome="skipped") == before + 1


# ─── Чужой язык вместо русского слова ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("heard", ["usted", "gustala gustala ya gustala", "el primer"])
def test_foreign_noise_gets_a_request_to_repeat_not_the_models_language_lecture(user_id: str, heard: str) -> None:
    """«Устала» расшифровалось как «usted»: модель отвечала «я говорю только по-русски». Теперь её ответ выбрасывается, человека
    просят повторить, а чужое слово в историю не попадает (иначе испанский закрепился бы в контексте следующих ходов)."""
    lecture = "Прости, я пока говорю только по-русски. Давай продолжим по-русски: как ты себя чувствуешь?"
    connector = LinkConnector(reply=lecture, heard=heard)
    tts = FakeTts()
    before = counter("agent_live_repeat_requests_total")
    with make_client(connector, tts) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            frames = read_frames(ws, reply_done)
        messages = history_of(client, user_id, dialog["dialogId"])
    assert has(frames, "transcript", text="", final=True)  # реплика не показана как расслышанная
    end = assistant_end(frames)
    assert end["text"] == REPEAT_REQUEST
    assert has(frames, "tts_start", messageId=end["messageId"])
    assert lecture not in json.dumps([f[1] for f in frames if f[0] == "json"], ensure_ascii=False)
    assert [(m["role"], m["text"]) for m in messages] == [("assistant", REPEAT_REQUEST)]  # реплики человека в истории нет
    assert counter("agent_live_repeat_requests_total") == before + 1


def test_a_good_answer_to_a_foreign_looking_transcript_is_kept(user_id: str) -> None:
    """В живой проверке модель понимала звук и при латинской расшифровке «ustala» и отвечала по делу. Такой ответ нельзя
    выбрасывать: просьба повторить заменяет только лекцию про язык."""
    connector = LinkConnector(reply="Слышу, как ты устала. Что сегодня так вымотало?", heard="ustala")
    before = counter("agent_live_repeat_requests_total")
    with make_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            frames = read_frames(ws, reply_done)
        messages = history_of(client, user_id, dialog["dialogId"])
    assert assistant_end(frames)["text"] == connector.reply
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert counter("agent_live_repeat_requests_total") == before


def test_a_long_good_answer_is_released_before_the_end_of_generation(user_id: str) -> None:
    """Ответ держится, пока не набралось начало (NOISE_CHECK_CHARS): длинный нормальный ответ не ждёт конца генерации."""
    reply = "Слышу, как тебе сейчас непросто. Накопилась сильная усталость, и это совершенно нормально после такого дня."
    connector = LinkConnector(reply=reply, heard="ustala")
    connector.link_class = HangingLink  # конца хода нет
    with make_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            frames = read_frames(ws, lambda fs: has(fs, "assistant_delta"))
    assert len(reply) > NOISE_CHECK_CHARS and has(frames, "assistant_start")  # ответ показан, хотя generation_complete не приходил


def test_a_second_language_answer_in_a_row_goes_through(user_id: str) -> None:
    """Агент уже просил повторить, а ответ снова про язык: возможно, человек правда говорит на другом языке. Не зацикливаемся."""
    lecture = "Прости, я пока говорю только по-русски. Давай продолжим по-русски: как ты себя чувствуешь?"
    connector = LinkConnector(reply=lecture, heard="gustar")
    with make_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            first = read_frames(ws, reply_done)
            speak_turn(ws)
            second = read_frames(ws, reply_done)
    assert assistant_end(first)["text"] == REPEAT_REQUEST
    assert assistant_end(second)["text"] == lecture


@pytest.mark.parametrize(
    "heard",
    [
        "устала",
        "я устала после work",  # русские буквы есть
        "I want to talk about my day today and how it went",  # целая фраза: ответит модель по правилу про язык
    ],
)
def test_real_speech_goes_to_the_model(user_id: str, heard: str) -> None:
    connector = LinkConnector(reply="Слышу тебя. Что сегодня так вымотало?", heard=heard)
    with make_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            frames = read_frames(ws, reply_done)
        messages = history_of(client, user_id, dialog["dialogId"])
    assert has(frames, "transcript", text=heard, final=True)
    assert assistant_end(frames)["text"] == connector.reply
    assert [m["role"] for m in messages] == ["user", "assistant"] and messages[0]["text"] == heard


def test_typed_latin_is_not_noise(user_id: str) -> None:
    """Набранное «ok» человек написал сам: расшифровки тут нет, и просить повторить нечего."""
    connector = LinkConnector(reply="Хорошо. Я рядом.")
    with make_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "ok")
            frames = read_frames(ws, reply_done)
    assert assistant_end(frames)["text"] == connector.reply


class SequenceLink(FakeLink):
    """Ответы модели по очереди: первый ход — первый ответ и т.д. (одна сессия на ход — свой счётчик)."""

    replies: list[str] = []

    def _respond(self, heard: str | None) -> None:
        self._reply = SequenceLink.replies.pop(0) if len(SequenceLink.replies) > 1 else SequenceLink.replies[0]
        super()._respond(heard)


def test_a_repeat_request_said_by_the_model_itself_does_not_disable_the_guard(user_id: str) -> None:
    """Модель сама попросила повторить (своими словами или даже теми же): это не просьба агента, и следующая лекция про язык
    на обрывок чужого языка всё равно заменяется. Пропускается только лекция сразу после просьбы самого агента."""
    lecture = "Прости, я пока говорю только по-русски. Давай продолжим по-русски: как ты себя чувствуешь?"
    SequenceLink.replies = [REPEAT_REQUEST, lecture]
    connector = LinkConnector(heard="usted")
    connector.link_class = SequenceLink
    with make_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            first = read_frames(ws, reply_done)  # ответ модели «повтори» прошёл как есть
            speak_turn(ws)
            second = read_frames(ws, reply_done)
    assert assistant_end(first)["text"] == REPEAT_REQUEST and has(first, "transcript", text="usted", final=True)
    assert assistant_end(second)["text"] == REPEAT_REQUEST and has(second, "transcript", text="", final=True)  # подменён агентом


# ─── Чужая письменность в ответе, род агента ──────────────────────────────────────────────────────────────────────


def test_foreign_script_letters_are_removed_from_the_answer_text(user_id: str) -> None:
    """В живой проверке ответ пришёл с иероглифом: «усталость бывает很 тяжелой». В ленту и в историю он не попадает."""
    connector = LinkConnector(reply="Понимаю, усталость бывает很 тяжелой. Что тебя 你好 вымотало?")
    before = counter("agent_live_foreign_script_total")
    with make_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Устала")
            frames = read_frames(ws, reply_done)
        messages = history_of(client, user_id, dialog["dialogId"])
    end = assistant_end(frames)
    assert end["text"] == "Понимаю, усталость бывает тяжелой. Что тебя вымотало?"
    deltas = "".join(f[1]["text"] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_delta")
    assert deltas == end["text"]  # дельты в сумме по-прежнему ровно текст ответа
    assert messages[-1]["text"] == end["text"]
    assert counter("agent_live_foreign_script_total") == before + 2


def test_strip_foreign_script_keeps_russian_and_latin() -> None:
    from app.services.replies import strip_foreign_script

    assert strip_foreign_script("бывает很 тяжелой") == ("бывает тяжелой", 1)
    assert strip_foreign_script("Окей, это OK и «Hello»") == ("Окей, это OK и «Hello»", 0)
    assert strip_foreign_script("안녕 привет مرحبا")[1] == 2


@pytest.mark.parametrize("voice, rule, wrong", [("male", "«я понял»", "«я поняла»"), ("female", "«я поняла»", "«я понял»")])
def test_the_agent_speaks_of_itself_in_the_gender_of_its_voice(user_id: str, voice: str, rule: str, wrong: str) -> None:
    """При мужском голосе модель говорила о себе «не расслышала»: правило рода берётся из голоса диалога."""
    connector = LinkConnector()
    with make_client(connector, FakeTts()) as client:
        started = client.post(f"/v1/users/{user_id}/dialogs", headers=AUTH, json={"voice": voice}).json()
        with client.websocket_connect(ws_url(user_id, started["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Ты меня понял?")
            read_frames(ws, reply_done)
    instructions = connector.links[-1].instructions
    assert rule in instructions and wrong not in instructions


def test_the_system_prompt_carries_the_gender_rule_of_the_voice() -> None:
    from app.services.replies import SELF_GENDER, SYSTEM_PROMPT, system_prompt

    assert system_prompt("female").startswith(SYSTEM_PROMPT + "\n" + SELF_GENDER["female"])
    assert system_prompt("male").startswith(SYSTEM_PROMPT + "\n" + SELF_GENDER["male"])
    assert system_prompt() == SYSTEM_PROMPT  # без голоса — без правила
    assert REPEAT_REQUEST not in system_prompt("male")  # модель не копирует дословно фразу из примера


# ─── Подсказка языка расшифровки ──────────────────────────────────────────────────────────────────────────────────


def languages(settings: dict[str, Any], **kwargs: Any) -> list[str] | None:
    config = live_config(GeminiSettings.model_validate(settings), "Kore", "промпт", **kwargs)
    return config.input_audio_transcription.language_codes


def test_transcription_language_hint_is_russian_by_default() -> None:
    assert languages({}) == ["ru-RU"]
    assert languages({"GEMINI_INPUT_LANGUAGES": "ru-RU, en-US,ru-RU"}) == ["ru-RU", "en-US"]  # без пробелов и повторов
    assert languages({"GEMINI_INPUT_LANGUAGES": ""}) is None  # подсказку можно выключить
    assert languages({}, language_hint=False) is None  # отказ Google принять поле


def test_session_opens_without_the_hint_when_google_rejects_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """Поле подсказки новое: если Google его отвергнет, голос не должен пропасть, сессии открываются без подсказки."""
    connector = GeminiLiveConnector(GeminiSettings.model_validate({"GEMINI_API_KEY": "test-key"}))
    seen: list[bool] = []

    async def fake_open(voice: str, instructions: str, history: Any, language_hint: bool) -> str:
        seen.append(language_hint)
        if language_hint:
            raise LiveError("Gemini Live не открылся: ConnectionClosedError: 1007 invalid language_codes")
        return "link"

    monkeypatch.setattr(connector, "_open", fake_open)
    assert asyncio.run(connector.open("female", "промпт")) == "link"
    assert seen == [True, False]
    assert asyncio.run(connector.open("female", "промпт")) == "link"
    assert seen == [True, False, False]  # запомнили: повторно отказ не проверяем


def test_other_open_errors_do_not_drop_the_hint(monkeypatch: pytest.MonkeyPatch) -> None:
    connector = GeminiLiveConnector(GeminiSettings.model_validate({"GEMINI_API_KEY": "test-key"}))

    async def fake_open(*args: Any) -> str:
        raise LiveError("Gemini Live не открылся: User location is not supported")

    monkeypatch.setattr(connector, "_open", fake_open)
    with pytest.raises(LiveError):
        asyncio.run(connector.open("male", "промпт"))
    assert languages({}) == ["ru-RU"] and connector._language_hint is True
