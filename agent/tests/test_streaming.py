"""Потоковый ответ: предложения уходят в текст и озвучку, пока модель пишет; оборванная реплика ждёт; эхо агента."""

import asyncio
import json
import re
import struct
import time

import httpx
import pytest
from prometheus_client import REGISTRY

from app.clients.llm import ModelError, ProxyChat, ReplyTruncated
from app.clients.speech import FRAME_BYTES, CachedTts, QwenTts, TtsError, pcm_stream
from app.services.dialog_store import Message
from app.services.replies import (
    chat_messages,
    is_echo,
    looks_unfinished,
    split_sentences,
    take_sentences,
)
from tests.conftest import (
    AUTH,
    FakeChat,
    FakeRecognizer,
    FakeTts,
    audio_in_frame,
    has,
    make_client,
    read_frames,
    send_user_message,
    start_dialog,
    types,
    ws_url,
)

HOLD_SECONDS = 0.4  # INCOMPLETE_HOLD_MS в conftest


def reply_done(frames):
    return has(frames, "assistant_end")


def speak(ws, frames: int = 3, loud: bool = True) -> None:
    ws.send_text(json.dumps({"type": "audio_start"}))
    for n in range(frames):
        ws.send_bytes(audio_in_frame(n, loud=loud))
    ws.send_text(json.dumps({"type": "audio_end"}))


def assistant_ends(frames) -> list[str]:
    return [b["text"] for k, b in frames if k == "json" and b["type"] == "assistant_end"]


# ─── Предложения на лету ──────────────────────────────────────────────────────


def test_a_sentence_at_the_end_of_the_buffer_waits_for_what_may_follow():
    assert take_sentences("Привет. Как", final=False) == (["Привет."], " Как")
    assert take_sentences("Привет.", final=False) == ([], "Привет.")  # за точкой может прийти «..» или «?!»
    assert take_sentences("Привет.", final=True) == (["Привет."], "")
    assert take_sentences("Привет. Как дела", final=True) == (["Привет.", "Как дела"], "")


def test_decimals_ellipsis_and_exclamations_do_not_split_wrongly():
    assert take_sentences("Это 3.5 часа. Да.", final=True)[0] == ["Это 3.5 часа.", "Да."]
    assert take_sentences("Что?! Да… Ну ладно.", final=True)[0] == ["Что?!", "Да…", "Ну ладно."]
    assert split_sentences("Я рядом. С чего начнём?") == ["Я рядом.", "С чего начнём?"]
    assert split_sentences("  ") == []


def test_consecutive_user_messages_reach_the_model_as_one():
    history = [
        Message("1", "user", "я думаю, что", "t"),
        Message("2", "user", "мне тяжело", "t"),
        Message("3", "assistant", "Я слышу тебя.", "t"),
        Message("4", "user", "да", "t"),
    ]
    messages = chat_messages(history, 12)
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user"]
    assert messages[1]["content"] == "[t] я думаю, что [t] мне тяжело"


@pytest.mark.parametrize(
    ("text", "unfinished"),
    [
        ("я думаю, что", True),
        ("мне тяжело, потому что…", True),
        ("и", True),
        ("поехал на", True),
        ("мне сегодня тяжело,", True),
        ("мне сегодня тяжело.", False),
        ("как дела?", False),
        ("ну и ладно", False),
        ("", False),
    ],
)
def test_unfinished_phrases_are_recognized(text, unfinished):
    assert looks_unfinished(text) is unfinished


def test_echo_is_the_agents_own_words_and_not_a_person_repeating_one_phrase():
    spoken = "Я слышу тебя. Расскажи, что у тебя на душе?"
    assert is_echo("расскажи что у тебя на душе", spoken)
    assert not is_echo("мне сегодня очень тяжело", spoken)
    assert not is_echo("на душе", spoken)  # слишком коротко, чтобы судить
    assert not is_echo("расскажи что у тебя на душе", "")


# ─── Клиент модели: SSE ───────────────────────────────────────────────────────


def sse(*events: str) -> bytes:
    return "".join(f"data: {event}\n\n" for event in events).encode()


def delta(text: str, finish: str | None = None) -> str:
    return json.dumps({"choices": [{"delta": {"content": text}, "finish_reason": finish}]})


