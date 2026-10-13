"""Обращения к компонентам агента: что считается обращением, как оно доходит до шлюза и что в отчёт не попадает.

Обращение — один настоящий вызов распознавания, проверки безопасности, модели или озвучки внутри диалога. Агент считает
его в Prometheus (без id) и кадром `component` отдаёт шлюзу: тот превращает кадр в событие продуктовой аналитики
`component_called` с человеком и `dialog_id`. В кадре название, исход и «из памяти»; ни промпта, ни текста, ни ошибки провайдера.
"""

import asyncio
import json
from typing import Any

import httpx
import pytest
from prometheus_client import REGISTRY

from app.clients.llm import ModelError, ProxyChat, ProxyWhisper
from app.clients.speech import CachedTts, QwenTts, TtsError
from app.services import usage as model_usage
from tests.conftest import (
    AUTH,
    FakeChat,
    FakeRecognizer,
    FakeTts,
    audio_in_frame,
    components,
    make_client,
    read_frames,
    send_user_message,
    start_dialog,
    ws_url,
)

BASE = "https://proxy.test/v1"


def counted(component: str, outcome: str = "ok", cached: str = "false") -> float:
    return REGISTRY.get_sample_value(
        "agent_component_calls_total", {"component": component, "outcome": outcome, "cached": cached}
    ) or 0.0


class Calls:
    """Приёмник обращений, как у сессии сокета, только в список."""

    def __init__(self) -> None:
        self.items: list[tuple[str, str, bool]] = []
        model_usage.bind_calls(lambda component, outcome, cached: self.items.append((component, outcome, cached)))


@pytest.fixture
def calls() -> Calls:
    return Calls()


def completion(content: str) -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]}


def chat(handler) -> ProxyChat:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ProxyChat(BASE, "key", "chat-model", max_tokens=100, temperature=0.5, timeout_seconds=5, client=client)


# ─── Само обращение ───────────────────────────────────────────────────────────


async def test_a_call_is_counted_and_reported_to_the_bound_session(calls: Calls) -> None:
    before = counted("safety")
    model_usage.call("safety")
    assert counted("safety") == before + 1
    assert calls.items == [("safety", "ok", False)]


async def test_a_call_outside_any_dialog_is_only_counted() -> None:
    """Прогрев озвучки при старте идёт вне диалога: оплачен, значит в счётчике, но человека и диалога у него нет."""
    model_usage.bind_calls(None)  # type: ignore[arg-type]
    before = counted("tts")
    model_usage.call("tts")
    assert counted("tts") == before + 1


async def test_a_broken_sink_never_breaks_the_call_it_reports() -> None:
    def broken(component: str, outcome: str, cached: bool) -> None:
        raise RuntimeError("шлюз упал")

    model_usage.bind_calls(broken)
    model_usage.call("llm")  # не бросает


async def test_a_cancelled_call_still_counts_as_made(calls: Calls) -> None:
    async def slow() -> None:
        with model_usage.called("llm"):
            await asyncio.sleep(10)

    task = asyncio.create_task(slow())
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls.items == [("llm", "ok", False)]  # запрос ушёл и оплачен, отмена исход не портит


# ─── Клиенты моделей ──────────────────────────────────────────────────────────


async def test_chat_complete_is_one_call(calls: Calls) -> None:
    model = chat(lambda r: httpx.Response(200, json=completion("Я рядом.")))
    await model.complete([{"role": "user", "content": "привет"}])
    assert calls.items == [("llm", "ok", False)]


async def test_chat_stream_is_one_call_however_many_pieces(calls: Calls) -> None:
    sse = (
        'data: {"choices":[{"delta":{"content":"Я "}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"рядом."},"finish_reason":"stop"}]}\n\n'
        "data: [DONE]\n\n"
    )
    model = chat(lambda r: httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"}))
    pieces = [p async for p in model.stream([{"role": "user", "content": "привет"}])]
    assert "".join(pieces) == "Я рядом."
    assert calls.items == [("llm", "ok", False)]


async def test_a_failed_chat_call_is_an_error_without_the_vendors_text(calls: Calls) -> None:
    model = chat(lambda r: httpx.Response(500, text="секретная ошибка вендора"))
    with pytest.raises(ModelError):
        await model.complete([])
    assert calls.items == [("llm", "error", False)]
    assert "секретная" not in json.dumps(calls.items, ensure_ascii=False)


async def test_a_stream_the_listener_walked_away_from_is_still_one_call(calls: Calls) -> None:
    sse = 'data: {"choices":[{"delta":{"content":"раз "}}]}\n\ndata: {"choices":[{"delta":{"content":"два"}}]}\n\n'
    model = chat(lambda r: httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"}))
    stream = model.stream([])
    assert await stream.__anext__() == "раз "
    await stream.aclose()  # перебили на середине ответа
    assert calls.items == [("llm", "ok", False)]


async def test_recognition_is_one_call_and_a_failure_is_an_error(calls: Calls) -> None:
    ok = ProxyWhisper(BASE, "key", "stt", 5, client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"text": "привет"}))))
    assert await ok.transcribe(b"\x00\x00" * 1600) == "привет"
    bad = ProxyWhisper(BASE, "key", "stt", 5, client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503, text="x"))))
    with pytest.raises(ModelError):
        await bad.transcribe(b"\x00\x00" * 1600)
    assert calls.items == [("stt", "ok", False), ("stt", "error", False)]


