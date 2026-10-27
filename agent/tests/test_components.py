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

from app.clients.background_model import ModelError, ProxyBackgroundModel
from app.clients.speech import CachedTts
from app.services import usage as model_usage
from tests.conftest import AUTH, audio_in_frame, components, make_client, read_frames, send_user_message, start_dialog, ws_url

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


def chat(handler) -> ProxyBackgroundModel:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ProxyBackgroundModel(BASE, "key", "chat-model", max_tokens=100, temperature=0.5, timeout_seconds=5, client=client)


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


async def test_a_failed_chat_call_is_an_error_without_the_vendors_text(calls: Calls) -> None:
    model = chat(lambda r: httpx.Response(500, text="секретная ошибка вендора"))
    with pytest.raises(ModelError):
        await model.complete([])
    assert calls.items == [("llm", "error", False)]
    assert "секретная" not in json.dumps(calls.items, ensure_ascii=False)


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


def answered_and_counted(frames: list[Any]) -> bool:
    """Ответ дозвучал и обращение к модели засчитано: два кадра приходят в любом порядке, оба нужны."""
    return reply_done(frames) and ("live", "ok", False) in components(frames)


def reply_done(frames: list[Any]) -> bool:
    ends = [b for k, b in frames if k == "json" and b["type"] == "assistant_end"]
    return bool(ends) and any(k == "json" and b["type"] == "tts_end" and b["messageId"] == ends[-1]["messageId"] for k, b in frames)


def test_a_typed_turn_reports_the_safety_check_and_the_model_call_and_nothing_else_in_the_frame(user_id: str) -> None:
    with make_client() as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Мне плохо")
            frames = read_frames(ws, answered_and_counted)
    assert sorted(components(frames)) == [("live", "ok", False), ("safety", "ok", False)]
    frame = next(b for k, b in frames if k == "json" and b["type"] == "component")
    assert set(frame) == {"v", "type", "component", "outcome", "cached"}


def test_a_crisis_phrase_is_still_one_safety_call_and_the_model_is_not_called(user_id: str) -> None:
    with make_client() as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "не хочу больше жить")
            frames = read_frames(ws, done)
    assert components(frames).count(("safety", "ok", False)) == 1
    assert ("live", "ok", False) not in components(frames)


def test_a_spoken_turn_reports_each_part_it_used(user_id: str) -> None:
    """Речь в речь: проверка безопасности на реплику и один вызов модели; отдельных распознавания и озвучки нет."""
    with make_client() as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            ws.send_text(json.dumps({"type": "audio_start"}))
            for n in range(10):
                ws.send_bytes(audio_in_frame(n, loud=True))
            ws.send_text(json.dumps({"type": "audio_end"}))
            frames = read_frames(ws, answered_and_counted)
    assert sorted(components(frames)) == [("live", "ok", False), ("safety", "ok", False)]
