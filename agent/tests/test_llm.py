"""Ответы чат-модели и распознавание речи в диалоге (WebSocket): подмена моделей, запасной шаблон, кризис."""

import json

import pytest

from app.api.dialog_ws import is_silence
from app.services.replies import CRISIS_REPLY, REPLIES, SYSTEM_PROMPT, chat_messages
from tests.conftest import (
    AUTH,
    FakeChat,
    FakeRecognizer,
    audio_in_frame,
    has,
    make_client,
    read_frames,
    send_user_message,
    start_dialog,
    types,
    ws_url,
)


def reply_done(frames):
    return has(frames, "assistant_end")


def final_text(frames) -> str:
    return next(b["text"] for k, b in frames if k == "json" and b["type"] == "assistant_end")


def history(client, user_id, dialog_id):
    return client.get(f"/v1/users/{user_id}/dialogs/{dialog_id}", headers=AUTH).json()["messages"]


def speak(ws, frames: int = 10, loud: bool = True) -> None:
    ws.send_text(json.dumps({"type": "audio_start"}))
    for n in range(frames):
        ws.send_bytes(audio_in_frame(n, loud=loud))
    ws.send_text(json.dumps({"type": "audio_end"}))


# ─── Чат ──────────────────────────────────────────────────────────────────────


