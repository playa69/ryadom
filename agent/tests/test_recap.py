"""Итог разговора для экрана завершения (app/services/recap.py, `POST …/recap`)."""

import asyncio
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.config import LlmSettings
from app.main import create_app
from app.memory.llm import MemoryModelError
from app.services import recap as recap_module
from app.services.dialog_store import Dialog, Message
from app.services.recap import (
    RECAP_MAX_CHARS,
    TRANSCRIPT_MAX_CHARS,
    build_recap_llm,
    clean_recap,
    make_recap,
    recap_messages,
    skip_reason,
)
from tests.conftest import AUTH, has, read_frames, send_user_message, start_dialog, ws_url
from tests.memory_support import memory_settings

LONG_ENOUGH = "Поссорилась с сестрой из-за денег, теперь не знаю, как с ней заговорить"


class FakeRecap:
    """Модель итога для тестов: ответ задан заранее, запросы запоминаются."""

    name = "fake-recap"

    def __init__(self, answer: str = "Говорили о ссоре с сестрой. Решили написать ей вечером.", error: Exception | None = None):
        self.answer = answer
        self.error = error
        self.delay = 0.0
        self.calls: list[list[dict[str, str]]] = []

    async def complete(self, messages: list[dict[str, str]]) -> str:
        self.calls.append(messages)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return self.answer

    async def aclose(self) -> None:
        return None


def dialog(*texts: tuple[str, str], memory_mode: str = "on", crisis: bool = False) -> Dialog:
    messages = [
        Message(id=str(i), role=role, text=text, created_at="2026-10-14T10:00:00.000Z") for i, (role, text) in enumerate(texts)
    ]
    return Dialog(
        id="d-1",
        user_id="u-1",
        started_at="2026-10-14T10:00:00.000Z",
        messages=messages,
        memory_mode=memory_mode,  # type: ignore[arg-type]
        crisis_seen=crisis,
    )


def test_who_gets_no_recap() -> None:
    talk = (("assistant", "Я рядом. С чего начнём?"), ("user", LONG_ENOUGH))
    assert skip_reason(dialog(*talk)) is None
    assert skip_reason(dialog(*talk, memory_mode="off")) == "memory_off"  # «Без памяти» обещано без сводок
    assert skip_reason(dialog(*talk, crisis=True)) == "crisis"
    # длинное приветствие агента не делает разговор длинным: считаются только слова человека
    assert skip_reason(dialog(("assistant", "Я рядом. " * 20), ("user", "привет"))) == "too_short"


def test_transcript_keeps_order_and_the_end_of_a_long_talk() -> None:
    talk = dialog(("assistant", "Я рядом."), ("user", "  мне   тревожно\nперед экзаменом "))
    system, user = recap_messages(talk)
    assert system["role"] == "system" and "Говорили о" in system["content"]
    assert user["content"] == "Разговор:\nРядом: Я рядом.\nЧеловек: мне тревожно перед экзаменом"

    long_talk = dialog(*[("user", f"реплика {i} " + "слово " * 100) for i in range(30)])
    transcript = recap_messages(long_talk)[1]["content"]
    assert len(transcript) <= TRANSCRIPT_MAX_CHARS + 100
    assert "реплика 29 " in transcript and "реплика 0 " not in transcript  # вывод обычно в конце разговора


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        ("Говорили о работе. Решили взять выходной.", "Говорили о работе. Решили взять выходной."),
        ("«Говорили о работе.»", "Говорили о работе."),
        ("**Говорили** о  работе\n\nи о сне.", "Говорили о работе и о сне."),
        ("Говорили о «работе»", "Говорили о «работе»"),  # кавычки внутри не трогаем
        ("We talked about work.", None),
        ("   ", None),
    ],
)
def test_answer_is_cleaned_for_the_field(answer: str, expected: str | None) -> None:
    assert clean_recap(answer) == expected


def test_a_long_answer_is_cut_at_a_sentence_or_a_word() -> None:
    sentences = "Говорили о работе и о том, как трудно. " * 10
    cut = clean_recap(sentences)
    assert cut is not None and len(cut) <= RECAP_MAX_CHARS and cut.endswith(".")

    one_sentence = "Говорили о " + "работе и доме " * 40
    cut = clean_recap(one_sentence)
    assert cut is not None and len(cut) <= RECAP_MAX_CHARS + 1 and cut.endswith("…") and not cut.endswith(" …")