def proxy_chat(handler) -> ProxyChat:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ProxyChat("https://proxy.test/v1", "key", "model", 200, 0.7, 15, client=client)


async def collect(chat: ProxyChat) -> list[str]:
    return [piece async for piece in chat.stream([{"role": "user", "content": "привет"}])]


async def test_stream_gives_pieces_and_skips_service_lines():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        body = b": keep-alive\n\n" + sse(
            delta("Я "),
            delta("рядом."),
            json.dumps({"choices": [], "usage": {"total_tokens": 7}}),  # служебный кусок без выбора
            delta("", "stop"),
            "[DONE]",
        )
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    assert await collect(proxy_chat(handler)) == ["Я ", "рядом."]
    assert seen[0]["stream"] is True and seen[0]["model"] == "model"
    assert seen[0]["stream_options"] == {"include_usage": True}  # без него прокси не присылает расход в потоке


async def test_stream_cut_by_the_token_limit_raises_after_the_pieces():
    chat = proxy_chat(lambda r: httpx.Response(200, content=sse(delta("Первое. Втор"), delta("", "length"), "[DONE]")))
    pieces = []
    with pytest.raises(ReplyTruncated):
        async for piece in chat.stream([]):
            pieces.append(piece)
    assert pieces == ["Первое. Втор"]


@pytest.mark.parametrize("status", [400, 429, 500])
async def test_stream_error_status_becomes_model_error(status):
    chat = proxy_chat(lambda r: httpx.Response(status, json={"error": "нет"}))
    with pytest.raises(ModelError, match=str(status)):
        await collect(chat)


async def test_stream_network_error_becomes_model_error():
    def broken(request):
        raise httpx.ConnectError("нет связи")

    with pytest.raises(ModelError):
        await collect(proxy_chat(broken))


# ─── Конвейер: текст и звук идут, пока модель пишет ───────────────────────────


class TimedTts(FakeTts):
    """Озвучка, которая помнит, когда её попросили о каждой фразе."""

    def __init__(self) -> None:
        super().__init__()
        self.asked_at: dict[str, float] = {}

    async def synthesize(self, text: str, voice: str = "male") -> bytes:
        self.asked_at.setdefault(text, time.monotonic())
        return await super().synthesize(text, voice)


class StampedChat(FakeChat):
    """Чат, который помнит, когда дописал."""

    finished_at = 0.0

    async def stream(self, messages):
        async for piece in super().stream(messages):
            yield piece
        self.finished_at = time.monotonic()


def test_the_first_sentence_is_voiced_while_the_model_is_still_writing(user_id):
    tts = TimedTts()
    chat = StampedChat(pieces=["Первое ", "предложение. ", "Второе ", "предложение."], piece_delay=0.2)
    with make_client(tts, chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
            send_user_message(ws, "c-1", "привет")
            frames = read_frames(ws, lambda f: has(f, "assistant_end") and has(f, "tts_end"))

    # Раньше ждали весь ответ, и звук просили после chat.finished_at; теперь первое предложение уходит в озвучку на лету.
    assert tts.asked_at["Первое предложение."] < chat.finished_at - 0.3
    assert assistant_ends(frames) == ["Первое предложение. Второе предложение."]
    assert types(frames).index("assistant_start") < types(frames).index("assistant_end")


def test_deltas_add_up_to_the_final_text_across_sentences(user_id):
    chat = FakeChat(pieces=["Первое. ", "Второе  слово. ", "Третье?"])
    with make_client(chat=chat) as c:
        dialog = start_dialog(c, user_id)
        with c.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "привет")
            frames = read_frames(ws, reply_done)
        saved = c.get(f"/v1/users/{user_id}/dialogs/{dialog['dialogId']}", headers=AUTH).json()["messages"]

    streamed = "".join(b["text"] for k, b in frames if k == "json" and b["type"] == "assistant_delta")
    assert streamed == "Первое. Второе  слово. Третье?" == assistant_ends(frames)[0]
    assert saved[-1]["role"] == "assistant" and saved[-1]["text"] == streamed


def test_a_reply_cut_by_the_token_limit_loses_its_unfinished_tail(user_id):
    chat = FakeChat(pieces=["Первое. ", "Второе недопис"], truncated=True)
    with make_client(chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "привет")
            frames = read_frames(ws, reply_done)
    assert assistant_ends(frames) == ["Первое."]


