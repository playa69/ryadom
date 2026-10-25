"""Ответы чат-модели и распознавание речи в диалоге (WebSocket): подмена моделей, запасной шаблон, кризис."""

import json

import pytest

from app.api.dialog_ws import is_silence
from app.services.replies import CRISIS_REPLY, REPLIES, SYSTEM_PROMPT, chat_messages, system_prompt
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

    # Промпт с правилом рода по голосу диалога (по умолчанию мужской).
    assert len(chat.calls) == 1 and chat.calls[0][0]["content"].startswith(system_prompt("male"))
    assert chat.calls[0][1]["role"] == "user" and chat.calls[0][1]["content"].endswith(" Мне плохо")


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
    assert [role for role, _ in roles] == ["user", "assistant", "user"]
    assert [content for _, content in roles] == [m["content"] for m in chat.calls[1][1:]]
    assert roles[0][1].endswith(" раз") and roles[1][1].endswith(" Понимаю.") and roles[2][1].endswith(" два")


def model_unavailable(frames):
    return has(frames, "error", code="AGENT_LLM_UNAVAILABLE")


def test_chat_failure_is_reported_honestly_not_with_a_template(user_id):
    """Шаблон вместо ответа звучал невпопад: он не знает сказанного. Отказ модели — честная ошибка (шлюз покажет «сейчас не
    могу ответить»), в истории только реплика человека."""
    chat = FakeChat(fail=True)
    with make_client(chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Мне плохо")
            frames = read_frames(ws, model_unavailable)
        messages = history(client, user_id, dialog["dialogId"])

    assert "assistant_start" not in types(frames)
    assert [m["role"] for m in messages] == ["user"]


def test_hanging_chat_times_out_into_an_error_not_a_template(user_id):
    chat = FakeChat(delay=30)  # LLM_TIMEOUT_SECONDS=1 в conftest
    with make_client(chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Привет")
            frames = read_frames(ws, model_unavailable)

    assert "assistant_start" not in types(frames)


def test_empty_model_answer_is_an_error_not_a_template(user_id):
    with make_client(chat=FakeChat("")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Привет")
            frames = read_frames(ws, model_unavailable)

    assert "assistant_start" not in types(frames)


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
    assert [m["content"] for m in messages[1:]] == ["[t] m7", "[t] m8", "[t] m9"]  # m6 не открывает окно
    assert messages[1]["role"] == "user"


def test_chat_messages_include_time_context():
    from app.services.dialog_store import Message

    history = [Message("1", "user", "Привет", "2026-10-24T21:01:36.000Z")]
    messages = chat_messages(history, 12)
    assert messages[1]["content"] == "[2026-10-24T21:01:36.000Z] Привет"
    assert "Текущее время:" in messages[0]["content"] and "длительности разговора" in messages[0]["content"]


# ─── Промпт и шаблоны: оффтоп и хорошее настроение ────────────────────────────


def test_chat_messages_carry_the_offtopic_and_good_mood_rules():
    from app.services.dialog_store import Message

    offtopic = [
        Message("1", "user", "Как приготовить лазанью?", "t"),
        Message("2", "assistant", "Это слои пасты, соуса и бешамеля. Кстати, как прошёл твой день?", "t"),
        Message("3", "user", "А при какой температуре?", "t"),
    ]
    messages = chat_messages(offtopic, 12)
    assert messages[0]["role"] == "system" and messages[0]["content"].startswith(SYSTEM_PROMPT)
    # Модель видит свой прошлый ответ: по нему она решает, пора ли снова напоминать.
    assert [m["role"] for m in messages[1:]] == ["user", "assistant", "user"]

    prompt = SYSTEM_PROMPT.lower()
    assert "рецептов" in prompt and "анекдот" in prompt  # оффтоп: по сути и коротко, без пошаговых инструкций
    assert "не переводи разговор насильно на чувства" in prompt  # и без обязательного возврата к «как прошёл день»
    assert "кстати, я здесь в первую очередь" not in prompt and "как прошёл твой день?" not in prompt  # образец копировался
    assert "погоду" in prompt and "скажи прямо" in prompt  # не выдумывает то, чего не знает
    assert "не ищи проблем" in prompt
    assert "эмодзи" in prompt
    # Язык: только русский; на просьбу переключиться агент отвечает, что поддерживает только русский.
    assert "говори только по-русски" in prompt and "поддерживаешь только русский" in prompt
    assert "на его языке" not in prompt  # прежнее правило «отвечай на языке человека» снято


def test_prompt_does_not_push_the_person_off_their_topic_or_into_a_language_lecture():
    """Жалобы по живому разговору: на «устала» (расшифровано как чужое слово) агент трижды читал лекцию про русский язык,
    на «не знаю» предлагал сменить тему, после ответа не по теме тянул к «как прошёл день»."""
    prompt = SYSTEM_PROMPT.lower()
    assert "прости, я пока говорю только по-русски" not in prompt  # готовой фразы-образца на любой непонятный ввод нет
    assert "короткое, тихое или неразборчивое слово" in prompt and "попроси повторить" in prompt
    assert "не говори человеку про язык, пока он сам об этом не заговорил" in prompt
    assert "на «не знаю» не меняй тему" in prompt
    assert "его тема и есть разговор" in prompt
    assert "не начинай сначала" in prompt  # человек снова поздоровался посреди разговора


def test_prompt_lets_the_model_adapt_to_the_person_instead_of_one_formula():
    """В проде 79% ответов кончались вопросом, ответ был в несколько раз длиннее реплики человека, каждый восьмой — с
    «я здесь, чтобы…»; люди жаловались на допрос и повторы. Формула «признай чувство + вопрос» и «одно-три предложения»
    убраны: длина, вопрос и форма — по собеседнику; советов нет, вместо них — помочь разобраться."""
    prompt = SYSTEM_PROMPT.lower()
    assert "подстраивайся под человека" in prompt and "не допрашивай" in prompt
    assert "избегай дежурных оборотов" in prompt and "не рассказывай о своей роли" in prompt
    assert "сначала признай чувство" not in prompt and "одно-три предложения" not in prompt
    # Живая проба первой версии: ответы сжимались ради краткости, и 6 из 11 кончались без продолжения — разговор тянул человек.
    assert "длина — по содержанию, а не по лимиту" in prompt and "три-пять предложений" in prompt
    assert "не длиннее" not in prompt and "просто коротко отзовись" not in prompt
    assert "за что зацепиться" in prompt and "тупик" in prompt  # у каждого ответа есть продолжение
    assert "глубже поверхности" in prompt and "не дежурное «как ты себя чувствуешь»" in prompt
    # Что делать: не советы (даже мягкие), а разбор — что задевает, что спорит, гипотеза, выбор за человеком.
    assert "не говори человеку, что ему делать" in prompt and "можно попробовать" in prompt
    assert "помоги разобраться" in prompt and "гипотезу" in prompt
    assert "две-три простые конкретные идеи" not in prompt
    # Род человека — по его словам, а не мужской по умолчанию; о себе — по голосу (`system_prompt`).
    assert "род человека бери из его собственных слов" in prompt and "не угадывай род собеседника" not in prompt
    # Чего агент не может — прямо; голос выбирают в профиле; на «кто ты» — честно про ИИ.
    assert "в профиле приложения" in prompt and "на основе ии" in prompt


@pytest.mark.parametrize("reply", REPLIES)
def test_template_replies_do_not_assume_a_problem(reply):
    lower = reply.lower()
    for word in ("тяжело", "задело", "обид", "устал", "случилось", "помогло"):
        assert word not in lower
    assert reply.count("?") <= 1  # не больше одного вопроса за реплику


@pytest.mark.parametrize("reply", REPLIES)
def test_template_replies_never_change_the_topic(reply):
    """Шаблон звучит, когда модель промолчала: он не должен звать говорить о чём-то ещё или спрашивать про состояние."""
    lower = reply.lower()
    for phrase in ("о чём", "поговорить", "как ты себя", "как ты сейчас", "как прошёл"):
        assert phrase not in lower
    assert "?" not in reply  # ответа не требует: человек, возможно, ещё договаривает мысль


@pytest.mark.parametrize(
    "heard, noise",
    [
        ("usted", True),  # расшифровка настоящего слова «устала» из живого разговора
        ("gustaba", True),
        ("gustala gustala ya gustala", True),  # «устала устала я устала»: четыре слова
        ("el primer", True),  # «например»
        ("ok", True),
        ("你好", True),
        ("устала", False),
        ("я устала после work", False),  # русские буквы есть
        ("I want to talk about my day today", False),  # целая фраза: до модели, ответ по правилу про язык
        ("I'm so tired today.", False),  # короткая, но настоящая английская речь (живая проверка): не шум
        ("english please", False),
        ("gustar", True),
        ("...", False),  # нет букв: не чужой язык
        ("123", False),
    ],
)
def test_foreign_noise_is_a_few_words_without_russian_letters(heard, noise):
    from app.services.replies import is_foreign_noise

    assert is_foreign_noise(heard) is noise


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
    assert chat.calls[0][-1]["role"] == "user" and chat.calls[0][-1]["content"].endswith(" мне сегодня тяжело")


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