async def test_make_recap_asks_the_model_and_cleans_the_answer() -> None:
    model = FakeRecap("«Говорили о ссоре с сестрой.»")
    talk = dialog(("user", LONG_ENOUGH))
    assert await make_recap(model, talk) == "Говорили о ссоре с сестрой."
    [messages] = model.calls
    assert LONG_ENOUGH in messages[1]["content"]


async def test_make_recap_never_raises() -> None:
    talk = dialog(("user", LONG_ENOUGH))
    assert await make_recap(None, talk) is None
    assert await make_recap(FakeRecap(error=MemoryModelError("model")), talk) is None
    assert await make_recap(FakeRecap(error=MemoryModelError("timeout")), talk) is None
    # кризис и «Без памяти» до модели не доходят
    model = FakeRecap()
    assert await make_recap(model, dialog(("user", LONG_ENOUGH), crisis=True)) is None
    assert await make_recap(model, dialog(("user", LONG_ENOUGH), memory_mode="off")) is None
    assert model.calls == []


async def test_a_slow_model_gives_no_recap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(recap_module, "RECAP_TIMEOUT_SECONDS", 0.05)
    model = FakeRecap()
    model.delay = 1.0
    assert await make_recap(model, dialog(("user", LONG_ENOUGH))) is None


def test_recap_model_stays_in_russia_like_memory() -> None:
    llm = LlmSettings(LLM_BASE_URL="https://proxy.example/v1", AGENT_API_TOKEN="key")
    model = build_recap_llm(memory_settings(), llm)
    assert model is not None and model.name.startswith("proxy:")
    gemini = memory_settings(MEMORY_LLM_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai")
    assert build_recap_llm(gemini, llm) is None
    assert build_recap_llm(memory_settings(), LlmSettings(LLM_BASE_URL="https://proxy.example/v1")) is None


@pytest.fixture
def recap_model() -> FakeRecap:
    return FakeRecap()


@pytest.fixture
def recap_client(recap_model: FakeRecap) -> Iterator[TestClient]:
    with TestClient(create_app(lambda: None, lambda: (None, None), recap_model_factory=lambda: recap_model)) as c:
        yield c


def say(client: TestClient, user_id: str, dialog_id: str, text: str) -> None:
    with client.websocket_connect(ws_url(user_id, dialog_id), headers=AUTH) as ws:
        send_user_message(ws, "c-1", text)
        read_frames(ws, lambda f: has(f, "assistant_end"))


def recap_url(user_id: str, dialog_id: str) -> str:
    return f"/v1/users/{user_id}/dialogs/{dialog_id}/recap"


def test_rest_recap_returns_the_text_and_changes_nothing(recap_client: TestClient, recap_model: FakeRecap) -> None:
    user_id = str(uuid.uuid4())
    started = start_dialog(recap_client, user_id)
    say(recap_client, user_id, started["dialogId"], LONG_ENOUGH)

    response = recap_client.post(recap_url(user_id, started["dialogId"]), headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"recap": "Говорили о ссоре с сестрой. Решили написать ей вечером."}

    # разговор не завершён и итог нигде не сохранён: его сохраняет только `end`, если человек его оставил
    item: dict[str, Any] = recap_client.get(f"/v1/users/{user_id}/dialogs/{started['dialogId']}", headers=AUTH).json()
    assert item["endedAt"] is None and item["summary"] is None


def test_rest_recap_of_a_short_talk_is_null_without_calling_the_model(
    recap_client: TestClient, recap_model: FakeRecap
) -> None:
    user_id = str(uuid.uuid4())
    started = start_dialog(recap_client, user_id)
    response = recap_client.post(recap_url(user_id, started["dialogId"]), headers=AUTH)
    assert response.json() == {"recap": None}
    assert recap_model.calls == []


def test_rest_recap_needs_the_token_and_the_owner(recap_client: TestClient) -> None:
    user_id = str(uuid.uuid4())
    started = start_dialog(recap_client, user_id)
    assert recap_client.post(recap_url(user_id, started["dialogId"])).status_code == 401
    stranger = str(uuid.uuid4())
    response = recap_client.post(recap_url(stranger, started["dialogId"]), headers=AUTH)
    assert response.status_code == 404 and response.json()["error"]["code"] == "AGENT_DIALOG_NOT_FOUND"


def test_rest_recap_without_a_model_is_null(client: TestClient, user_id: str) -> None:
    started = start_dialog(client, user_id)
    say(client, user_id, started["dialogId"], LONG_ENOUGH)
    assert client.post(recap_url(user_id, started["dialogId"]), headers=AUTH).json() == {"recap": None}