def test_a_model_failure_after_the_first_sentence_keeps_what_was_said(user_id):
    class DiesAfterFirst(FakeChat):
        async def stream(self, messages):
            yield "Первое. "
            raise ModelError("связь оборвалась")

    with make_client(chat=DiesAfterFirst()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "привет")
            frames = read_frames(ws, reply_done)
    assert assistant_ends(frames) == ["Первое."]  # без шаблона поверх: человек уже слышит начало


def test_an_empty_stream_is_an_error_not_a_template(user_id):
    with make_client(chat=FakeChat(pieces=[])) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "привет")
            frames = read_frames(ws, lambda fs: has(fs, "error"))
    assert has(frames, "error", code="AGENT_LLM_UNAVAILABLE") and assistant_ends(frames) == []


def test_sentences_are_voiced_one_by_one(user_id):
    tts = FakeTts()
    with make_client(tts, chat=FakeChat(reply="Раз. Два. Три.")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
            tts.calls.clear()
            send_user_message(ws, "c-1", "привет")
            read_frames(ws, lambda f: has(f, "assistant_end") and has(f, "tts_end"))
    assert tts.calls == ["Раз.", "Два.", "Три."]


def test_time_to_first_sound_and_first_sentence_are_measured(voice_client, user_id):
    def count(stage: str) -> float:
        return sum(
            REGISTRY.get_sample_value("agent_voice_latency_seconds_count", {"stage": stage, "memory": memory}) or 0.0
            for memory in ("on", "off")
        )

    before = {stage: count(stage) for stage in ("first_sentence", "tts_first", "first_sound")}
    dialog = start_dialog(voice_client, user_id)
    with voice_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие: тайминг хода у него нет
        send_user_message(ws, "c-1", "привет")
        read_frames(ws, lambda f: has(f, "assistant_end") and has(f, "tts_end"))

    assert count("first_sentence") == before["first_sentence"] + 1
    assert count("first_sound") == before["first_sound"] + 1  # только у ответа, не у приветствия
    assert count("tts_first") >= before["tts_first"] + 2  # приветствие и ответ


# ─── Реплика, оборванная на полуслове ─────────────────────────────────────────


class ScriptedRecognizer(FakeRecognizer):
    """Распознавание, которое отвечает по очереди заранее заданными текстами."""

    def __init__(self, *texts: str) -> None:
        super().__init__()
        self.texts = list(texts)

    async def transcribe(self, pcm: bytes) -> str:
        self.calls.append(pcm)
        return self.texts.pop(0)


def test_an_unfinished_phrase_waits_for_the_person_to_finish(user_id):
    chat = FakeChat()
    with make_client(chat=chat, recognizer=ScriptedRecognizer("я думаю, что")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws)
            read_frames(ws, lambda f: has(f, "transcript", final=True))
            asked = time.monotonic()
            read_frames(ws, reply_done)
            waited = time.monotonic() - asked

    assert waited >= HOLD_SECONDS * 0.8  # ответ не сразу: человек мог бы продолжить
    assert len(chat.calls) == 1


def test_the_continuation_gets_one_answer_for_both_parts(user_id):
    chat = FakeChat()
    stt = ScriptedRecognizer("я думаю, что", "мне нужно выговориться.")
    with make_client(chat=chat, recognizer=stt) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws)
            read_frames(ws, lambda f: has(f, "transcript", final=True))
            speak(ws)  # договорил в пределах паузы
            frames = read_frames(ws, reply_done)
            time.sleep(HOLD_SECONDS * 2)  # по таймеру второй ответ не придёт
            send_user_message(ws, "c-1", "спасибо")
            later = read_frames(ws, reply_done)

    assert len(assistant_ends(frames)) == 1 and len(assistant_ends(later)) == 1
    assert len(chat.calls) == 2
    assert chat.calls[0][-1]["role"] == "user"
    assert "я думаю, что " in chat.calls[0][-1]["content"]
    assert chat.calls[0][-1]["content"].endswith("мне нужно выговориться.")


