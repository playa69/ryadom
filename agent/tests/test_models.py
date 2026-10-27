"""HTTP-клиент текстовой модели против поддельного прокси (httpx.MockTransport): запрос, разбор ответа, отказы."""

import json

import httpx
import pytest

from app.clients.llm import ModelError, ProxyChat, build_chat
from app.core.config import LlmSettings

BASE = "https://proxy.test/v1"


def chat(handler) -> ProxyChat:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ProxyChat(BASE + "/", "secret-key", "chat-model", max_tokens=100, temperature=0.5, timeout_seconds=5, client=client)


def completion(content, finish_reason="stop") -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": finish_reason}]}


async def test_chat_sends_the_dialog_and_returns_the_trimmed_answer():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = request.read()
        return httpx.Response(200, json=completion("  Я рядом.  "))

    model = chat(handler)
    assert await model.complete([{"role": "user", "content": "привет"}]) == "Я рядом."
    assert seen["url"] == "https://proxy.test/v1/chat/completions"
    assert seen["auth"] == "Bearer secret-key"
    body = json.loads(seen["body"])
    assert body["model"] == "chat-model" and body["max_tokens"] == 100 and body["temperature"] == 0.5
    assert body["messages"] == [{"role": "user", "content": "привет"}]
    assert not body.get("stream")  # ответ короткий и нужен целиком


async def test_chat_cut_by_the_token_limit_keeps_whole_sentences():
    model = chat(lambda r: httpx.Response(200, json=completion("Первое. Второе. Третье обор", "length")))
    assert await model.complete([]) == "Первое. Второе."


async def test_chat_answer_without_content_is_empty_not_an_error():
    model = chat(lambda r: httpx.Response(200, json=completion(None)))
    assert await model.complete([]) == ""


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="boom"),
        httpx.Response(401, json={"error": "bad key"}),
        httpx.Response(200, text="не json"),
        httpx.Response(200, json={"choices": []}),
        httpx.Response(200, json={"unexpected": True}),
    ],
)
async def test_chat_failures_become_model_errors(response):
    with pytest.raises(ModelError):
        await chat(lambda r: response).complete([])


async def test_chat_network_failure_becomes_a_model_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("нет связи", request=request)

    with pytest.raises(ModelError):
        await chat(handler).complete([])


def test_without_a_key_or_an_address_there_is_no_model():
    """Нет ключа прокси или его адреса — модели нет (итоги и заметки откладываются), сервис при этом стартует."""
    assert build_chat(LlmSettings()) is None
    assert build_chat(LlmSettings(LLM_BASE_URL="https://proxy.test/v1")) is None
    assert build_chat(LlmSettings(AGENT_API_TOKEN="k")) is None


def test_a_configured_model_gets_its_name_timeout_and_limits_from_the_settings():
    model = build_chat(LlmSettings(LLM_BASE_URL="https://proxy.test/v1", AGENT_API_TOKEN="k"))
    assert model.name == "proxy:gigachat3.5-432b-a28b"
    assert model._max_tokens == 200 and model._temperature == 0.7


async def test_the_client_keeps_idle_connections_longer_than_httpx_does_by_default():
    # Фоновые запросы идут не подряд, но соединение с прокси живо между ними: с умолчанием в 5 с каждый начинался бы с TCP+TLS.
    model = ProxyChat("https://p/v1", "k", "m", 200, 0.7, 15)
    assert model._client._transport._pool._keepalive_expiry == 60
    await model.aclose()