def qwen(handler, streaming: bool = True) -> QwenTts:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return QwenTts("https://proxy.example/v1/", "k", "qwen", {"male": "a", "female": "b"}, client=client, streaming=streaming)


async def test_synthesis_is_one_call_in_both_modes(calls: Calls) -> None:
    handler = lambda r: httpx.Response(200, content=b"\x01\x00" * 100)  # noqa: E731
    await qwen(handler).synthesize("Привет", "male")
    assert [p async for p in qwen(handler).stream("Привет", "male")]
    # Без потока `stream` отдаёт всё через `synthesize`: это тот же один вызов, а не два.
    assert [p async for p in qwen(handler, streaming=False).stream("Привет", "male")]
    assert calls.items == [("tts", "ok", False)] * 3


async def test_a_refused_synthesis_is_an_error_call(calls: Calls) -> None:
    refuse = lambda r: httpx.Response(500, text="секретная ошибка")  # noqa: E731
    with pytest.raises(TtsError):
        await qwen(refuse).synthesize("Привет", "male")
    with pytest.raises(TtsError):
        _ = [p async for p in qwen(refuse).stream("Привет", "male")]
    assert calls.items == [("tts", "error", False), ("tts", "error", False)]


class _Counting:
    name = "counting"

    def __init__(self) -> None:
        self.calls = 0

    @model_usage.counted("tts")
    async def synthesize(self, text: str, voice: str) -> bytes:
        self.calls += 1
        return b"\x01\x00" * 10

    async def aclose(self) -> None:
        return None


async def test_a_phrase_from_the_cache_is_a_cached_call_and_the_provider_is_not_asked(calls: Calls) -> None:
    tts = CachedTts(_Counting(), max_items=8)  # type: ignore[arg-type]
    await tts.synthesize("Привет", "male")  # настоящий вызов
    await tts.synthesize("Привет", "male")  # из памяти
    assert [p async for p in tts.stream("Привет", "male")]  # из памяти, потоком
    assert calls.items == [("tts", "ok", False), ("tts", "ok", True), ("tts", "ok", True)]


# ─── Сокет диалога: что видит шлюз ────────────────────────────────────────────


def done(frames: list[Any]) -> bool:
    return any(k == "json" and b["type"] == "assistant_end" for k, b in frames)


def test_a_typed_turn_reports_the_safety_check_and_nothing_else_in_the_frame(user_id: str) -> None:
    with make_client(chat=FakeChat("Слышу тебя.")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Мне плохо")
            frames = read_frames(ws, done)
    assert ("safety", "ok", False) in components(frames)
    frame = next(b for k, b in frames if k == "json" and b["type"] == "component")
    assert set(frame) == {"v", "type", "component", "outcome", "cached"}


def test_a_crisis_phrase_is_still_one_safety_call(user_id: str) -> None:
    with make_client(chat=FakeChat("Я рядом.")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "не хочу больше жить")
            frames = read_frames(ws, done)
    assert components(frames).count(("safety", "ok", False)) == 1


def test_a_spoken_turn_reports_each_part_it_used(user_id: str) -> None:
    """Каскад: проверка безопасности на реплику. Распознавание, модель и озвучка здесь подменены и сами не считаются (их считают
    настоящие клиенты, см. выше), поэтому в кадрах только то, что делает сама сессия."""
    with make_client(tts=FakeTts(), chat=FakeChat("Слышу."), recognizer=FakeRecognizer("мне тяжело")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            ws.send_text(json.dumps({"type": "audio_start"}))
            for n in range(10):
                ws.send_bytes(audio_in_frame(n, loud=True))
            ws.send_text(json.dumps({"type": "audio_end"}))
            frames = read_frames(ws, done)
    assert components(frames) == [("safety", "ok", False)]