def test_a_false_start_does_not_swallow_the_held_answer(user_id):
    chat = FakeChat()
    with make_client(chat=chat, recognizer=ScriptedRecognizer("я думаю, что")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws)
            read_frames(ws, lambda f: has(f, "transcript", final=True))
            ws.send_text(json.dumps({"type": "audio_start"}))  # кашель: ни одного кадра с речью
            ws.send_text(json.dumps({"type": "audio_end"}))
            frames = read_frames(ws, reply_done)

    assert len(assistant_ends(frames)) == 1 and len(chat.calls) == 1


def test_a_crisis_phrase_is_never_held(user_id):
    with make_client(chat=FakeChat(), recognizer=ScriptedRecognizer("не хочу жить, потому что")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws)
            asked = time.monotonic()
            frames = read_frames(ws, reply_done)
            waited = time.monotonic() - asked
    assert has(frames, "safety")
    assert waited < HOLD_SECONDS * 0.8


# ─── Эхо агента ───────────────────────────────────────────────────────────────


def test_the_agents_own_voice_heard_over_its_speech_is_not_a_reply_from_the_person(user_id):
    chat = FakeChat(reply="Я слышу тебя. Расскажи, что у тебя на душе?")
    stt = ScriptedRecognizer("расскажи что у тебя на душе")
    with make_client(chat=chat, recognizer=stt) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "привет")
            frames = read_frames(ws, reply_done)
            message_id = next(b["messageId"] for k, b in frames if k == "json" and b["type"] == "assistant_start")
            ws.send_text(json.dumps({"type": "tts_cancel", "messageId": message_id}))  # «перебили»: на деле эхо
            speak(ws)
            heard = read_frames(ws, lambda f: has(f, "transcript", final=True))
            send_user_message(ws, "c-2", "спасибо")  # замыкает проверку: между ними чужих ответов нет
            tail = read_frames(ws, reply_done)

    assert has(heard, "transcript", text="", final=True)
    assert not has(heard, "assistant_start")
    assert len(chat.calls) == 2 and len(assistant_ends(tail)) == 1


def test_the_same_words_said_without_interrupting_are_the_persons_own(user_id):
    chat = FakeChat(reply="Я слышу тебя. Расскажи, что у тебя на душе?")
    stt = ScriptedRecognizer("расскажи что у тебя на душе")
    with make_client(chat=chat, recognizer=stt) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "привет")
            read_frames(ws, reply_done)
            speak(ws)  # без tts_cancel: обычная реплика, пусть и слово в слово
            frames = read_frames(ws, reply_done)

    assert has(frames, "transcript", text="расскажи что у тебя на душе")
    assert len(chat.calls) == 2


# ─── Звук потоком ─────────────────────────────────────────────────────────────

QWEN_VOICES = {"male": "loongjohn", "female": "longanhuan_v3.6"}


def qwen_stream(handler, streaming: bool = True) -> QwenTts:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return QwenTts("https://proxy.test/v1", "key", "qwen/model", QWEN_VOICES, client=client, streaming=streaming)


class ChunkedBody(httpx.AsyncByteStream):
    """Тело ответа кусками заданного размера, как отдаёт прокси."""

    def __init__(self, parts: list[bytes]) -> None:
        self.parts = parts

    async def __aiter__(self):
        for part in self.parts:
            yield part


async def test_qwen_stream_gives_whole_samples_even_when_chunks_split_one():
    audio = bytes(range(200))
    parts = [audio[:7], audio[7:100], audio[100:101], audio[101:]]  # нечётные границы посреди сэмпла
    tts = qwen_stream(lambda r: httpx.Response(200, stream=ChunkedBody(parts)))
    pieces = [piece async for piece in tts.stream("Привет.", "male")]
    assert all(len(piece) % 2 == 0 for piece in pieces)
    assert b"".join(pieces) == audio


async def test_qwen_stream_asks_for_pcm_with_the_voice_of_the_gender():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, content=b"\x01\x00" * 10)

    [_ async for _ in qwen_stream(handler).stream("Привет.", "female")]
    assert seen[0] == {"model": "qwen/model", "input": "Привет.", "voice": "longanhuan_v3.6", "response_format": "pcm"}


async def test_qwen_stream_off_gives_one_piece_like_synthesize():
    tts = qwen_stream(lambda r: httpx.Response(200, stream=ChunkedBody([b"\x01\x00" * 3, b"\x02\x00" * 3])), streaming=False)
    assert [piece async for piece in tts.stream("Привет.", "male")] == [b"\x01\x00" * 3 + b"\x02\x00" * 3]