def test_reply_comes_from_the_chat_model_and_sees_the_dialog(user_id):
    chat = FakeChat("Слышу, как тебе тяжело. Что случилось?")
    with make_client(chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Мне плохо")
            frames = read_frames(ws, reply_done)

        assert final_text(frames) == "Слышу, как тебе тяжело. Что случилось?"
        deltas = "".join(b["text"] for k, b in frames if k == "json" and b["type"] == "assistant_delta")
        assert deltas == final_text(frames)  # стрим и итог совпадают и для ответа модели
        assert [m["role"] for m in history(client, user_id, dialog["dialogId"])] == ["user", "assistant"]

    assert chat.calls == [[{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": "Мне плохо"}]]


def test_second_turn_carries_the_whole_conversation(user_id):
    chat = FakeChat("Понимаю.")
    with make_client(chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "раз")
            read_frames(ws, reply_done)
            send_user_message(ws, "c-2", "два")
            read_frames(ws, reply_done)

    roles = [(m["role"], m["content"]) for m in chat.calls[1][1:]]
    assert roles == [("user", "раз"), ("assistant", "Понимаю."), ("user", "два")]


def test_chat_failure_falls_back_to_a_template_reply(user_id):
    chat = FakeChat(fail=True)
    with make_client(chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Мне плохо")
            frames = read_frames(ws, reply_done)

    assert final_text(frames) == REPLIES[0]
    assert "error" not in types(frames)  # человек не должен видеть отказ модели: ответ просто шаблонный


def test_hanging_chat_times_out_into_a_template_reply(user_id):
    chat = FakeChat(delay=30)  # LLM_TIMEOUT_SECONDS=1 в conftest
    with make_client(chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Привет")
            frames = read_frames(ws, reply_done)

    assert final_text(frames) == REPLIES[0]


def test_empty_model_answer_falls_back_to_a_template_reply(user_id):
    with make_client(chat=FakeChat("")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Привет")
            frames = read_frames(ws, reply_done)

    assert final_text(frames) == REPLIES[0]


def test_crisis_never_reaches_the_chat_model(user_id):
    chat = FakeChat("это не должно прозвучать")
    with make_client(chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Я больше не хочу жить")
            frames = read_frames(ws, reply_done)

    assert has(frames, "safety")
    assert final_text(frames) == CRISIS_REPLY
    assert chat.calls == []


def test_chat_messages_start_with_the_person_and_are_limited():
    from app.services.dialog_store import Message

    history_ = [Message(str(i), "assistant" if i % 2 == 0 else "user", f"m{i}", "t") for i in range(10)]
    messages = chat_messages(history_, 4)
    assert messages[0]["role"] == "system"
    assert [m["content"] for m in messages[1:]] == ["m7", "m8", "m9"]  # m6 — ответ агента, он не может открывать окно
    assert messages[1]["role"] == "user"


# ─── Промпт и шаблоны: оффтоп и хорошее настроение ────────────────────────────


def test_chat_messages_carry_the_offtopic_and_good_mood_rules():
    from app.services.dialog_store import Message

    offtopic = [
        Message("1", "user", "Как приготовить лазанью?", "t"),
        Message("2", "assistant", "Это слои пасты, соуса и бешамеля. Кстати, как прошёл твой день?", "t"),
        Message("3", "user", "А при какой температуре?", "t"),
    ]
    messages = chat_messages(offtopic, 12)
    assert messages[0] == {"role": "system", "content": SYSTEM_PROMPT}
    # Модель видит свой прошлый ответ: по нему она решает, пора ли снова напоминать.
    assert [m["role"] for m in messages[1:]] == ["user", "assistant", "user"]

    prompt = SYSTEM_PROMPT.lower()
    assert "одно-два предложения" in prompt and "рецептов" in prompt  # оффтоп: кратко, без пошаговых инструкций
    assert "без отказа" in prompt
    assert "погоду" in prompt and "не видишь" in prompt  # не выдумывает то, чего не знает
    assert "как прошёл день или что на душе" in prompt  # возврат к эмоциям
    assert "раз в две-три реплики, не в каждой" in prompt
    assert "порадуйся" in prompt and "есть ли ещё что-то" in prompt  # хорошее настроение
    assert "не ищи проблем" in prompt
    assert "и радость тоже" in prompt  # «сначала признай чувство» — и для радости
    # Голосовой формат и прежние правила на месте.
    assert "одно-три предложения" in prompt and "эмодзи" in prompt and "не задавай два вопроса" in prompt


@pytest.mark.parametrize("reply", REPLIES)
def test_template_replies_do_not_assume_a_problem(reply):
    lower = reply.lower()
    for word in ("тяжело", "задело", "обид", "устал", "случилось", "помогло"):
        assert word not in lower
    assert reply.count("?") <= 1  # не больше одного вопроса за реплику


def test_good_mood_in_template_mode_gets_a_neutral_reply(user_id):
    with make_client() as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "У меня был прекрасный день!")
            frames = read_frames(ws, reply_done)

    assert not has(frames, "safety")
    assert final_text(frames) == REPLIES[0]


# ─── Распознавание речи ───────────────────────────────────────────────────────


def test_voice_is_recognized_and_answered_by_the_model(user_id):
    chat, stt = FakeChat("Слышу тебя."), FakeRecognizer("мне сегодня тяжело")
    with make_client(chat=chat, recognizer=stt) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=10)
            frames = read_frames(ws, reply_done)

        transcript = next(b for k, b in frames if k == "json" and b["type"] == "transcript")
        assert transcript["text"] == "мне сегодня тяжело" and transcript["final"] is True and transcript["messageId"]
        assert "ack" not in types(frames)
        messages = history(client, user_id, dialog["dialogId"])
        assert [(m["role"], m["text"]) for m in messages] == [("user", "мне сегодня тяжело"), ("assistant", "Слышу тебя.")]

    assert len(stt.calls) == 1 and len(stt.calls[0]) == 10 * 3200  # ровно звук кадров, без заголовков
    assert chat.calls[0][-1] == {"role": "user", "content": "мне сегодня тяжело"}


def test_recognized_crisis_is_handled_like_typed_crisis(user_id):
    chat = FakeChat("не должно прозвучать")
    with make_client(chat=chat, recognizer=FakeRecognizer("я не хочу жить")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws)
            frames = read_frames(ws, reply_done)

    assert has(frames, "safety") and final_text(frames) == CRISIS_REPLY
    assert chat.calls == []


def test_recognition_failure_gives_voice_unavailable_and_no_message(user_id):
    with make_client(chat=FakeChat(), recognizer=FakeRecognizer(fail=True)) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws)
            frames = read_frames(ws, lambda f: has(f, "error"))
            # сокет живой: следующая реплика работает
            send_user_message(ws, "c-1", "я тут")
            after = read_frames(ws, reply_done)

        assert has(frames, "error", code="VOICE_UNAVAILABLE")
        assert "transcript" not in types(frames)
        assert len(history(client, user_id, dialog["dialogId"])) == 2  # только текстовый обмен
    assert types(after)[0] == "ack"


def test_empty_recognition_is_silence(user_id):
    chat = FakeChat()
    with make_client(chat=chat, recognizer=FakeRecognizer("")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws)
            frames = read_frames(ws, lambda f: has(f, "transcript"))

        assert next(b for k, b in frames if k == "json" and b["type"] == "transcript") == {
            "v": 1,
            "type": "transcript",
            "text": "",
            "final": True,
        }
        assert history(client, user_id, dialog["dialogId"]) == []
    assert chat.calls == []


def test_quiet_recording_never_reaches_whisper(user_id):
    stt = FakeRecognizer("Продолжение следует...")  # так whisper «слышит» тишину
    with make_client(chat=FakeChat(), recognizer=stt) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, loud=False)
            frames = read_frames(ws, lambda f: has(f, "transcript"))

        assert next(b for k, b in frames if k == "json" and b["type"] == "transcript")["text"] == ""
        assert history(client, user_id, dialog["dialogId"]) == []
    assert stt.calls == []


def test_without_models_voice_is_a_placeholder_and_replies_are_templates(user_id):
    with make_client() as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=30, loud=False)
            frames = read_frames(ws, reply_done)

    transcript = next(b for k, b in frames if k == "json" and b["type"] == "transcript")
    assert transcript["text"] == "[голосовая реплика, 3 с]" and transcript["messageId"]
    assert final_text(frames) == REPLIES[0]


def test_cancel_is_not_blocked_by_a_slow_recognition(user_id):
    """Распознавание идёт в очереди, а сокет продолжает читать: tts_cancel и другие кадры не ждут его."""

    class SlowRecognizer(FakeRecognizer):
        async def transcribe(self, pcm: bytes) -> str:
            import asyncio

            await asyncio.sleep(0.3)
            return await super().transcribe(pcm)

    with make_client(chat=FakeChat(), recognizer=SlowRecognizer("привет")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws)
            ws.send_text(json.dumps({"type": "tts_cancel", "messageId": "nothing"}))  # принят сразу, без ожидания
            frames = read_frames(ws, reply_done)

    assert has(frames, "transcript", text="привет")


# ─── Тишина ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("pcm", "silent"),
    [(b"", True), (bytes(3200), True), (b"\x01\x00" * 1600, True), (b"\xb8\x0b" * 1600, False)],
)
def test_is_silence(pcm, silent):
    assert is_silence(pcm) is silent
