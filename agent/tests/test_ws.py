"""WebSocket-контракт agent-api: текст, голос, озвучка (specs/agent-api, specs/speech-pipeline)."""

import json
import struct
import time
import uuid

import pytest
from starlette.testclient import WebSocketDenialResponse

from app.services.replies import CRISIS_REPLY, CRISIS_SAFETY_TEXT
from tests.conftest import (
    AUTH,
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


def history(client, user_id, dialog_id):
    return client.get(f"/v1/users/{user_id}/dialogs/{dialog_id}", headers=AUTH).json()["messages"]


def reply_done(frames):
    return has(frames, "assistant_end")


# ─── Текст ────────────────────────────────────────────────────────────────────


def test_ready_is_the_first_frame_and_frames_are_versioned(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        first = read_frames(ws, lambda f: len(f) == 1)[0]
        assert first == ("json", {"v": 1, "type": "ready"})


def test_text_turn_ack_then_streamed_reply(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "Мне плохо")
        frames = read_frames(ws, reply_done)

    order = types(frames)
    assert order[:2] == ["ready", "ack"]
    assert order[2] == "assistant_start" and order[-1] == "assistant_end"
    assert set(order[3:-1]) == {"assistant_delta"}

    ack = next(b for k, b in frames if k == "json" and b["type"] == "ack")
    assert ack["id"] == "c-1"
    start = next(b for k, b in frames if k == "json" and b["type"] == "assistant_start")
    deltas = [b["text"] for k, b in frames if k == "json" and b["type"] == "assistant_delta"]
    end = next(b for k, b in frames if k == "json" and b["type"] == "assistant_end")
    assert end["messageId"] == start["messageId"]
    assert "".join(deltas) == end["text"]  # клиент заменяет накопленное итогом: они должны совпадать

    # история — источник истины: те же id, что в сокете
    messages = history(client, user_id, dialog["dialogId"])
    assert [(m["id"], m["role"]) for m in messages] == [(ack["messageId"], "user"), (start["messageId"], "assistant")]
    assert messages[0]["text"] == "Мне плохо" and messages[1]["text"] == end["text"]


def test_repeated_user_message_gives_the_same_message_id_and_no_second_reply(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "раз")
        first = read_frames(ws, reply_done)
        send_user_message(ws, "c-1", "раз")  # клиент не получил ack и повторяет
        second = read_frames(ws, lambda f: has(f, "ack"))

    ack1 = next(b for k, b in first if k == "json" and b["type"] == "ack")
    ack2 = next(b for k, b in second if k == "json" and b["type"] == "ack")
    assert ack1["messageId"] == ack2["messageId"]
    assert len(history(client, user_id, dialog["dialogId"])) == 2  # одно сообщение человека и один ответ


def test_next_message_waits_in_the_queue_for_the_current_reply(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "первое")
        send_user_message(ws, "c-2", "второе")
        frames = read_frames(ws, lambda f: types(f).count("assistant_end") == 2)

    order = [t for t in types(frames) if t in ("assistant_start", "assistant_end")]
    assert order == ["assistant_start", "assistant_end", "assistant_start", "assistant_end"]
    assert [m["role"] for m in history(client, user_id, dialog["dialogId"])] == ["user", "assistant", "user", "assistant"]


def test_replies_differ_from_turn_to_turn(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        texts = []
        for n in range(3):
            send_user_message(ws, f"c-{n}", "расскажу")
            frames = read_frames(ws, reply_done)
            texts.append(next(b["text"] for k, b in frames if k == "json" and b["type"] == "assistant_end"))
    assert len(set(texts)) == 3


def test_crisis_message_triggers_safety_and_a_fixed_reply(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "я больше не хочу жить")
        frames = read_frames(ws, reply_done)

    assert has(frames, "safety", text=CRISIS_SAFETY_TEXT)
    assert types(frames).index("ack") < types(frames).index("safety") < types(frames).index("assistant_start")
    assert next(b["text"] for k, b in frames if k == "json" and b["type"] == "assistant_end") == CRISIS_REPLY


def test_end_frame_sends_summary_and_closes_with_1000(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "поговорим")
        read_frames(ws, reply_done)
        ws.send_text(json.dumps({"type": "end", "takeaway": "Стало легче", "tensionAfter": 3}))
        frames = read_frames(ws, lambda f: f[-1][0] == "close")

    ended = next(b for k, b in frames if k == "json" and b["type"] == "ended")
    assert ended["summary"]["title"] == "Стало легче" and ended["summary"]["tensionAfter"] == 3
    assert frames[-1] == ("close", 1000)
    item = client.get(f"/v1/users/{user_id}/dialogs/{dialog['dialogId']}", headers=AUTH).json()
    assert item["endedAt"] and item["summary"] == ended["summary"]


def test_unknown_and_broken_frames_are_ignored(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        ws.send_text("не json")
        ws.send_text(json.dumps({"type": "something_new", "extra": 1}))
        ws.send_text(json.dumps({"type": "user_message", "id": "c-0", "text": "   "}))  # пустая реплика
        send_user_message(ws, "c-1", "привет")
        frames = read_frames(ws, reply_done)
    assert types(frames)[:2] == ["ready", "ack"]
    assert len(history(client, user_id, dialog["dialogId"])) == 2


# ─── Рукопожатие ──────────────────────────────────────────────────────────────


def test_handshake_without_token_is_rejected_with_401(client, user_id):
    dialog = start_dialog(client, user_id)
    with pytest.raises(WebSocketDenialResponse) as denied:
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"])):
            pass
    assert denied.value.status_code == 401


def test_handshake_for_foreign_or_missing_dialog_is_404(client, user_id):
    dialog = start_dialog(client, user_id)
    for target_user, target_dialog in ((str(uuid.uuid4()), dialog["dialogId"]), (user_id, "nope"), ("not-a-uuid", "x")):
        with pytest.raises(WebSocketDenialResponse) as denied:
            with client.websocket_connect(ws_url(target_user, target_dialog), headers=AUTH):
                pass
        assert denied.value.status_code == 404


def test_second_live_socket_gets_409_and_the_first_keeps_working(client, user_id):
    dialog = start_dialog(client, user_id)
    path = ws_url(user_id, dialog["dialogId"])
    with client.websocket_connect(path, headers=AUTH) as first:
        read_frames(first, lambda f: has(f, "ready"))
        with pytest.raises(WebSocketDenialResponse) as denied:
            with client.websocket_connect(path, headers=AUTH):
                pass
        assert denied.value.status_code == 409
        send_user_message(first, "c-1", "я тут")
        assert has(read_frames(first, reply_done), "assistant_end")

    # после закрытия первого сокета диалог снова доступен
    with client.websocket_connect(path, headers=AUTH) as again:
        assert has(read_frames(again, lambda f: has(f, "ready")), "ready")


# ─── Голос ────────────────────────────────────────────────────────────────────


def test_voice_turn_gives_final_transcript_with_message_id_and_a_reply(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        ws.send_text(json.dumps({"type": "audio_start"}))
        for n in range(25):  # 2,5 с речи
            ws.send_bytes(audio_in_frame(n))
        ws.send_text(json.dumps({"type": "audio_end"}))
        frames = read_frames(ws, reply_done)

    transcript = next(b for k, b in frames if k == "json" and b["type"] == "transcript")
    assert transcript["final"] is True and transcript["text"] and transcript["messageId"]
    assert "ack" not in types(frames)  # на голосовую реплику ack не нужен
    messages = history(client, user_id, dialog["dialogId"])
    assert messages[0] == {**messages[0], "id": transcript["messageId"], "role": "user", "text": transcript["text"]}
    assert messages[1]["role"] == "assistant"


def test_silence_gives_an_empty_final_transcript_and_no_reply(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        ws.send_text(json.dumps({"type": "audio_start"}))
        ws.send_text(json.dumps({"type": "audio_end"}))
        frames = read_frames(ws, lambda f: has(f, "transcript"))
        silent = next(b for k, b in frames if k == "json" and b["type"] == "transcript")
        assert silent == {"v": 1, "type": "transcript", "text": "", "final": True}
        # ответа на тишину нет: следующий же кадр относится уже к новой реплике
        send_user_message(ws, "c-1", "я тут")
        after = read_frames(ws, reply_done)
    assert types(after)[0] == "ack"
    assert len(history(client, user_id, dialog["dialogId"])) == 2


def test_voice_turn_without_audio_end_is_dropped(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        ws.send_text(json.dumps({"type": "audio_start"}))
        for n in range(5):
            ws.send_bytes(audio_in_frame(n))
        # экран закрыт: сокет рвётся без audio_end
    assert history(client, user_id, dialog["dialogId"]) == []


# ─── Озвучка ──────────────────────────────────────────────────────────────────


def binary_frames(frames):
    return [b for k, b in frames if k == "bin"]


def test_greeting_is_voiced_once_per_start_not_per_socket(voice_client, voice, user_id):
    dialog = start_dialog(voice_client, user_id)
    path = ws_url(user_id, dialog["dialogId"])

    with voice_client.websocket_connect(path, headers=AUTH) as ws:
        frames = read_frames(ws, lambda f: has(f, "tts_end"))
    assert types(frames) == ["ready", "tts_start", "tts_end"]
    assert has(frames, "tts_start", messageId="greeting") and has(frames, "tts_end", messageId="greeting")
    assert voice.calls == ["Я рядом.", "С чего начнём?"]  # по предложениям

    # переподключение: приветствие не повторяется
    with voice_client.websocket_connect(path, headers=AUTH) as ws:
        send_user_message(ws, "c-1", "я тут")
        again = read_frames(ws, reply_done)
    assert not has(again, "tts_start", messageId="greeting")

    # новый успешный POST …/dialogs (resumed) — приветствие звучит снова на первом сокете
    assert start_dialog(voice_client, user_id)["resumed"] is True
    with voice_client.websocket_connect(path, headers=AUTH) as ws:
        frames = read_frames(ws, lambda f: has(f, "tts_end"))
    assert has(frames, "tts_start", messageId="greeting")


def test_tts_frames_have_the_contract_format(voice_client, user_id):
    dialog = start_dialog(voice_client, user_id)
    with voice_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        frames = read_frames(ws, lambda f: has(f, "tts_end"))

    audio = binary_frames(frames)
    # два предложения по 0,5 с: на каждое два кадра по 200 мс и один неполный
    assert len(audio) == 6
    for expected_sequence, frame in enumerate(audio):
        kind, sequence = struct.unpack(">BI", frame[:5])
        assert kind == 0x02 and sequence == expected_sequence
        assert len(frame) <= 9605 and (len(frame) - 5) % 2 == 0
    assert len(audio[0]) == 9605  # 200 мс на 24 кГц: 4800 сэмплов по 2 байта и заголовок
    # tts_start идёт до первого кадра, tts_end после последнего
    order = [("json", b["type"]) if k == "json" else ("bin", None) for k, b in frames]
    assert order[1] == ("json", "tts_start") and order[-1] == ("json", "tts_end")


def test_reply_is_voiced_and_voices_never_interleave(voice_client, voice, user_id):
    dialog = start_dialog(voice_client, user_id)
    with voice_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
        send_user_message(ws, "c-1", "раз")
        send_user_message(ws, "c-2", "два")
        # синтез мгновенный, поэтому tts_end может прийти раньше assistant_end: ждём оба конца дважды
        frames = read_frames(ws, lambda f: types(f).count("tts_end") == 2 and types(f).count("assistant_end") == 2)

    start_ids = [b["messageId"] for k, b in frames if k == "json" and b["type"] == "tts_start"]
    end_ids = [b["messageId"] for k, b in frames if k == "json" and b["type"] == "tts_end"]
    assert len(start_ids) == 2 and start_ids == end_ids  # start/end парами, без перемежения
    assert has(frames, "assistant_end", messageId=start_ids[0]) and has(frames, "assistant_end", messageId=start_ids[1])
    # озвучка идёт строго по порядку: между start первого и start второго нет чужих кадров
    positions = [i for i, (k, b) in enumerate(frames) if k == "json" and b["type"] in ("tts_start", "tts_end")]
    assert [frames[i][1]["type"] for i in positions] == ["tts_start", "tts_end", "tts_start", "tts_end"]


def test_tts_cancel_stops_the_message_speech(user_id):
    slow = FakeTts(delay=0.3)
    with make_client(slow) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
            send_user_message(ws, "c-1", "раз")
            frames = read_frames(ws, lambda f: has(f, "assistant_start"))
            message_id = next(b["messageId"] for k, b in frames if k == "json" and b["type"] == "assistant_start")
            ws.send_text(json.dumps({"type": "tts_cancel", "messageId": message_id}))
            read_frames(ws, reply_done)
            time.sleep(1.0)  # дать озвучке шанс, если отмена не работает
            ws.send_text(json.dumps({"type": "user_message", "id": "c-2", "text": "ещё"}))
            tail = read_frames(ws, lambda f: has(f, "ack"))

    assert not has(tail, "tts_start", messageId=message_id)
    assert binary_frames(tail) == []


def test_broken_tts_does_not_break_the_dialog(user_id):
    with make_client(FakeTts(fail=True)) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "привет")
            frames = read_frames(ws, lambda f: has(f, "assistant_end") and has(f, "error"))

    assert has(frames, "error", code="VOICE_UNAVAILABLE")
    assert not has(frames, "tts_start")  # приложение прочитает ответ само
    assert has(frames, "assistant_end")
    assert types(frames).count("error") == 1  # не сыплем ошибками на каждое предложение


def test_without_tts_there_are_no_voice_frames(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "привет")
        frames = read_frames(ws, reply_done)
    assert not has(frames, "tts_start") and binary_frames(frames) == []


def test_switching_speech_off_applies_to_a_live_socket(voice_client, user_id):
    """Агент с отказавшей озвучкой (dev-режим): текст идёт, звука нет, клиент читает ответ сам."""
    dialog = start_dialog(voice_client, user_id)
    with voice_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
        voice_client.post("/dev/tts", json={"mode": "none"}, headers=AUTH)
        send_user_message(ws, "c-1", "раз")
        off = read_frames(ws, reply_done)
        assert not has(off, "tts_start") and binary_frames(off) == []

        voice_client.post("/dev/tts", json={"mode": "auto"}, headers=AUTH)
        send_user_message(ws, "c-2", "два")
        on = read_frames(ws, lambda f: has(f, "assistant_end") and has(f, "tts_end"))
        assert has(on, "tts_start") and binary_frames(on)


# ─── голос по роду ────────────────────────────────────────────────────────────


def test_greeting_and_replies_use_the_voice_chosen_at_start(voice_client, voice, user_id):
    dialog = voice_client.post(f"/v1/users/{user_id}/dialogs", json={"voice": "female"}, headers=AUTH).json()
    with voice_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
        assert set(voice.voices) == {"female"}
        send_user_message(ws, "c-1", "раз")
        read_frames(ws, lambda f: has(f, "assistant_end") and has(f, "tts_end"))
    assert set(voice.voices) == {"female"}


def test_default_voice_is_male(voice_client, voice, user_id):
    dialog = start_dialog(voice_client, user_id)
    with voice_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        read_frames(ws, lambda f: has(f, "tts_end"))
    assert set(voice.voices) == {"male"}


def test_set_voice_frame_switches_the_voice_of_the_next_reply(voice_client, voice, user_id):
    dialog = start_dialog(voice_client, user_id)  # male
    with voice_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие мужским голосом
        greeting_calls = len(voice.voices)
        assert set(voice.voices) == {"male"}

        ws.send_text(json.dumps({"type": "set_voice", "voice": "robot"}))  # чужое значение игнорируется
        ws.send_text(json.dumps({"type": "set_voice", "voice": "female"}))
        send_user_message(ws, "c-1", "раз")
        read_frames(ws, lambda f: has(f, "assistant_end") and has(f, "tts_end"))
        assert set(voice.voices[greeting_calls:]) == {"female"}

    # выбор запомнен: следующий диалог человека начинается женским голосом
    voice_client.post(f"/v1/users/{user_id}/dialogs/{dialog['dialogId']}/end", headers=AUTH)
    assert start_dialog(voice_client, user_id)["voice"] == "female"