@pytest.mark.parametrize("status", [400, 500])
async def test_qwen_stream_error_status_becomes_tts_error(status):
    tts = qwen_stream(lambda r: httpx.Response(status, json={"error": "нет"}))
    with pytest.raises(TtsError, match=str(status)):
        [_ async for _ in tts.stream("Привет.", "male")]


async def test_qwen_stream_empty_audio_and_network_error_become_tts_error():
    with pytest.raises(TtsError):
        [_ async for _ in qwen_stream(lambda r: httpx.Response(200, content=b"")).stream("Привет.", "male")]

    def broken(request):
        raise httpx.ConnectError("нет связи")

    with pytest.raises(TtsError):
        [_ async for _ in qwen_stream(broken).stream("Привет.", "male")]


class WholeOnlyTts:
    """Провайдер без потока: отдаёт звук только целиком."""

    name = "whole"

    async def synthesize(self, text: str, voice: str) -> bytes:
        return b"\x01\x00" * 4

    async def aclose(self) -> None:
        return None


async def test_a_provider_without_a_stream_is_read_whole():
    assert [piece async for piece in pcm_stream(WholeOnlyTts(), "Привет.", "male")] == [b"\x01\x00" * 4]


async def test_cache_replays_a_finished_stream_but_forgets_an_unfinished_one():
    calls = []

    class Source(WholeOnlyTts):
        async def stream(self, text, voice):
            calls.append(text)
            yield b"\x01\x00" * 2
            if text == "обрыв":
                raise TtsError("связь оборвалась")
            yield b"\x02\x00" * 2

    cached = CachedTts(Source(), 8)
    first = b"".join([p async for p in cached.stream("целая", "male")])
    again = b"".join([p async for p in cached.stream("целая", "male")])
    assert first == again == b"\x01\x00" * 2 + b"\x02\x00" * 2 and calls == ["целая"]  # второй раз из памяти

    for _ in range(2):
        with pytest.raises(TtsError):
            [_ async for _ in cached.stream("обрыв", "male")]
    assert calls.count("обрыв") == 2  # обрезок не запомнился


class StreamingTts(FakeTts):
    """Провайдер, отдающий звук кусками со своими паузами: первый кусок рано, остальное позже."""

    finished_at = 0.0

    async def stream(self, text: str, voice: str = "male"):
        self.calls.append(text)
        yield b"\x01\x00" * (FRAME_BYTES // 2)  # ровно кадр 200 мс
        await asyncio.sleep(0.5)
        yield b"\x02\x00" * (FRAME_BYTES // 2 + 1500)  # кадр и ещё немного: граница не по кадру
        yield b"\x03\x00" * 700
        self.finished_at = time.monotonic()


def test_frames_leave_while_the_provider_is_still_sending_and_stay_200ms_aligned(user_id):
    tts = StreamingTts()
    with make_client(tts, chat=FakeChat(reply="Одно предложение.")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
            tts.finished_at = 0.0
            send_user_message(ws, "c-1", "привет")
            arrivals, frames = [], []
            while not (has(frames, "assistant_end") and has(frames, "tts_end")):
                message = ws.receive()
                if message.get("bytes") is not None:
                    arrivals.append(time.monotonic())
                    frames.append(("bin", message["bytes"]))
                else:
                    frames.append(("json", json.loads(message["text"])))

    audio = [f for k, f in frames if k == "bin"]
    sizes = [len(frame) - 5 for frame in audio]
    assert tts.finished_at - arrivals[0] > 0.3  # первый кадр ушёл задолго до конца синтеза
    assert sizes[:-1] == [FRAME_BYTES] * (len(sizes) - 1) and 0 < sizes[-1] <= FRAME_BYTES
    assert sum(sizes) == FRAME_BYTES * 2 + 3000 + 1400  # ни байта не потеряно и не добавлено
    assert [struct.unpack(">BI", frame[:5])[1] for frame in audio] == list(range(len(audio)))
    order = types(frames)
    assert order.count("tts_start") == 1 and order.index("tts_start") < order.index("tts_end")


def test_a_provider_that_dies_mid_sentence_reports_one_error_and_still_closes_the_speech(user_id):
    class DiesInTheMiddle(FakeTts):
        async def stream(self, text, voice="male"):
            yield b"\x01\x00" * FRAME_BYTES  # два кадра
            raise TtsError("связь оборвалась")

    with make_client(DiesInTheMiddle(), chat=FakeChat(reply="Раз. Два.")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "привет")
            frames = read_frames(ws, lambda f: has(f, "assistant_end") and has(f, "tts_end"))

    assert has(frames, "error", code="VOICE_UNAVAILABLE") and types(frames).count("error") == 1
    assert len([f for k, f in frames if k == "bin"]) >= 1  # начало успели услышать


# ─── Скорость: новая реплика обрывает старую озвучку, соединения живут дольше ──


class TwoReplies(FakeChat):
    """Чат, который отвечает по очереди заранее заданными ответами."""

    def __init__(self, *replies: str) -> None:
        super().__init__()
        self.replies = list(replies)

    async def stream(self, messages):
        self.calls.append(messages)
        for piece in re.findall(r"\S+\s*", self.replies.pop(0)):
            yield piece


class StuckOnTheFirstReply(FakeTts):
    """Провайдер, который на первом ответе отдаёт кадр и надолго замолкает (как медленный или зависший синтез)."""

    async def stream(self, text: str, voice: str = "male"):
        self.calls.append(text)
        yield b"\x01\x00" * (FRAME_BYTES // 2)
        if text.startswith("Первый"):
            await asyncio.sleep(5)
        yield b"\x02\x00" * (FRAME_BYTES // 2)


def test_a_new_message_cuts_off_the_speech_that_is_still_going(user_id):
    """Раньше озвучка следующего ответа ждала, пока прошлая договорится (в живой сессии это дало первый звук через 12 с)."""
    tts = StuckOnTheFirstReply()
    chat = TwoReplies("Первый ответ.", "Второй ответ.")
    with make_client(tts, chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
            send_user_message(ws, "c-1", "раз")
            first = read_frames(ws, lambda f: types(f).count("tts_start") == 1 and reply_done(f))
            first_id = next(b["messageId"] for k, b in first if k == "json" and b["type"] == "tts_start")

            sent = time.monotonic()
            send_user_message(ws, "c-2", "два")
            frames = read_frames(ws, lambda f: has(f, "tts_end", messageId=first_id) and types(f).count("tts_start") == 1)
            waited = time.monotonic() - sent

    assert has(frames, "tts_end", messageId=first_id)  # старая озвучка закрыта, а не висит
    assert waited < 2.5  # синтез первого ответа заблокирован на 5 с: новый не ждёт его


def test_the_next_reply_is_voiced_right_after_the_stuck_one_is_cut(user_id):
    tts = StuckOnTheFirstReply()
    chat = TwoReplies("Первый ответ.", "Второй ответ.")
    with make_client(tts, chat=chat) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
            send_user_message(ws, "c-1", "раз")
            read_frames(ws, lambda f: types(f).count("tts_start") == 1 and reply_done(f))
            sent = time.monotonic()
            send_user_message(ws, "c-2", "два")
            frames = read_frames(ws, lambda f: has(f, "assistant_end", text="Второй ответ.") and types(f).count("tts_start") == 1)
            started_after = time.monotonic() - sent

    second = [b["messageId"] for k, b in frames if k == "json" and b["type"] == "tts_start"]
    assert len(second) == 1 and started_after < 2.5


async def test_the_clients_keep_idle_connections_longer_than_httpx_does_by_default():
    # Между репликами человека обычно 5-30 с: с умолчанием в 5 с каждый ход начинался бы с нового TCP+TLS.
    from app.clients.llm import ProxyChat as Chat, ProxyWhisper
    from app.clients.speech import SaluteTts

    clients = [
        Chat("https://p/v1", "k", "m", 200, 0.7, 15)._client,
        ProxyWhisper("https://p/v1", "k", "m", 15)._client,
        QwenTts("https://p/v1", "k", "m", QWEN_VOICES)._client,
        SaluteTts("key", "scope", {"male": "a_24000", "female": "b_24000"})._client,
    ]
    for client in clients:
        assert client._transport._pool._keepalive_expiry == 60
        await client.aclose()
